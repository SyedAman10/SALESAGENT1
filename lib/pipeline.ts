import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { sendViaGmail } from './gmail';
import { getEffectiveDailyLimit } from './warmup';
import fs from 'fs';
import path from 'path';
import { sql } from './db';
import { config } from './config';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── INGEST ────────────────────────────────────────────────────────────────────

type RawLead = { name: string; email: string; company?: string; linkedin_url?: string; raw_data: object; source?: string };

export async function ingestLeads(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; sources: Record<string, number> }> {
  const portfolio = loadPortfolio(targetDomains);

  const domainSpecificPromises = portfolio.map(async asset => {
    const analysis = await getDomainAnalysis(asset.domain);
    if (!analysis) return [] as RawLead[];
    return scrapeAllMarketSources(asset, analysis);
  });

  const results = await Promise.allSettled([
    fetchApolloByTitle(),        // generic domain brokers/advisors
    fetchApolloByCompany(),      // domain industry companies
    scrapeNameprosProfiles(),    // general forum scraping
    ...domainSpecificPromises,   // per-domain: end-user buyers + market sources
  ]);

  const raw: RawLead[] = [];
  const seen = new Set<string>();
  const sources: Record<string, number> = {};

  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const lead of r.value) {
        if (!lead.email?.includes('@') || seen.has(lead.email)) continue;
        seen.add(lead.email);
        raw.push(lead);
        sources[lead.source ?? 'unknown'] = (sources[lead.source ?? 'unknown'] ?? 0) + 1;
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(raw);
  return { inserted, skipped, sources };
}

interface SearchQuery { titles: string[]; keywords: string; seniority: string[]; }

async function generateSearchQueries(asset: Asset, analysis: DomainAnalysis): Promise<SearchQuery[]> {
  const VALID_SENIORITY = new Set(['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior']);
  try {
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `You are a B2B sales targeting expert. Generate Apollo.io search queries to find potential END-USER buyers for this domain.

Domain: ${asset.domain} ($${asset.asking_price.toLocaleString()})
Buyer profile: ${analysis.buyer_profile_summary}
Industries: ${analysis.industries.join(', ')}
Ideal buyer types: ${analysis.ideal_buyer_types.join(', ')}
Use cases: ${analysis.use_cases.join(', ')}

Generate 5 distinct, specific Apollo search queries. Each should target a DIFFERENT buyer profile.
Target people who would BUILD their business on this domain — NOT domain investors or brokers.
Focus on: founders, C-suite, brand/marketing leaders in the relevant industries.

Apollo seniority values (use only these): owner, founder, c_suite, partner, vp, head, director, manager, senior

Return JSON array only:
[{"titles": ["Founder", "CEO"], "keywords": "specific niche keyword phrase", "seniority": ["founder", "c_suite"]}]
Return valid JSON only.`,
      }],
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '[]';
    const queries = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as SearchQuery[];
    return queries.map(q => ({
      ...q,
      seniority: q.seniority.filter(s => VALID_SENIORITY.has(s)),
    }));
  } catch {
    // Fallback: derive basic queries from analysis fields directly
    return analysis.industries.slice(0, 3).map(industry => ({
      titles: ['Founder', 'CEO', 'Co-Founder', 'CMO', 'Head of Brand'],
      keywords: industry,
      seniority: ['founder', 'c_suite', 'vp'],
    }));
  }
}

async function fetchDomainSpecificLeads(asset: Asset, analysis: DomainAnalysis): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  const leads: RawLead[] = [];
  const queries = await generateSearchQueries(asset, analysis);

  // Title-based searches (Claude-generated, end-user buyer profiles)
  for (const query of queries) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        {
          person_titles: query.titles,
          person_seniority: query.seniority.length ? query.seniority : undefined,
          q_keywords: query.keywords || undefined,
          per_page: 25,
          page: 1,
        },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const people: ApolloPersonResult[] = res.data?.people ?? [];
      const withEmail = people.filter(p => p.email?.includes('@'));
      const toReveal = people.filter(p => p.has_email && !p.email);
      for (const p of withEmail) {
        leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${asset.domain}-buyer`, raw_data: p });
      }
      if (toReveal.length > 0) {
        const revealed = await revealEmails(toReveal);
        leads.push(...revealed.map(p => ({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${asset.domain}-buyer`, raw_data: p })));
      }
    } catch { /* continue */ }
    await sleep(400);
  }

  // Buyer-type searches — use ideal_buyer_types as q_keywords + owner/founder titles
  // Much more targeted than industry-only: "wellness fitness club founder" vs "wellness"
  const endUserBuyerTypes = analysis.ideal_buyer_types.filter(t =>
    !t.toLowerCase().includes('domain investor') && !t.toLowerCase().includes('broker') && !t.toLowerCase().includes('resale')
  ).slice(0, 4);
  for (const buyerType of endUserBuyerTypes) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        {
          person_titles: ['Founder', 'Co-Founder', 'Owner', 'CEO', 'President'],
          q_keywords: buyerType,
          organization_num_employees_ranges: ['1,10', '11,50'],
          per_page: 20,
          page: 1,
        },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const people: ApolloPersonResult[] = res.data?.people ?? [];
      const withEmail = people.filter(p => p.email?.includes('@'));
      const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 6);
      const revealed = toReveal.length ? await revealEmails(toReveal) : [];
      for (const p of [...withEmail, ...revealed].filter(p => p.email)) {
        leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${asset.domain}-industry`, raw_data: { buyerType, title: p.title, companyDomain: p.organization?.primary_domain } });
      }
    } catch { /* continue */ }
    await sleep(400);
  }

  return leads;
}

// ── MARKET SCRAPERS (domain-specific) ────────────────────────────────────────

// Master coordinator: runs all market sources for a single domain in parallel
async function scrapeAllMarketSources(asset: Asset, analysis: DomainAnalysis): Promise<RawLead[]> {
  const results = await Promise.allSettled([
    fetchDomainSpecificLeads(asset, analysis),     // Apollo: targeted end-user buyers + buyer-type searches
    scrapeNameprosWanted(analysis),                // Namepros "Buy" section: explicit intent
    scrapeGoDaddyAuctions(asset, analysis),        // GoDaddy Auctions: active domain buyers
    scrapeAfternicSedo(asset, analysis),           // Afternic/Sedo: similar domain sellers → Apollo
    scrapeGoogleMapsLeads(analysis),               // Google Maps businesses → Apollo domain reverse lookup
  ]);
  const leads: RawLead[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') leads.push(...r.value);
  }
  return leads;
}

// Namepros "Buy Domains" section — people posting what they WANT to buy (highest intent)
async function scrapeNameprosWanted(analysis: DomainAnalysis): Promise<RawLead[]> {
  const leads: RawLead[] = [];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipDomains = ['namepros.com', 'example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org'];

  try {
    const res = await axios.get('https://www.namepros.com/forums/buy-domains.141/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
      timeout: 10000,
    });
    const $ = cheerio.load(res.data as string);

    // Extract thread titles + URLs, filter for relevance to our domain
    const relevantKws = [...analysis.industries, ...analysis.use_cases, ...analysis.ideal_buyer_types]
      .flatMap(k => k.toLowerCase().split(/[\s,]+/))
      .filter(k => k.length > 3);

    const threads: { title: string; url: string }[] = [];
    $('a.title, .structItem-title a, h3 a').each((_, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      if (!title || !href) return;
      const isRelevant = relevantKws.some(kw => title.toLowerCase().includes(kw));
      if (isRelevant) {
        threads.push({ title, url: href.startsWith('http') ? href : `https://www.namepros.com${href}` });
      }
    });

    // Visit up to 3 relevant threads and extract contact info
    for (const thread of threads.slice(0, 3)) {
      try {
        const tRes = await axios.get(thread.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          timeout: 8000,
        });
        const t$ = cheerio.load(tRes.data as string);
        const authorName = t$('.username, .p-name, .p-title-value').first().text().trim();
        const pageText = t$.text();
        const emails = (pageText.match(emailRegex) ?? []).filter(e => !skipDomains.some(d => e.includes(d)));

        for (const email of [...new Set(emails)]) {
          leads.push({ name: authorName || email.split('@')[0], email, source: 'namepros:wanted', raw_data: { title: thread.title, url: thread.url } });
        }

        // If no email visible, try their member profile page
        if (!emails.length) {
          const profileHref = t$('a.username, a.p-name').first().attr('href');
          if (profileHref) {
            const profileUrl = profileHref.startsWith('http') ? profileHref : `https://www.namepros.com${profileHref}`;
            try {
              const pRes = await axios.get(profileUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
                timeout: 6000,
              });
              const p$ = cheerio.load(pRes.data as string);
              const profileText = p$.text();
              const profileEmails = (profileText.match(emailRegex) ?? []).filter(e => !skipDomains.some(d => e.includes(d)));
              const website = p$('a[href*="://"]').not('[href*="namepros"]').first().attr('href') ?? '';
              for (const email of [...new Set(profileEmails)]) {
                leads.push({ name: authorName || email.split('@')[0], email, source: 'namepros:wanted', raw_data: { title: thread.title, profile: profileUrl, website } });
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
      await sleep(600);
    }
  } catch { /* skip */ }
  return leads;
}

// Afternic — scrape similar domain listings, reverse-lookup via Apollo
// GoDaddy Auctions removed: hard 403 even with Apify proxy
async function scrapeGoDaddyAuctions(asset: Asset, analysis: DomainAnalysis): Promise<RawLead[]> {
  const keywords = [asset.domain.split('.')[0], ...analysis.industries.slice(0, 1)].filter(Boolean);
  const discoveredDomains: string[] = [];

  // Direct HTTP — Afternic (simpler than GoDaddy, sometimes server-renders listing names)
  for (const kw of keywords.slice(0, 2)) {
    try {
      const res = await axios.get(`https://www.afternic.com/forsale?q=${encodeURIComponent(kw)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' },
        timeout: 10000,
      });
      const $ = cheerio.load(res.data as string);
      const re = /^[a-z0-9][a-z0-9-]{1,30}\.(com|net|org|io|co|club|app)$/i;
      $('td, a, .domain, [class*="domain"]').each((_, el) => {
        const txt = $(el).text().trim().toLowerCase();
        if (re.test(txt)) discoveredDomains.push(txt);
      });
    } catch { /* skip */ }
    await sleep(500);
  }

  if (!discoveredDomains.length) return [];

  const leads: RawLead[] = [];
  const seen = new Set<string>();
  for (const domain of [...new Set(discoveredDomains)].slice(0, 5)) {
    const domainLeads = await apolloReverseFromDomain(domain, 'afternic:apollo');
    for (const l of domainLeads) {
      if (!seen.has(l.email)) { seen.add(l.email); leads.push(l); }
    }
    await sleep(300);
  }
  return leads;
}

// Afternic + Sedo — similar domain sellers → Apollo reverse lookup
async function scrapeAfternicSedo(asset: Asset, analysis: DomainAnalysis): Promise<RawLead[]> {
  const leads: RawLead[] = [];
  const keywords = [...analysis.industries.slice(0, 2), asset.domain.split('.')[0]];

  const targets = [
    { base: 'https://www.afternic.com/forsale', param: 'keyword' },
    { base: 'https://sedo.com/search/searchresult.php4', param: 'keyword' },
  ];

  const discoveredDomains: string[] = [];

  for (const target of targets) {
    for (const kw of keywords.slice(0, 2)) {
      try {
        const res = await axios.get(`${target.base}?${target.param}=${encodeURIComponent(kw)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          timeout: 10000,
        });
        const $ = cheerio.load(res.data as string);
        $('a, td, .domain-name, [class*="domain"]').each((_, el) => {
          const txt = $(el).text().trim().toLowerCase();
          if (/^[a-z0-9][a-z0-9-]{1,30}\.(com|net|org|io|co|club|app)$/.test(txt)) {
            discoveredDomains.push(txt);
          }
        });
      } catch { /* skip */ }
      await sleep(600);
    }
  }

  const seen = new Set<string>();
  for (const domain of [...new Set(discoveredDomains)].slice(0, 4)) {
    const domainLeads = await apolloReverseFromDomain(domain, 'afternic:sedo');
    for (const l of domainLeads) {
      if (!seen.has(l.email)) { seen.add(l.email); leads.push(l); }
    }
    await sleep(300);
  }
  return leads;
}


// Convert a discovered auction domain → find decision-makers at that company via Apollo
// e.g. "lumisgroup.com" → search "Lumis Group" → get founders/CEOs who may be domain buyers
async function apolloReverseFromDomain(domain: string, source: string): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  const namePart = domain.replace(/\.(com|net|org|io|co|club|app|us|biz|info)$/i, '');
  const companyName = namePart.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (companyName.length < 4) return [];

  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      {
        q_organization_name: companyName,
        person_seniority: ['owner', 'founder', 'c_suite', 'partner', 'vp'],
        per_page: 10,
        page: 1,
      },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people: ApolloPersonResult[] = res.data?.people ?? [];
    const withEmail = people.filter(p => p.email?.includes('@'));
    const toReveal = people.filter(p => p.has_email && !p.email);
    const revealed = toReveal.length ? await revealEmails(toReveal) : [];

    return [...withEmail, ...revealed]
      .filter(p => p.email)
      .map(p => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        email: p.email!,
        company: p.organization?.name,
        linkedin_url: p.linkedin_url,
        source,
        raw_data: { ...p, discovered_from: domain },
      }));
  } catch (e) {
    console.error(`[apolloReverse:${domain}]`, (e as Error).message);
    return [];
  }
}

// Apollo: search by domain-related job titles — these people have corporate emails
async function fetchApolloByTitle(): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  const leads: RawLead[] = [];

  const searches = [
    { titles: ['Domain Broker', 'Domain Advisor'], keywords: '' },
    { titles: ['Domain Manager', 'Domain Portfolio Manager'], keywords: '' },
    { titles: ['Domain Investor'], keywords: '' },
    { titles: ['Director'], keywords: 'domain acquisitions' },
    { titles: ['VP', 'Head'], keywords: 'domain strategy' },
    { titles: ['Brand Strategist', 'Naming Consultant'], keywords: 'domain' },
    { titles: ['Digital Assets Manager', 'Digital Asset Specialist'], keywords: '' },
  ];

  for (const search of searches) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        {
          person_titles: search.titles,
          q_keywords: search.keywords || undefined,
          per_page: 20,
          page: 1,
        },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );

      const people: ApolloPersonResult[] = res.data?.people ?? [];
      const withEmail = people.filter(p => p.email?.includes('@'));
      const toReveal = people.filter(p => p.has_email && !p.email);

      for (const p of withEmail) {
        leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: 'apollo:title', raw_data: p });
      }

      if (toReveal.length > 0) {
        const revealed = await revealEmails(toReveal);
        leads.push(...revealed.map(p => ({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: 'apollo:title', raw_data: p })));
      }
    } catch { /* continue */ }
    await sleep(400);
  }
  return leads;
}

// Apollo: search by domain industry companies — brokerages, marketplaces
async function fetchApolloByCompany(): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  const leads: RawLead[] = [];

  const companies = [
    'Sedo', 'DAN.com', 'Afternic', 'BrandBucket', 'SquadHelp', 'NameFind',
    'MediaOptions', 'DomainAgents', 'GoDaddy Auctions',
    'Uniregistry', 'Epik', 'Flippa', 'HugeDomains', 'Namecheap',
  ];

  for (const company of companies) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        { q_organization_name: company, per_page: 10, page: 1 },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );

      const people: ApolloPersonResult[] = res.data?.people ?? [];
      const withEmail = people.filter(p => p.email?.includes('@'));
      const toReveal = people.filter(p => p.has_email && !p.email);

      for (const p of withEmail) {
        leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${company}`, raw_data: p });
      }

      if (toReveal.length > 0) {
        const revealed = await revealEmails(toReveal);
        leads.push(...revealed.map(p => ({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${company}`, raw_data: p })));
      }
    } catch { /* continue */ }
    await sleep(400);
  }
  return leads;
}

async function revealEmails(people: ApolloPersonResult[]): Promise<ApolloPersonResult[]> {
  const CHUNK = 10;
  const results: ApolloPersonResult[] = [];
  for (let i = 0; i < people.length; i += CHUNK) {
    const chunk = people.slice(i, i + CHUNK);
    try {
      // Use person ID when available — avoids obfuscated name mismatch
      const details = chunk.map(p =>
        p.id
          ? { id: p.id, reveal_personal_emails: true }
          : { first_name: p.first_name, last_name: p.last_name, organization_name: p.organization?.name, linkedin_url: p.linkedin_url, reveal_personal_emails: true }
      );
      const res = await axios.post(
        'https://api.apollo.io/api/v1/people/bulk_match',
        { reveal_personal_emails: true, details },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const matched: ApolloPersonResult[] = res.data?.matches ?? res.data?.people ?? [];
      results.push(...matched.filter(p => p.email?.includes('@')));
    } catch { /* skip */ }
    await sleep(300);
  }
  return results;
}

// Namepros direct HTTP + Google Maps business scraping via Apify
async function scrapeNameprosProfiles(): Promise<RawLead[]> {
  const directLeads = await scrapeForumsDirect().catch(() => [] as RawLead[]);
  return directLeads;
}

// Scrape Google Maps for relevant businesses, then Apollo reverse-lookup their domains
// Much more effective than Namepros scraping (no public emails there)
export async function scrapeGoogleMapsLeads(analysis: DomainAnalysis): Promise<RawLead[]> {
  if (!config.apifyApiKey) return [];

  const searchTerms = [
    ...analysis.industries.slice(0, 2),
    ...analysis.ideal_buyer_types
      .filter(t => !t.toLowerCase().includes('domain') && !t.toLowerCase().includes('broker'))
      .slice(0, 2),
  ].filter(Boolean);

  if (searchTerms.length === 0) return [];

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~google-maps-scraper/runs?token=${config.apifyApiKey}`,
      {
        searchStringsArray: searchTerms.slice(0, 4),
        maxCrawledPlaces: 40,
        language: 'en',
        countryCode: 'us',
        maxImages: 0,
        exportPlaceUrls: false,
        additionalInfo: false,
      },
      { timeout: 20000 }
    );

    const runId: string = runRes.data?.data?.id;
    if (!runId) return [];

    for (let i = 0; i < 48; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') {
        console.error('[Apify GMaps] run failed:', status);
        return [];
      }
    }

    const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    const items = itemsRes.data as { website?: string; title?: string }[];
    const websites = items
      .filter(i => i.website)
      .map(i => i.website!.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase())
      .filter(d => d.includes('.') && !d.includes('facebook') && !d.includes('yelp') && !d.includes('google'));

    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (const domain of [...new Set(websites)].slice(0, 20)) {
      const domainLeads = await apolloReverseFromDomainUrl(domain, 'apify:googlemaps');
      for (const l of domainLeads) {
        if (!seen.has(l.email)) { seen.add(l.email); leads.push(l); }
      }
      await sleep(400);
    }
    return leads;
  } catch (err) {
    console.error('[Apify GMaps]', (err as Error).message);
    return [];
  }
}

// Apollo reverse lookup using organization_domains (more precise than name-based lookup)
async function apolloReverseFromDomainUrl(domain: string, source: string): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      {
        organization_domains: [domain],
        person_seniority: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
        per_page: 10,
      },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people: ApolloPersonResult[] = res.data?.people ?? [];
    const withEmail = people.filter(p => p.email?.includes('@'));
    const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 5);
    const revealed = toReveal.length ? await revealEmails(toReveal) : [];
    return [...withEmail, ...revealed].filter(p => p.email).map(p => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      email: p.email!,
      company: p.organization?.name,
      linkedin_url: p.linkedin_url,
      source,
      raw_data: { ...p, discovered_from: domain },
    }));
  } catch { return []; }
}

// Direct HTTP scrape — no Apify dependency, runs in parallel
async function scrapeForumsDirect(): Promise<RawLead[]> {
  const leads: RawLead[] = [];
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipDomains = ['namepros.com', 'example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org', 'schema.org'];

  const targets = [
    { url: 'https://www.namepros.com/forums/domains-for-sale.26/', source: 'namepros:direct' },
    { url: 'https://dnforum.com/forums/domain-names-for-sale.6/', source: 'dnforum:direct' },
  ];

  for (const target of targets) {
    try {
      const res = await axios.get(target.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        timeout: 10000,
      });
      const $ = cheerio.load(res.data as string);

      const found = ($.text().match(emailRegex) ?? []).filter(e => !skipDomains.some(d => e.includes(d)));
      for (const email of [...new Set(found)]) {
        leads.push({ name: email.split('@')[0], email, source: target.source, raw_data: { email, url: target.url } });
      }

      // Collect member profile URLs from thread starters
      const profileUrls: string[] = [];
      $('a[href*="/members/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && !href.includes('?')) {
          profileUrls.push(href.startsWith('http') ? href : `https://www.namepros.com${href}`);
        }
      });

      // Visit up to 10 profiles to find contact emails
      for (const profileUrl of [...new Set(profileUrls)].slice(0, 10)) {
        try {
          const pRes = await axios.get(profileUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
            timeout: 8000,
          });
          const p$ = cheerio.load(pRes.data as string);
          const name = p$('h1.username, .p-title-value').first().text().trim();
          const about = p$('.memberAbout, .p-body-pageContent').text();
          const profileEmails = (about.match(emailRegex) ?? []).filter(e => !skipDomains.some(d => e.includes(d)));
          for (const email of profileEmails) {
            leads.push({ name: name || email.split('@')[0], email, source: target.source, raw_data: { name, email, url: profileUrl } });
          }
        } catch { /* skip */ }
        await sleep(500);
      }
    } catch { /* skip */ }
    await sleep(1000);
  }
  return leads;
}

interface ApolloPersonResult {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  has_email?: boolean;
  linkedin_url?: string;
  organization?: { name?: string; primary_domain?: string };
  [key: string]: unknown;
}

// Companies that match Apollo title searches but are NOT domain investors
const CORPORATE_BLOCKLIST = [
  'bank', 'financial', 'insurance', 'automotive', 'siemens', 'renault', 'volkswagen',
  'sligro', 'food group', 'pharma', 'hospital', 'university', 'government', 'ministry',
  'telecom', 'airline', 'retail', 'supermarket', 'logistics', 'consulting',
];

function isCorporateNonDomainLead(company?: string): boolean {
  if (!company) return false;
  const lower = company.toLowerCase();
  return CORPORATE_BLOCKLIST.some(term => lower.includes(term));
}

async function upsertLeads(leads: (RawLead & { source?: string })[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0; let skipped = 0;
  for (const l of leads) {
    if (isCorporateNonDomainLead(l.company)) { skipped++; continue; }
    const rows = await sql`
      INSERT INTO leads (name, email, company, linkedin_url, source, raw_data, status)
      VALUES (${l.name}, ${l.email}, ${l.company ?? null}, ${l.linkedin_url ?? null}, ${(l as RawLead & { source?: string }).source ?? 'scrape'}, ${JSON.stringify(l.raw_data)}, 'new')
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    rows.length > 0 ? inserted++ : skipped++;
  }
  return { inserted, skipped };
}

// ── HOT LEADS — active buyers on domain forums ────────────────────────────────
// These are the highest-intent leads: people who have explicitly posted that they
// want to buy a domain RIGHT NOW, with a stated budget and use case.
// Sources: Namepros WTB board, DNForum requests, Reddit r/domainnames
// Strategy: scrape thread titles → filter for keyword relevance → open thread →
//           extract any visible email → fallback: Apollo search by poster name

export async function findHotLeads(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; sources: Record<string, number>; threads: number; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const sources: Record<string, number> = {};
  const errors: Record<string, string> = {};

  if (!config.apolloApiKey) {
    return { inserted: 0, skipped: 0, sources, threads: 0, errors: { apollo: 'No Apollo key configured' } };
  }

  function addLeads(leads: RawLead[]) {
    for (const l of leads) {
      if (l.email && !seen.has(l.email)) {
        seen.add(l.email);
        allLeads.push(l);
        sources[l.source ?? 'unknown'] = (sources[l.source ?? 'unknown'] ?? 0) + 1;
      }
    }
  }

  // ── Source 1: Apollo domain broker/investor title search ──────────────────
  const brokerResult = await apolloBrokerSearch();
  if (brokerResult.error) errors['apollo:broker'] = brokerResult.error;
  addLeads(brokerResult.leads);

  // ── Source 2: Apollo brand keyword match (WHOIS-equivalent) ──────────────
  // Finds founders at companies whose brand name matches our domain keyword
  // e.g. indikaclub.com → finds founders at "Indika*" companies → they want the .com
  const brandResult = await apolloBrandKeywordSearch(portfolio);
  if (brandResult.error) errors['apollo:brand'] = brandResult.error;
  addLeads(brandResult.leads);

  // ── Source 3: Flippa similar domain listings via Apify → Apollo reverse ──
  // Finds domains in same niche on Flippa → who owns those → founder emails
  if (config.apifyApiKey) {
    const flippaResult = await scrapeFlippaViaApify(portfolio);
    if (flippaResult.error) errors['flippa'] = flippaResult.error;
    addLeads(flippaResult.leads);
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, sources, threads: 0, errors };
}

async function scrapeNameprosRSS(kwSet: Set<string>): Promise<{ leads: RawLead[]; threads: number; error?: string }> {
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipHosts = ['namepros.com', 'example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org'];
  const kwArr = [...kwSet];
  const leads: RawLead[] = [];
  let threads = 0;

  const feeds = [
    'https://www.namepros.com/forums/buy-domains.141/index.rss',
    'https://www.namepros.com/forums/domain-marketplace.84/index.rss',
  ];

  for (const feedUrl of feeds) {
    try {
      const res = await axios.get(feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.namepros.com/',
          'Cache-Control': 'no-cache',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(res.data as string, { xmlMode: true });
      $('item').each((_, el) => {
        const title = $(el).find('title').text();
        const desc = $(el).find('description').text();
        const link = $(el).find('link').text().trim();
        const author = $(el).find('dc\\:creator, creator').text().trim();

        const isWTB = /\b(wtb|want\s+to\s+buy|buying|looking\s+for|need|seeking|purchase)\b/i.test(title);
        const matchesKw = kwArr.some(kw => title.toLowerCase().includes(kw) || desc.toLowerCase().includes(kw));
        if (!isWTB && !matchesKw) return;

        threads++;
        const text = `${title} ${desc}`;
        const emails = [...new Set((text.match(emailRe) ?? []).filter(e => !skipHosts.some(d => e.includes(d))))];
        for (const email of emails) {
          leads.push({
            name: author || email.split('@')[0],
            email,
            source: 'namepros:wtb',
            raw_data: { title, url: link, author },
          });
        }
      });
    } catch (e) {
      return { leads, threads, error: `${feedUrl.includes('buy-domains') ? 'buy-domains' : 'marketplace'}: ${(e as Error).message}` };
    }
    await sleep(500);
  }

  return { leads, threads };
}

async function scrapeRedditRSS(kwSet: Set<string>): Promise<{ leads: RawLead[]; threads: number; error?: string }> {
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipHosts = ['reddit.com', 'redd.it', 'example.com', 'google.com', 'imgur.com'];
  const leads: RawLead[] = [];
  const errors: string[] = [];
  let threads = 0;

  const searches = [
    { sub: 'domainnames', query: 'WTB domain' },
    { sub: 'domainnames', query: 'buying domain' },
    { sub: 'Entrepreneur', query: 'domain name buy' },
  ];

  for (const { sub, query } of searches) {
    try {
      const res = await axios.get(
        `https://old.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent(query)}&sort=new&restrict_sr=on&t=month`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 15000,
        }
      );

      const $ = cheerio.load(res.data as string, { xmlMode: true });
      $('item, entry').each((_, el) => {
        const title = $(el).find('title').text();
        const content = $(el).find('content\\:encoded, content, summary').text();
        const link = $(el).find('link').text().trim() || $(el).find('link').attr('href') || '';
        const author = $(el).find('author name, dc\\:creator').text().trim();

        const isWTB = /\b(wtb|want\s+to\s+buy|buying|looking\s+for|need|seeking)\b/i.test(title);
        if (!isWTB) return;

        threads++;
        const text = `${title} ${content}`;
        const emails = [...new Set((text.match(emailRe) ?? []).filter(e => !skipHosts.some(d => e.includes(d))))];
        for (const email of emails) {
          leads.push({
            name: author || email.split('@')[0],
            email,
            source: `reddit:${sub}`,
            raw_data: { title, url: link, author, subreddit: sub },
          });
        }
      });
    } catch (e) {
      errors.push(`reddit/${sub}: ${(e as Error).message}`);
    }
    await sleep(800);
  }

  return { leads, threads, error: errors.length ? errors.join('; ') : undefined };
}

async function apolloBrokerSearch(): Promise<{ leads: RawLead[]; error?: string }> {
  if (!config.apolloApiKey) return { leads: [], error: 'No Apollo key' };

  const searches: Array<{ titles: string[]; source: string }> = [
    { titles: ['Domain Broker', 'Domain Investor', 'Domain Advisor', 'Domain Consultant', 'Domain Trader'], source: 'apollo:broker' },
    { titles: ['Domain Acquisition Specialist', 'Domain Portfolio Manager', 'Domain Sales Manager', 'Domain Flipper'], source: 'apollo:acquisition' },
    { titles: ['Brand Acquisition Manager', 'Digital Asset Broker', 'Online Asset Broker', 'Internet Business Broker'], source: 'apollo:digital-assets' },
  ];

  const leads: RawLead[] = [];
  const errors: string[] = [];

  for (const { titles, source } of searches) {
    for (const page of [1, 2]) {
      try {
        const res = await axios.post(
          'https://api.apollo.io/api/v1/mixed_people/api_search',
          { person_titles: titles, person_seniority: ['owner', 'founder', 'c_suite', 'partner', 'vp'], per_page: 25, page },
          { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
        );
        const people: ApolloPersonResult[] = res.data?.people ?? [];
        if (!people.length) break;

        const toReveal = people.filter(p => p.has_email && !p.email?.includes('@')).slice(0, 10);
        const revealed = toReveal.length ? await revealEmails(toReveal) : [];
        const withEmail = people.filter(p => p.email?.includes('@'));
        for (const p of [...withEmail, ...revealed].filter(p => p.email)) {
          leads.push({
            name: [p.first_name, p.last_name].filter(Boolean).join(' '),
            email: p.email!,
            company: p.organization?.name,
            linkedin_url: p.linkedin_url,
            source,
            raw_data: { title: p.title, via: 'apollo-broker-search', page },
          });
        }
      } catch (e) {
        errors.push(`${source} p${page}: ${(e as Error).message}`);
        break;
      }
      await sleep(400);
    }
  }

  return { leads, error: errors.length ? errors.join('; ') : undefined };
}

// Find founders at companies whose brand name matches our domain keyword
// Equivalent to WHOIS registrant lookup — these people are building something with our keyword
async function apolloBrandKeywordSearch(portfolio: Asset[]): Promise<{ leads: RawLead[]; error?: string }> {
  if (!config.apolloApiKey) return { leads: [], error: 'No Apollo key' };
  const leads: RawLead[] = [];
  const errors: string[] = [];

  for (const asset of portfolio) {
    const root = asset.domain.split('.')[0]; // "indikaclub" or "primecrafters"
    // Extract shorter brand prefix for compound words: "indikaclub" → "indika"
    const keywords = new Set<string>([root]);
    const prefix = root.match(/^([a-z]{4,9})/)?.[1];
    if (prefix && prefix !== root) keywords.add(prefix);

    for (const kw of keywords) {
      try {
        const res = await axios.post(
          'https://api.apollo.io/api/v1/mixed_people/api_search',
          { q_keywords: kw, person_seniority: ['owner', 'founder', 'c_suite'], per_page: 20, page: 1 },
          { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
        );
        const people: ApolloPersonResult[] = res.data?.people ?? [];
        // Only keep people whose company actually contains the keyword — avoids false positives
        const relevant = people.filter(p =>
          p.organization?.name?.toLowerCase().includes(kw) ||
          p.organization?.primary_domain?.toLowerCase().includes(kw)
        );
        const toReveal = relevant.filter(p => p.has_email && !p.email?.includes('@')).slice(0, 8);
        const revealed = toReveal.length ? await revealEmails(toReveal) : [];
        for (const p of [...relevant.filter(p => p.email?.includes('@')), ...revealed].filter(p => p.email)) {
          leads.push({
            name: [p.first_name, p.last_name].filter(Boolean).join(' '),
            email: p.email!,
            company: p.organization?.name,
            linkedin_url: p.linkedin_url,
            source: 'apollo:brand-match',
            raw_data: { keyword: kw, targetDomain: asset.domain, title: p.title, companyDomain: p.organization?.primary_domain },
          });
        }
      } catch (e) { errors.push(`brand:${kw}: ${(e as Error).message}`); }
      await sleep(400);
    }
  }

  return { leads, error: errors.length ? errors.join('; ') : undefined };
}

// Scrape Flippa domain listings in our niche → Apollo reverse lookup on found domains
async function scrapeFlippaViaApify(portfolio: Asset[]): Promise<{ leads: RawLead[]; error?: string }> {
  if (!config.apifyApiKey) return { leads: [], error: 'No Apify key' };

  const keywords = portfolio.map(a => a.domain.split('.')[0]).filter(Boolean).slice(0, 3);
  const startUrls = keywords.map(kw => ({
    url: `https://flippa.com/search?type=domain&search_template%5Bkeywords%5D=${encodeURIComponent(kw)}`,
    userData: { keyword: kw },
  }));

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~playwright-scraper/runs?token=${config.apifyApiKey}`,
      {
        startUrls,
        pageFunction: `async function pageFunction({ page, request }) {
          const kw = ((request.userData) || {}).keyword || '';
          await page.waitForTimeout(6000);
          const domainRe = /\\b([a-z0-9][a-z0-9-]{1,50}\\.(com|net|org|io|co|club|app))\\b/gi;
          const skip = ['flippa.com','google.com','cloudflare.com','example.com','twitter.com','facebook.com','linkedin.com'];
          const text = await page.evaluate(() => document.body ? document.body.innerText : '');
          const found = [...new Set((text.match(domainRe) || []).map(d => d.toLowerCase()))]
            .filter(d => !skip.some(s => d.includes(s)));
          return found.slice(0, 15).map(domain => ({ domain, keyword: kw }));
        }`,
        proxyConfiguration: { useApifyProxy: false },
        navigationTimeoutSecs: 30,
        maxRequestsPerCrawl: startUrls.length,
        maxConcurrency: 2,
      },
      { timeout: 15000 }
    );

    const runId: string = runRes.data?.data?.id;
    if (!runId) return { leads: [], error: 'Apify run failed to start' };

    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') break;
    }

    const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    const items = itemsRes.data as { domain: string; keyword: string }[];

    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (const item of items.slice(0, 20)) {
      if (seen.has(item.domain)) continue;
      seen.add(item.domain);
      const domainLeads = await apolloReverseFromDomain(item.domain, 'flippa:apollo');
      leads.push(...domainLeads);
      await sleep(300);
    }
    return { leads };
  } catch (e) {
    return { leads: [], error: (e as Error).message };
  }
}

// Scrape Namepros WTB board via Apify playwright — handles Cloudflare + XenForo JS rendering
async function scrapeNameprosViaApify(kwSet: Set<string>): Promise<{ leads: RawLead[]; threads: number; error?: string }> {
  const kwList = [...kwSet].slice(0, 10).join('|');
  const skipEmails = ['namepros.com', 'example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org'];

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~playwright-scraper/runs?token=${config.apifyApiKey}`,
      {
        startUrls: [{ url: 'https://www.namepros.com/forums/buy-domains.141/', label: 'BOARD' }],
        pageFunction: `async function pageFunction({ page, request, enqueueLinks, log }) {
          const emailRe = /[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g;
          const skipHosts = ${JSON.stringify(skipEmails)};
          const kwRe = new RegExp('(wtb|want|buy|buying|looking|need|seeking|${kwList})', 'i');

          if (request.label === 'BOARD') {
            await page.waitForTimeout(5000);
            const threads = await page.evaluate(() => {
              const out = [];
              document.querySelectorAll('.structItem--thread, .discussionListItem').forEach(el => {
                const a = el.querySelector('.structItem-title a:not(.labelLink), h3 a, .title a');
                const u = el.querySelector('.username, .author');
                if (a && a.href) out.push({ title: a.textContent.trim(), url: a.href, poster: u ? u.textContent.trim() : '' });
              });
              return out;
            });
            log.info('Board threads found: ' + threads.length);
            const relevant = threads.filter(t => kwRe.test(t.title)).slice(0, 12);
            if (relevant.length > 0) {
              await enqueueLinks({ urls: relevant.map(t => t.url), transformRequestFunction: r => ({ ...r, label: 'THREAD', userData: { title: relevant.find(t => t.url === r.url)?.title, poster: relevant.find(t => t.url === r.url)?.poster } }) });
            }
            return relevant.map(t => ({ type: 'thread_queued', ...t }));
          }

          if (request.label === 'THREAD') {
            await page.waitForTimeout(3000);
            const text = await page.evaluate(() => document.body ? document.body.innerText : '');
            const poster = request.userData?.poster || await page.evaluate(() => (document.querySelector('.message-name .username, .p-title-value') || {}).textContent?.trim() || '');
            const title = request.userData?.title || await page.evaluate(() => (document.querySelector('h1.p-title-value') || {}).textContent?.trim() || '');
            const emails = [...new Set((text.match(emailRe) || []).filter(e => !skipHosts.some(d => e.includes(d))))];
            return emails.map(email => ({ type: 'lead', email, poster, title, url: request.url }));
          }
          return [];
        }`,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        navigationTimeoutSecs: 60,
        maxRequestRetries: 2,
        maxRequestsPerCrawl: 15,
        maxConcurrency: 2,
      },
      { timeout: 20000 }
    );

    const runId: string = runRes.data?.data?.id;
    if (!runId) return { leads: [], threads: 0, error: 'Apify run failed to start' };

    // Poll up to 8 minutes
    for (let i = 0; i < 96; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') break;
    }

    const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    const items = itemsRes.data as { type?: string; email?: string; poster?: string; title?: string; url?: string }[];

    const threadCount = items.filter(i => i.type === 'thread_queued').length;
    const leadItems = items.filter(i => i.type === 'lead' && i.email);

    const leads: RawLead[] = leadItems.map(i => ({
      name: i.poster || i.email!.split('@')[0],
      email: i.email!,
      source: 'namepros:wtb',
      raw_data: { title: i.title, url: i.url, poster: i.poster },
    }));

    // For threads with no email, try Apollo name search on poster's real name
    const noEmailThreads = items.filter(i => i.type === 'thread_queued' && !leadItems.some(l => l.url === i.url));
    for (const thread of noEmailThreads.slice(0, 5)) {
      if (thread.poster && thread.poster.includes(' ')) {
        const apolloLeads = await apolloSearchByName(thread.poster, 'namepros:wtb', { title: thread.title, url: thread.url });
        leads.push(...apolloLeads);
      }
      await sleep(400);
    }

    return { leads, threads: threadCount };
  } catch (e) {
    return { leads: [], threads: 0, error: (e as Error).message };
  }
}


async function apolloSearchByName(fullName: string, source: string, rawData: object): Promise<RawLead[]> {
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { q_keywords: fullName, per_page: 3, page: 1 },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people: ApolloPersonResult[] = res.data?.people ?? [];
    const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 2);
    const revealed = toReveal.length ? await revealEmails(toReveal) : [];
    const withEmail = people.filter(p => p.email?.includes('@'));
    return [...withEmail, ...revealed].filter(p => p.email).map(p => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      email: p.email!,
      company: p.organization?.name,
      linkedin_url: p.linkedin_url,
      source,
      raw_data: { ...rawData, via: 'apollo-name-search' },
    }));
  } catch { return []; }
}

// Reddit JSON API — free, no auth, returns real structured data for public subreddits
async function scrapeRedditJSON(kwSet: Set<string>): Promise<{ leads: RawLead[]; error?: string }> {
  const leads: RawLead[] = [];
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipHosts = ['reddit.com', 'redd.it', 'example.com', 'google.com', 'imgur.com'];
  const errors: string[] = [];

  const searches = [
    { sub: 'domainnames', query: 'WTB domain' },
    { sub: 'domainnames', query: 'buying domain' },
    { sub: 'domainnames', query: 'looking for domain' },
    { sub: 'Entrepreneur', query: 'looking for domain name buy' },
  ];

  for (const { sub, query } of searches) {
    try {
      const res = await axios.get(
        `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=new&restrict_sr=1&t=month&limit=25`,
        {
          headers: {
            // Reddit requires a descriptive User-Agent for API access
            'User-Agent': 'domain-sales-agent/1.0 (by domain investor research tool)',
            'Accept': 'application/json',
          },
          timeout: 12000,
        }
      );

      const posts: { data: { title: string; selftext: string; author: string; url: string; permalink: string } }[]
        = res.data?.data?.children ?? [];

      for (const { data: post } of posts) {
        const titleLower = post.title.toLowerCase();
        const matchesKw = [...kwSet].some(kw => titleLower.includes(kw));
        const isWTB = /\b(wtb|want\s+to\s+buy|buying|looking\s+for|need|seeking)\b/i.test(post.title);
        if (!matchesKw && !isWTB) continue;

        const text = `${post.title} ${post.selftext}`;
        const emails = [...new Set((text.match(emailRe) ?? []).filter(e => !skipHosts.some(d => e.includes(d))))];

        for (const email of emails) {
          leads.push({
            name: post.author !== '[deleted]' ? post.author : email.split('@')[0],
            email,
            source: `reddit:${sub}`,
            raw_data: { title: post.title, url: `https://reddit.com${post.permalink}`, author: post.author, subreddit: sub },
          });
        }

        // No email but post author has a real name pattern → try Apollo
        if (!emails.length && post.author && post.author !== '[deleted]' && !post.author.startsWith('u_') && config.apolloApiKey) {
          // Reddit usernames are not real names — skip Apollo to avoid wasting credits
          console.log(`[Reddit WTB] u/${post.author}: "${post.title.slice(0, 60)}" — no email visible`);
        }
      }
    } catch (e) {
      errors.push(`reddit/${sub}: ${(e as Error).message}`);
    }
    await sleep(1000);
  }
  return { leads, error: errors.length ? errors.join('; ') : undefined };
}

// ── APIFY + APOLLO TEST ───────────────────────────────────────────────────────
// Sources (in order of reliability):
//   1. NameBio       — recent domain SALES (server-rendered HTML table). Buyers of similar domains = ideal leads.
//   2. Flippa        — domain auctions listing page (server-rendered)
//   3. Afternic      — Apify playwright scrape (JS-rendered, needs headless browser)
//   4. GoDaddy Exp   — expired domain auctions via Apify
// All discovered domain names → Apollo org domain lookup → founder/CEO emails
// Fallback: Apollo direct people search based on domain analysis

async function generateApolloTitleSearches(asset: Asset, analysis: DomainAnalysis): Promise<{ titles: string[]; label: string }[]> {
  try {
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a B2B sales expert. Generate Apollo.io job title searches for people who would BUY this domain.

Domain: ${asset.domain} ($${asset.asking_price.toLocaleString()})
Buyer summary: ${analysis.buyer_profile_summary}
Ideal buyers: ${analysis.ideal_buyer_types.filter(t => !t.toLowerCase().includes('domain')).join(', ')}

Generate 5 groups of EXACT job titles people would have on LinkedIn.
These must be REAL titles (e.g. "Gym Owner", "Fitness Studio Owner") not descriptions.
Target people who run businesses that would USE this domain — NOT domain investors.

Return JSON only:
[{"label": "gym owners", "titles": ["Gym Owner", "Fitness Studio Owner", "Health Club Owner"]}, ...]`,
      }],
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '[]';
    return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { titles: string[]; label: string }[];
  } catch {
    return [
      { label: 'founders', titles: ['Founder', 'Co-Founder', 'Owner', 'CEO'] },
      { label: 'operators', titles: ['Managing Director', 'Director', 'President', 'General Manager'] },
    ];
  }
}

export async function testNewSources(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; breakdown: Record<string, number>; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    if (!analysis) { errors[asset.domain] = 'no analysis — run Analyze first'; continue; }

    // Claude generates exact LinkedIn job titles → Apollo title search (far more reliable than q_keywords)
    const titleSearches = await generateApolloTitleSearches(asset, analysis);

    // 3 pages per title group — 3x more coverage from the same searches
    for (const search of titleSearches) {
      for (let page = 1; page <= 3; page++) {
        try {
          const res = await axios.post(
            'https://api.apollo.io/api/v1/mixed_people/api_search',
            {
              person_titles: search.titles,
              person_seniority: ['owner', 'founder', 'c_suite', 'partner', 'vp'],
              per_page: 25,
              page,
            },
            { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
          );
          const people: ApolloPersonResult[] = res.data?.people ?? [];
          if (people.length === 0) break;
          const withEmail = people.filter(p => p.email?.includes('@'));
          const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 8);
          const revealed = toReveal.length ? await revealEmails(toReveal) : [];
          const found = [...withEmail, ...revealed].filter(p => p.email);
          if (page === 1 && people.length > 0 && found.length === 0) {
            errors[`reveal:${search.label}`] = `${people.length} found, 0 emails — upgrade Apollo plan to reveal`;
          }
          for (const p of found) {
            if (!seen.has(p.email!)) {
              seen.add(p.email!);
              const src = `apollo:${asset.domain}-titles`;
              breakdown[src] = (breakdown[src] ?? 0) + 1;
              allLeads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: src, raw_data: { label: search.label, title: p.title, company: p.organization?.name } });
            }
          }
        } catch (e) { errors[`apollo:${search.label}:p${page}`] = (e as Error).message; break; }
        await sleep(500);
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, breakdown, errors };
}

async function getGoogleMapsBusinesses(analysis: DomainAnalysis): Promise<{ name?: string; website?: string; address?: string }[]> {
  if (!config.apifyApiKey) return [];
  const searchTerms = [
    ...analysis.industries.slice(0, 2),
    ...analysis.ideal_buyer_types.filter(t => !t.toLowerCase().includes('domain') && !t.toLowerCase().includes('broker')).slice(0, 2),
  ].filter(Boolean);
  if (!searchTerms.length) return [];

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~google-maps-scraper/runs?token=${config.apifyApiKey}`,
      { searchStringsArray: searchTerms.slice(0, 4), maxCrawledPlaces: 20, language: 'en', countryCode: 'us', maxImages: 0, additionalInfo: false },
      { timeout: 20000 }
    );
    const runId: string = runRes.data?.data?.id;
    if (!runId) return [];
    for (let i = 0; i < 36; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') return [];
    }
    const items = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    return (items.data as { title?: string; website?: string; address?: string }[]).map(i => ({
      name: i.title, website: i.website, address: i.address,
    }));
  } catch (err) {
    console.error('[GMaps]', (err as Error).message);
    return [];
  }
}

async function extractBusinessEmail(websiteUrl: string): Promise<string | null> {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipPrefixes = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster'];
  const skipDomains = ['example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org', 'schema.org', 'apple.com', 'wix.com', 'squarespace.com'];
  const domain = websiteUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
  const base = `https://${domain}`;
  for (const path of ['', '/contact', '/contact-us', '/about']) {
    try {
      const res = await axios.get(`${base}${path}`, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        maxRedirects: 3,
      });
      const emails = (res.data as string).match(emailRegex) ?? [];
      const valid = emails.find(e =>
        !skipDomains.some(d => e.endsWith(`@${d}`)) &&
        !skipPrefixes.some(p => e.toLowerCase().startsWith(p))
      );
      if (valid) return valid;
    } catch { continue; }
  }
  return null;
}

// Pure Apify workflow: Google Maps → contact page scraping → real business emails (no Apollo)
export async function testApifyApollo(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; sources: Record<string, number>; breakdown: Record<string, number>; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = { 'googlemaps:found': 0, 'googlemaps:with-website': 0, 'contact:emails': 0 };
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    if (!analysis) { errors[asset.domain] = 'no analysis — run Analyze first'; continue; }

    // Phase 1: Google Maps → find relevant local businesses
    const businesses = await getGoogleMapsBusinesses(analysis);
    breakdown['googlemaps:found'] += businesses.length;
    const withWebsite = businesses.filter(b => b.website);
    breakdown['googlemaps:with-website'] += withWebsite.length;

    // Phase 2: For each business website, extract contact email directly (no Apollo)
    for (const biz of withWebsite.slice(0, 25)) {
      try {
        const email = await extractBusinessEmail(biz.website!);
        if (email && !seen.has(email)) {
          seen.add(email);
          breakdown['contact:emails']++;
          allLeads.push({
            name: biz.name ?? email.split('@')[0],
            email,
            company: biz.name,
            source: 'apify:googlemaps',
            raw_data: { website: biz.website, address: biz.address, source: 'google-maps-contact' },
          });
        }
      } catch { /* skip */ }
      await sleep(600);
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  const sources: Record<string, number> = {};
  for (const l of allLeads) { const src = l.source ?? 'unknown'; sources[src] = (sources[src] ?? 0) + 1; }
  return { inserted, skipped, sources, breakdown, errors };
}

// ── UPGRADE BUYER FINDER ─────────────────────────────────────────────────────
// Finds companies already using weaker TLD variants of your domain.
// e.g. if you own indikaclub.com, finds whoever is running indikaclub.net/.co/.org
// These are the highest-intent leads — they already want this exact brand.

const PARKING_PHRASES = [
  'domain for sale', 'buy this domain', 'domain parking', 'this domain is parked',
  'sedoparking', 'hugedomains', 'afternic', 'godaddy parking', 'sedo.com',
  'dan.com', 'undeveloped.com', 'squadhelp', 'brandpa', 'register this domain',
];

async function checkDomainLive(domain: string): Promise<boolean> {
  for (const protocol of ['https', 'http']) {
    try {
      const res = await axios.get(`${protocol}://${domain}`, {
        timeout: 7000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (res.status >= 200 && res.status < 400) {
        const html = (res.data as string).toLowerCase();
        return !PARKING_PHRASES.some(p => html.includes(p));
      }
    } catch { continue; }
  }
  return false;
}

export async function findUpgradeBuyers(targetDomains?: string[]): Promise<{
  inserted: number; skipped: number; liveVariants: string[];
  breakdown: Record<string, number>; errors: Record<string, string>;
}> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const liveVariants: string[] = [];
  const breakdown: Record<string, number> = { 'checked': 0, 'live': 0, 'apollo': 0, 'contact': 0 };
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    const baseName = asset.domain.replace(/\.(com|net|org|io|co|club|app|us|biz|info)$/i, '');
    const candidates = [
      `${baseName}.net`, `${baseName}.co`, `${baseName}.org`, `${baseName}.club`,
      `${baseName}.io`, `${baseName}.app`, `${baseName}.us`, `${baseName}.biz`,
    ];
    breakdown['checked'] += candidates.length;

    for (const candidate of candidates) {
      let isLive = false;
      try { isLive = await checkDomainLive(candidate); } catch { /* skip */ }
      if (!isLive) { await sleep(300); continue; }

      breakdown['live']++;
      liveVariants.push(candidate);

      // Apollo org_domains lookup — most accurate
      try {
        const apolloLeads = await apolloReverseFromDomainUrl(candidate, 'upgrade:buyer');
        for (const l of apolloLeads) {
          if (!seen.has(l.email)) {
            seen.add(l.email);
            breakdown['apollo']++;
            allLeads.push({
              ...l,
              source: 'upgrade:buyer',
              raw_data: { ...(l.raw_data as object), upgrade_from: candidate, upgrade_to: asset.domain },
            });
          }
        }
      } catch (e) { errors[`apollo:${candidate}`] = (e as Error).message; }

      // Fallback: scrape their contact page directly
      if (!allLeads.some(l => (l.raw_data as Record<string, string>)?.upgrade_from === candidate)) {
        try {
          const email = await extractBusinessEmail(candidate);
          if (email && !seen.has(email)) {
            seen.add(email);
            breakdown['contact']++;
            allLeads.push({
              name: email.split('@')[0],
              email,
              source: 'upgrade:buyer',
              raw_data: { upgrade_from: candidate, upgrade_to: asset.domain, method: 'contact-page' },
            });
          }
        } catch (e) { errors[`contact:${candidate}`] = (e as Error).message; }
      }

      await sleep(500);
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, liveVariants, breakdown, errors };
}

// ── COMPANY NAME MATCH ────────────────────────────────────────────────────────
// Finds companies whose actual name contains the domain keywords.
// e.g. "Indika Wellness", "Indika Social Club", "Club Indika" — these businesses
// already have this brand identity and are natural buyers for the .com.

export async function findCompanyNameMatches(targetDomains?: string[]): Promise<{
  inserted: number; skipped: number;
  breakdown: Record<string, number>; errors: Record<string, string>;
}> {
  if (!config.apolloApiKey) return { inserted: 0, skipped: 0, breakdown: {}, errors: { apollo: 'No Apollo key' } };

  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    // Extract meaningful keywords from the domain name
    // e.g. "indikaclub.com" → ["indika", "club", "indika club"]
    const baseName = asset.domain.replace(/\.(com|net|org|io|co|club|app|us|biz|info)$/i, '');
    const words = baseName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase().split(' ').filter(w => w.length > 2);
    const queries = [...new Set([baseName, ...words, words.join(' ')])].filter(Boolean);

    for (const q of queries) {
      for (let page = 1; page <= 2; page++) {
        try {
          const res = await axios.post(
            'https://api.apollo.io/api/v1/mixed_people/api_search',
            {
              q_organization_name: q,
              person_seniority: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
              per_page: 25,
              page,
            },
            { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
          );
          const people: ApolloPersonResult[] = res.data?.people ?? [];
          if (people.length === 0) break;

          const withEmail = people.filter(p => p.email?.includes('@'));
          const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 8);
          const revealed = toReveal.length ? await revealEmails(toReveal) : [];
          const found = [...withEmail, ...revealed].filter(p => p.email);

          if (page === 1 && people.length > 0 && found.length === 0) {
            errors[`reveal:${q}`] = `${people.length} found, 0 emails — upgrade Apollo plan`;
          }

          for (const p of found) {
            if (!seen.has(p.email!)) {
              seen.add(p.email!);
              const src = `namematch:${asset.domain}`;
              breakdown[src] = (breakdown[src] ?? 0) + 1;
              allLeads.push({
                name: [p.first_name, p.last_name].filter(Boolean).join(' '),
                email: p.email!,
                company: p.organization?.name,
                linkedin_url: p.linkedin_url,
                source: 'namematch:buyer',
                raw_data: {
                  matched_query: q,
                  company: p.organization?.name,
                  domain_for_sale: asset.domain,
                  title: p.title,
                },
              });
            }
          }
        } catch (e) { errors[`apollo:${q}:p${page}`] = (e as Error).message; break; }
        await sleep(500);
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, breakdown, errors };
}

// ── ENRICH ────────────────────────────────────────────────────────────────────

export interface LeadEnrichment {
  domain_focus: string[];
  budget_tier: 'low' | 'mid' | 'high' | 'unknown';
  budget_range: string;
  communication_style: 'formal' | 'casual' | 'technical';
  pitch_angle: string;
  key_signals: string[];
  score: number;
  score_reasoning: string;
}

export async function enrichLeads(): Promise<{ enriched: number; skipped: number; failed: number }> {
  const leads = await sql`SELECT id, name, email, company, raw_data FROM leads WHERE enrichment IS NULL AND status = 'new'` as LeadRow[];

  let enriched = 0; let skipped = 0; let failed = 0;
  const BATCH = 5;

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async lead => {
        const rawData = JSON.parse(lead.raw_data);
        const res = await client.messages.create({
          model: config.model, max_tokens: 512,
          messages: [{ role: 'user', content: enrichPrompt(lead, rawData) }],
        });
        const text = res.content[0].type === 'text' ? res.content[0].text : '';
        const result = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as LeadEnrichment;
        return { lead, result };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { lead, result } = r.value;
        const status = result.score >= config.leadScoreThreshold ? 'enriched' : 'skipped';
        await sql`UPDATE leads SET enrichment = ${JSON.stringify(result)}, score = ${result.score}, status = ${status} WHERE id = ${lead.id}`;
        status === 'enriched' ? enriched++ : skipped++;
      } else {
        failed++;
      }
    }

    if (i + BATCH < leads.length) await sleep(200);
  }
  return { enriched, skipped, failed };
}

function enrichPrompt(lead: LeadRow, rawData: unknown) {
  return `You are analysing a domain investor lead. Extract structured intelligence.

Lead: ${lead.name}, Company: ${lead.company ?? 'unknown'}
Data: ${JSON.stringify(rawData, null, 2)}

Return JSON only:
{
  "domain_focus": ["array of domain types"],
  "budget_tier": "low|mid|high|unknown",
  "budget_range": "e.g. $1k-5k",
  "communication_style": "formal|casual|technical",
  "pitch_angle": "one sentence pitch hook",
  "key_signals": ["up to 5 signals"],
  "score": <0-100>,
  "score_reasoning": "one sentence"
}
Only use facts from the data. Return valid JSON only.`;
}

// ── DOMAIN ANALYSIS ───────────────────────────────────────────────────────────

interface Asset { domain: string; category: string; asking_price: number; description: string; }

export interface DomainAnalysis {
  ideal_buyer_types: string[];
  industries: string[];
  use_cases: string[];
  value_props: string[];
  comparable_sales: string[];
  email_hooks: string[];
  buyer_profile_summary: string;
  one_liner: string;
}

function loadPortfolio(targetDomains?: string[]): Asset[] {
  const p = path.join(process.cwd(), 'domains.json');
  const all: Asset[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
  if (!targetDomains?.length) return all;
  const fromFile = all.filter(a => targetDomains.includes(a.domain));
  const inFile = new Set(fromFile.map(a => a.domain));
  const custom = targetDomains
    .filter(d => !inFile.has(d))
    .map(d => ({ domain: d, category: 'test', asking_price: 0, description: '' }));
  return [...fromFile, ...custom];
}

export function getPortfolio(): Asset[] {
  return loadPortfolio();
}

async function getDomainAnalysis(domain: string): Promise<DomainAnalysis | null> {
  const rows = await sql`SELECT analysis FROM domain_analyses WHERE domain = ${domain}`;
  return rows[0] ? JSON.parse((rows[0] as { analysis: string }).analysis) as DomainAnalysis : null;
}

export async function analyzeDomains(targetDomains?: string[]): Promise<{ analyzed: number; skipped: number }> {
  const portfolio = loadPortfolio(targetDomains);
  let analyzed = 0; let skipped = 0;

  for (const asset of portfolio) {
    const existing = await sql`SELECT id FROM domain_analyses WHERE domain = ${asset.domain}`;
    if (existing.length) { skipped++; continue; }

    try {
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: domainAnalysisPrompt(asset) }],
      });

      const text = res.content[0].type === 'text' ? res.content[0].text : '';
      const result = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as DomainAnalysis;
      await sql`INSERT INTO domain_analyses (domain, analysis) VALUES (${asset.domain}, ${JSON.stringify(result)}) ON CONFLICT (domain) DO UPDATE SET analysis = EXCLUDED.analysis`;
      analyzed++;
    } catch { skipped++; }

    await sleep(300);
  }

  return { analyzed, skipped };
}

function domainAnalysisPrompt(asset: Asset): string {
  return `You are a domain name expert and sales strategist. Deeply analyse this domain and generate actionable sales intelligence.

Domain: ${asset.domain}
Category: ${asset.category}
Asking price: $${asset.asking_price.toLocaleString()}
Description: ${asset.description}

Think about:
- What the name sounds like, its linguistic feel, cultural associations
- What industries or niches it would appeal to
- Who would buy this domain (end user vs domain investor for resale)
- What comparable domains have sold for (use your knowledge of the domain aftermarket)
- What makes it valuable and what the compelling pitch is

Return JSON only:
{
  "ideal_buyer_types": ["e.g. domain broker for resale", "startup founder in wellness", "membership platform"],
  "industries": ["list of industries this domain fits"],
  "use_cases": ["specific use case 1", "specific use case 2"],
  "value_props": ["why this domain is valuable — brand recall, SEO, niche fit, etc."],
  "comparable_sales": ["e.g. socialclub.com $8k", "fitclub.com $5.5k — use real knowledge where possible"],
  "email_hooks": ["specific angle 1 to open a cold email with", "specific angle 2"],
  "buyer_profile_summary": "2-3 sentences describing the ideal buyer and why they'd want this",
  "one_liner": "one punchy sentence summarising the domain's value proposition"
}
Return valid JSON only.`;
}

// ── MATCH ─────────────────────────────────────────────────────────────────────

export async function matchDomains(targetDomains?: string[]): Promise<{ matched: number; unmatched: number }> {
  const portfolio = loadPortfolio(targetDomains);
  if (!portfolio.length) throw new Error('domains.json is empty');

  const leads = await sql`SELECT id, name, email, enrichment FROM leads WHERE status = 'enriched' AND id NOT IN (SELECT DISTINCT lead_id FROM lead_domain_matches)` as { id: number; name: string; email: string; enrichment: string }[];

  const analyses = new Map<string, DomainAnalysis>();
  for (const asset of portfolio) {
    const a = await getDomainAnalysis(asset.domain);
    if (a) analyses.set(asset.domain, a);
  }

  let matched = 0; let unmatched = 0;
  const BATCH = 5;

  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async lead => {
      const enrichment = JSON.parse(lead.enrichment) as LeadEnrichment;
      const res = await client.messages.create({
        model: config.model, max_tokens: 512,
        messages: [{ role: 'user', content: matchPrompt(lead, enrichment, portfolio, analyses) }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '[]';
      const matches = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { domain: string; relevance_reasoning: string }[];
      return { lead, matches };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { lead, matches } = r.value;
        if (!matches.length) { await sql`UPDATE leads SET status = 'no_match' WHERE id = ${lead.id}`; unmatched++; }
        else { for (const m of matches) { await sql`INSERT INTO lead_domain_matches (lead_id, domain, relevance_reasoning) VALUES (${lead.id}, ${m.domain}, ${m.relevance_reasoning}) ON CONFLICT (lead_id, domain) DO NOTHING`; } matched++; }
      } else { unmatched++; }
    }
    if (i + BATCH < leads.length) await sleep(200);
  }
  return { matched, unmatched };
}

function matchPrompt(lead: { name: string; company?: string | null }, enrichment: LeadEnrichment, portfolio: Asset[], analyses: Map<string, DomainAnalysis>) {
  const domainLines = portfolio.map((d, i) => {
    const analysis = analyses.get(d.domain);
    const buyerContext = analysis ? ` | Ideal buyers: ${analysis.ideal_buyer_types.slice(0, 2).join(', ')} | Industries: ${analysis.industries.slice(0, 3).join(', ')}` : '';
    return `${i + 1}. ${d.domain} — $${d.asking_price.toLocaleString()} — ${d.category} — ${d.description}${buyerContext}`;
  }).join('\n');

  return `You are matching domains from a portfolio to a potential buyer.

Buyer: ${lead.name} at ${lead.company ?? 'unknown'}
Focus: ${enrichment.domain_focus.join(', ')} | Budget: ${enrichment.budget_range}
Pitch angle: ${enrichment.pitch_angle}
Signals: ${enrichment.key_signals.join('; ')}

Portfolio:
${domainLines}

Rules:
- If the buyer works at a domain brokerage, marketplace, or investment firm (e.g. MediaOptions, DomainAgents, Sedo, BrandBucket, Afternic), they buy domains to resell — match any quality brandable
- If budget is unknown, assume they can afford the price
- Be inclusive rather than exclusive — a domain professional can always pass if it's not right for them
- Only return [] if there is genuinely zero connection

Return JSON array (1-3 items or []):
[{"domain": "exact domain name", "relevance_reasoning": "one sentence"}]
Return valid JSON only.`;
}

// ── WRITE ─────────────────────────────────────────────────────────────────────

export async function writeEmails(): Promise<{ written: number }> {
  const leads = await sql`SELECT DISTINCT l.id, l.name, l.email, l.company, l.enrichment, l.raw_data, l.source FROM leads l INNER JOIN lead_domain_matches ldm ON ldm.lead_id = l.id WHERE l.status = 'enriched' AND l.id NOT IN (SELECT DISTINCT lead_id FROM emails WHERE sequence_day = 1)` as LeadRow[];
  let written = 0;

  for (const lead of leads) {
    const enrichment = JSON.parse(lead.enrichment) as LeadEnrichment;
    const matches = await sql`SELECT domain, relevance_reasoning FROM lead_domain_matches WHERE lead_id = ${lead.id}` as { domain: string; relevance_reasoning: string }[];

    // Research the company homepage for personalization context
    const companyContext = await researchCompany(lead.email, lead.company, lead.raw_data);

    for (const match of matches) {
      const analysis = await getDomainAnalysis(match.domain);
      for (const variant of ['direct', 'curious', 'value-led'] as const) {
        try {
          const res = await client.messages.create({
            model: config.model, max_tokens: 512,
            messages: [{ role: 'user', content: emailPrompt(lead, enrichment, match, variant, analysis, companyContext) }],
          });
          const text = res.content[0].type === 'text' ? res.content[0].text : '';
          const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { subject: string; body: string };
          await sql`INSERT INTO emails (lead_id, domain, subject, body, variant, status, sequence_day) VALUES (${lead.id}, ${match.domain}, ${parsed.subject}, ${parsed.body}, ${variant}, 'pending', 1)`;
          written++;
        } catch { /* skip variant */ }
        await sleep(400);
      }
    }
  }
  return { written };
}

async function researchCompany(email: string, company: string | null, rawData: string): Promise<string> {
  try {
    // Derive company domain from email (most reliable) or raw_data
    let companyDomain = email.split('@')[1];
    // Skip generic email providers
    const genericProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'protonmail.com'];
    if (genericProviders.includes(companyDomain)) {
      // Try raw_data for a company domain
      try {
        const rd = JSON.parse(rawData) as Record<string, unknown>;
        if (typeof rd.companyDomain === 'string') companyDomain = rd.companyDomain;
        else return '';
      } catch { return ''; }
    }

    const res = await axios.get(`https://${companyDomain}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html' },
      timeout: 8000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(res.data as string);
    $('script, style, nav, footer, header').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 400);
    return text || '';
  } catch { return ''; }
}

const variantInstructions = {
  direct: 'Get straight to the point. Domain, price, why it fits. No fluff.',
  curious: 'Open with a thought-provoking question about their niche before introducing the domain.',
  'value-led': 'Lead with the value the domain unlocks before mentioning price.',
};

function emailPrompt(lead: LeadRow, enrichment: LeadEnrichment, match: { domain: string; relevance_reasoning: string }, variant: string, analysis: DomainAnalysis | null, companyContext?: string) {
  const domainInsights = analysis ? `
Domain:
- One-liner: ${analysis.one_liner}
- Value props: ${analysis.value_props.slice(0, 2).join('; ')}
- Hook: ${analysis.email_hooks[0] ?? ''}
- Comparable sales: ${analysis.comparable_sales.slice(0, 2).join('; ')}` : '';

  const companySnippet = companyContext
    ? `\nCompany website snippet (use 1 specific detail to personalize): "${companyContext.slice(0, 300)}"`
    : '';

  // Detect upgrade buyer and use a tailored pitch
  let rawData: Record<string, string> = {};
  try { rawData = JSON.parse(lead.raw_data ?? '{}') as Record<string, string>; } catch { /* ok */ }
  const isUpgradeBuyer = lead.source === 'upgrade:buyer' && rawData.upgrade_from;
  const isNameMatch = lead.source === 'namematch:buyer' && rawData.company;
  const upgradeContext = isUpgradeBuyer
    ? `\nUPGRADE BUYER: This person is currently using ${rawData.upgrade_from} — they already have this exact brand, just on a weaker TLD. Lead with: "I noticed you're running on ${rawData.upgrade_from} — I own ${rawData.upgrade_to} and thought you might want the .com." This is NOT cold — they already invested in this brand.`
    : isNameMatch
    ? `\nCOMPANY NAME MATCH: Their company is named "${rawData.company}" — which matches the domain keywords. Lead with: "I came across ${match.domain} and your company name immediately came to mind." They have a natural brand reason to want this domain, even if they haven't thought about it.`
    : '';

  return `Write a cold domain sales email. Sound like a real person, not a template.

Recipient: ${lead.name}${lead.company ? ` @ ${lead.company}` : ''}
Buyer signals: ${enrichment.key_signals.join('; ')}
Domain fit: ${match.domain} — ${match.relevance_reasoning}${domainInsights}${companySnippet}${upgradeContext}
Price placeholder: [PRICE]

Style: ${variantInstructions[variant as keyof typeof variantInstructions]}

Rules (strict):
- Under 100 words total
- Subject: 3–6 words, name the domain or their company specifically, no buzzwords (bad: "domain opportunity", good: "${match.domain} — quick question")
${isUpgradeBuyer ? `- Open with: "I noticed you're on ${rawData.upgrade_from}..." — this is your hook, use it` : '- Reference ONE specific thing about their business from the company snippet or buyer signals'}
- End with a single yes/no question
- Sign as ${config.fromName}

Return JSON only: {"subject": "...", "body": "..."}`;
}

// ── SEQUENCE ──────────────────────────────────────────────────────────────────

export async function writeFollowUps(): Promise<{ written: number }> {
  type ContactedRow = { id: number; name: string; company: string | null; enrichment: string; domain: string; day1_body: string };

  const contacted = await sql`
    SELECT DISTINCT l.id, l.name, l.company, l.enrichment, e.domain, e.body as day1_body
    FROM leads l
    INNER JOIN emails e ON e.lead_id = l.id
    WHERE l.status = 'contacted' AND e.status = 'sent' AND e.sequence_day = 1
  ` as ContactedRow[];

  let written = 0;

  for (const lead of contacted) {
    const analysis = await getDomainAnalysis(lead.domain);
    for (const day of [3, 5, 7]) {
      const existing = await sql`SELECT id FROM emails WHERE lead_id = ${lead.id} AND domain = ${lead.domain} AND sequence_day = ${day}`;
      if (existing.length) continue;
      try {
        const res = await client.messages.create({
          model: config.model, max_tokens: 400,
          messages: [{ role: 'user', content: followUpPrompt(lead, day, lead.day1_body, analysis, lead.domain) }],
        });
        const text = res.content[0].type === 'text' ? res.content[0].text : '';
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { subject: string; body: string };
        await sql`INSERT INTO emails (lead_id, domain, subject, body, variant, status, sequence_day) VALUES (${lead.id}, ${lead.domain}, ${parsed.subject}, ${parsed.body}, ${`day${day}`}, 'approved', ${day})`;
        written++;
      } catch { /* skip */ }
      await sleep(300);
    }
  }
  return { written };
}

function followUpPrompt(
  lead: { name: string; company: string | null; enrichment: string },
  day: number,
  originalBody: string,
  analysis: DomainAnalysis | null,
  domain: string,
): string {
  const enrichment = JSON.parse(lead.enrichment) as LeadEnrichment;
  const angles: Record<number, string> = {
    3: 'Brief casual check-in, 2-3 sentences. Mention you reached out a couple days ago. No hard sell.',
    5: 'New angle — lead with a specific use case or value prop they may not have considered. 3-4 sentences.',
    7: 'Final follow-up. Create gentle urgency — mention other parties have shown interest. Keep it short and warm.',
  };
  const domainContext = analysis
    ? `Domain: ${domain}\nOne-liner: ${analysis.one_liner}\nHook: ${analysis.email_hooks[day === 5 ? 1 : 0] ?? analysis.email_hooks[0]}`
    : `Domain: ${domain}`;

  return `Write follow-up #${day === 3 ? 1 : day === 5 ? 2 : 3} in a domain sales sequence.

Buyer: ${lead.name} (${lead.company ?? 'unknown'})
${domainContext}
Style: ${enrichment.communication_style}

Original email sent:
"""
${originalBody.slice(0, 300)}
"""

Instruction: ${angles[day]}
Rules: under 80 words, sign as ${config.fromName}, no spam trigger words, sounds human not automated, do not repeat the original pitch verbatim

Return JSON: {"subject": "...", "body": "..."}
Return valid JSON only.`;
}

// ── DECIDE ────────────────────────────────────────────────────────────────────

export async function decideAndApprove(): Promise<{ approved: number }> {
  const portfolio = loadPortfolio();
  const priceMap = new Map(portfolio.map(a => [a.domain, a.asking_price]));

  const leads = await sql`SELECT DISTINCT l.id, l.name, l.email, l.enrichment, l.score FROM leads l INNER JOIN emails e ON e.lead_id = l.id WHERE l.status = 'enriched' AND e.status = 'pending' AND e.sequence_day = 1` as (LeadRow & { score: number })[];

  let approved = 0;

  for (const lead of leads) {
    if (lead.score < config.leadScoreThreshold) continue;
    const enrichment = JSON.parse(lead.enrichment) as LeadEnrichment;
    const variants = await sql`SELECT id, lead_id, domain, subject, body, variant FROM emails WHERE lead_id = ${lead.id} AND status = 'pending' AND sequence_day = 1` as { id: number; lead_id: number; domain: string; subject: string; body: string; variant: string }[];

    const byDomain = new Map<string, typeof variants>();
    for (const v of variants) { const g = byDomain.get(v.domain) ?? []; g.push(v); byDomain.set(v.domain, g); }

    for (const [domain, dvariants] of byDomain) {
      const price = priceMap.get(domain);
      if (!price) continue;
      try {
        const best = await pickVariant(enrichment, dvariants);
        const finalSubject = best.subject.replace(/\[PRICE\]/g, `$${price.toLocaleString()}`);
        const finalBody = best.body.replace(/\[PRICE\]/g, `$${price.toLocaleString()}`);
        await sql`UPDATE emails SET status = 'approved', body = ${finalBody}, subject = ${finalSubject} WHERE id = ${best.id}`;
        await sql`UPDATE emails SET status = 'rejected' WHERE lead_id = ${lead.id} AND id != ${best.id} AND sequence_day = 1`;
        approved++;
      } catch { /* skip */ }
    }
  }
  return { approved };
}

async function pickVariant(enrichment: LeadEnrichment, variants: { id: number; subject: string; body: string; variant: string }[]) {
  if (variants.length === 1) return variants[0];
  try {
    const res = await client.messages.create({
      model: config.model, max_tokens: 8,
      messages: [{ role: 'user', content: `Pick best email variant for buyer with style "${enrichment.communication_style}" and pitch angle "${enrichment.pitch_angle}".\n\n${variants.map((v, i) => `${i + 1}. (${v.variant}) ${v.subject}`).join('\n')}\n\nReturn only a number 1-${variants.length}.` }],
    });
    const idx = parseInt(res.content[0].type === 'text' ? res.content[0].text.trim() : '1') - 1;
    return variants[idx] ?? variants[0];
  } catch { return variants[0]; }
}

// ── SEND ──────────────────────────────────────────────────────────────────────

export async function sendApproved(): Promise<{ sent: number; failed: number }> {
  const sentTodayRows = await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`;
  const sentToday = Number((sentTodayRows[0] as { c: string | number }).c ?? 0);
  const remaining = config.dailySendLimit - sentToday;
  if (remaining <= 0) return { sent: 0, failed: 0 };

  type SendItem = { id: number; lead_id: number; domain: string; subject: string; body: string; sequence_day: number };

  const day1 = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day = 1 AND l.status = 'enriched'
    ORDER BY l.score DESC
  ` as SendItem[];

  type FollowUpRow = SendItem & { day1_sent: Date | string | null };
  const dueFollowUpsAll = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day,
           (SELECT MAX(e2.sent_at) FROM emails e2 WHERE e2.lead_id = e.lead_id AND e2.status = 'sent' AND e2.sequence_day = 1) as day1_sent
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day > 1 AND l.status = 'contacted'
    ORDER BY l.score DESC
  ` as FollowUpRow[];
  const dueFollowUps = dueFollowUpsAll.filter(e => {
    if (!e.day1_sent) return false;
    const daysPassed = (Date.now() - new Date(e.day1_sent as string).getTime()) / 86400000;
    return daysPassed >= e.sequence_day - 1;
  });

  const queue = [...day1, ...dueFollowUps].slice(0, remaining);
  let sent = 0; let failed = 0;

  for (const email of queue) {
    const leadRows = await sql`SELECT name, email FROM leads WHERE id = ${email.lead_id}`;
    const lead = leadRows[0] as { name: string; email: string };
    const bodyWithFooter = `${email.body}\n\n---\nTo unsubscribe: ${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(lead.email)}`;
    try {
      await sendViaGmail({ to: lead.email, subject: email.subject, body: bodyWithFooter });
      await sql`UPDATE emails SET status = 'sent', sent_at = NOW() WHERE id = ${email.id}`;
      if (email.sequence_day === 1) await sql`UPDATE leads SET status = 'contacted' WHERE id = ${email.lead_id}`;
      await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, 'ok')`;
      sent++;
    } catch (e) {
      await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, ${`error: ${(e as Error).message}`})`;
      failed++;
    }
    await sleep(10000 + Math.random() * 5000);
  }
  return { sent, failed };
}

// ── SEND (streaming) ──────────────────────────────────────────────────────────

type Emitter = (data: object) => void;

export async function sendApprovedStream(emit: Emitter): Promise<void> {
  const sentTodayRows = await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`;
  const sentToday = Number((sentTodayRows[0] as { c: string | number }).c ?? 0);
  const dailyLimit = await getEffectiveDailyLimit();
  const remaining = dailyLimit - sentToday;

  if (remaining <= 0) {
    emit({ type: 'log', message: `Daily limit of ${dailyLimit} already reached.` });
    return;
  }

  type SendItem = { id: number; lead_id: number; domain: string; subject: string; body: string; sequence_day: number };

  const day1 = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day = 1 AND l.status = 'enriched'
    ORDER BY l.score DESC
  ` as SendItem[];

  type FollowUpRow = SendItem & { day1_sent: Date | string | null };
  const dueFollowUpsAll = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day,
           (SELECT MAX(e2.sent_at) FROM emails e2 WHERE e2.lead_id = e.lead_id AND e2.status = 'sent' AND e2.sequence_day = 1) as day1_sent
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day > 1 AND l.status = 'contacted'
    ORDER BY l.score DESC
  ` as FollowUpRow[];
  const dueFollowUps = dueFollowUpsAll.filter(e => {
    if (!e.day1_sent) return false;
    const daysPassed = (Date.now() - new Date(e.day1_sent as string).getTime()) / 86400000;
    return daysPassed >= e.sequence_day - 1;
  });

  const queue = [...day1, ...dueFollowUps].slice(0, remaining);

  emit({ type: 'log', message: `Sending ${queue.length} emails (${day1.length} new + ${dueFollowUps.length} follow-ups due, limit: ${dailyLimit} — ${remaining} remaining today)` });

  let sent = 0; let failed = 0;

  for (const email of queue) {
    const leadRows = await sql`SELECT name, email FROM leads WHERE id = ${email.lead_id}`;
    const lead = leadRows[0] as { name: string; email: string };
    const label = email.sequence_day > 1 ? `Day ${email.sequence_day} follow-up` : 'Day 1';
    const bodyWithFooter = `${email.body}\n\n---\nTo unsubscribe: ${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(lead.email)}`;
    try {
      await sendViaGmail({ to: lead.email, subject: email.subject, body: bodyWithFooter });
      await sql`UPDATE emails SET status = 'sent', sent_at = NOW() WHERE id = ${email.id}`;
      if (email.sequence_day === 1) await sql`UPDATE leads SET status = 'contacted' WHERE id = ${email.lead_id}`;
      await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, 'ok')`;
      sent++;
      emit({ type: 'sent', message: `✓ ${lead.email} (${email.domain}) [${label}]`, sent, total: queue.length });
    } catch (e) {
      await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, ${`error: ${(e as Error).message}`})`;
      failed++;
      emit({ type: 'failed', message: `✗ ${lead.email}: ${(e as Error).message}` });
    }
    if (sent + failed < queue.length) {
      const delay = 8000 + Math.random() * 7000;
      emit({ type: 'log', message: `Waiting ${Math.round(delay / 1000)}s before next send...` });
      await sleep(delay);
    }
  }

  emit({ type: 'summary', message: `Done — sent: ${sent} | failed: ${failed}`, sent, failed });
}

// ── STATS ─────────────────────────────────────────────────────────────────────

export async function getStats() {
  const statusCounts = await sql`SELECT status, COUNT(*) as count FROM leads GROUP BY status` as { status: string; count: string | number }[];
  const byStatus = Object.fromEntries(statusCounts.map(r => [r.status, Number(r.count)]));
  const sentToday = Number(((await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`)[0] as { c: string | number })?.c ?? 0);
  const sentTotal = Number(((await sql`SELECT COUNT(*) as c FROM send_log WHERE result = 'ok'`)[0] as { c: string | number })?.c ?? 0);
  const replies = Number(((await sql`SELECT COUNT(*) as c FROM leads WHERE status = 'replied'`)[0] as { c: string | number })?.c ?? 0);
  const approved = Number(((await sql`SELECT COUNT(*) as c FROM emails WHERE status = 'approved' AND sequence_day = 1`)[0] as { c: string | number })?.c ?? 0);
  const sourceCounts = await sql`SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC` as { source: string; count: string | number }[];
  const bySources = Object.fromEntries(sourceCounts.map(r => [r.source, Number(r.count)]));
  return { byStatus, sentToday, sentTotal, replies, approved, dailyLimit: config.dailySendLimit, bySources };
}

export async function getLeads(status?: string) {
  if (status) {
    return await sql`SELECT l.*, (SELECT domain FROM lead_domain_matches WHERE lead_id = l.id LIMIT 1) as matched_domain FROM leads l WHERE l.status = ${status} ORDER BY l.score DESC LIMIT 100`;
  }
  return await sql`SELECT l.*, (SELECT domain FROM lead_domain_matches WHERE lead_id = l.id LIMIT 1) as matched_domain FROM leads l ORDER BY l.score DESC LIMIT 100`;
}

export async function getApprovedEmails() {
  return await sql`SELECT e.id, e.domain, e.subject, e.body, e.variant, l.name, l.email, l.score FROM emails e INNER JOIN leads l ON l.id = e.lead_id WHERE e.status = 'approved' AND e.sequence_day = 1 ORDER BY l.score DESC`;
}

export async function getDomainAnalyses() {
  return await sql`SELECT domain, analysis, created_at FROM domain_analyses ORDER BY created_at DESC` as { domain: string; analysis: string; created_at: string }[];
}

export async function getSentEmails() {
  return await sql`
    SELECT e.id, e.domain, e.subject, e.body, e.variant, e.sent_at, e.sequence_day,
           l.name, l.email, l.score, l.company
    FROM emails e
    INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'sent'
    ORDER BY e.sent_at DESC
    LIMIT 200
  `;
}

interface LeadRow { id: number; name: string; email: string; company: string | null; raw_data: string; enrichment: string; source: string | null; }

// ── BROKER PITCHES ────────────────────────────────────────────────────────────

const BROKERS = [
  { name: 'MediaOptions', website: 'mediaoptions.com', specialty: 'premium brandable domains $2k–$500k, strong end-user buyer network' },
  { name: 'DomainAgents', website: 'domainagents.com', specialty: 'professional brokerage with buyer/seller matching' },
  { name: 'Grit Brokerage', website: 'gritbrokerage.com', specialty: 'emerging brandable domains, startup-focused buyers' },
  { name: 'Sedo Brokerage', website: 'sedo.com', specialty: "world's largest domain marketplace, global buyer network" },
];

export interface BrokerPitch {
  broker: string;
  website: string;
  domain: string;
  subject: string;
  body: string;
}

export async function generateBrokerPitches(targetDomains?: string[]): Promise<BrokerPitch[]> {
  const portfolio = loadPortfolio(targetDomains);
  const pitches: BrokerPitch[] = [];

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    const analysisContext = analysis ? `
Buyer profile: ${analysis.buyer_profile_summary}
Target industries: ${analysis.industries.join(', ')}
Ideal buyers: ${analysis.ideal_buyer_types.join(', ')}
Comparable sales: ${analysis.comparable_sales.join('; ')}
Value propositions: ${analysis.value_props.join('; ')}` : '';

    for (const broker of BROKERS) {
      try {
        const res = await client.messages.create({
          model: config.model,
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Write a professional domain brokerage outreach email.

Domain: ${asset.domain}
Asking price: $${asset.asking_price.toLocaleString()}${analysisContext}

Broker firm: ${broker.name} (${broker.website})
Broker specialty: ${broker.specialty}

Write a concise pitch email (150–180 words) to this brokerage asking them to represent or co-broker this domain.
Include: why the domain is brandable/valuable, target buyer profile, asking price, commission offer (standard 10–15%), brief CTA.
Professional but direct. No generic filler. No "Dear [Name]" — open directly.

First line must be: Subject: <subject line>
Then a blank line, then the email body.`,
          }],
        });

        const text = res.content[0].type === 'text' ? res.content[0].text.trim() : '';
        const lines = text.split('\n');
        const subjectIdx = lines.findIndex(l => l.toLowerCase().startsWith('subject:'));
        const subject = subjectIdx >= 0 ? lines[subjectIdx].replace(/^subject:\s*/i, '').trim() : `Brokerage opportunity: ${asset.domain}`;
        const bodyLines = subjectIdx >= 0 ? lines.slice(subjectIdx + 1) : lines;
        const body = bodyLines.join('\n').replace(/^\n+/, '').trim();

        pitches.push({ broker: broker.name, website: broker.website, domain: asset.domain, subject, body });
      } catch { /* skip failed broker */ }
    }
  }

  return pitches;
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
