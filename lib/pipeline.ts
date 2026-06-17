import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { sendViaGmail, fetchRecentInboundEmails, getSendCapacityToday } from './gmail';
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
    'MediaOptions', 'GoDaddy Auctions',
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
    // Strict filter: only keep people whose company's primary domain actually matches
    const domainBase = domain.split('.')[0].toLowerCase();
    const relevant = people.filter(p => {
      const orgDomain = (p.organization?.primary_domain ?? '').toLowerCase();
      return orgDomain === domain || orgDomain.includes(domainBase);
    });
    const withEmail = relevant.filter(p => p.email?.includes('@'));
    const toReveal = relevant.filter(p => p.has_email && !p.email).slice(0, 5);
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
  title?: string;
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

// Hard blacklist — never store or contact leads from these email domains/sources
const BLOCKED_EMAIL_DOMAINS = ['domainagents.com'];
const BLOCKED_SOURCES = new Set(['apollo:DomainAgents']);

export function isBlockedLead(email: string, source?: string | null): boolean {
  const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
  if (BLOCKED_EMAIL_DOMAINS.includes(emailDomain)) return true;
  return source != null && BLOCKED_SOURCES.has(source);
}

// Tier 1 = Apollo-sourced broker/industry leads (warm-channel priority).
// Excludes domain-specific end-user searches (apollo:<domain>-buyer/-industry/-titles) and brand matches.
function leadTier(email: string, source?: string | null): number {
  if (!source?.startsWith('apollo:')) return 2;
  if (BLOCKED_SOURCES.has(source)) return 2;
  if (/-(buyer|industry|titles)$/.test(source) || source === 'apollo:brand-match') return 2;
  return 1;
}

const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const FAKE_EMAIL_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','pdf','zip','mp4','mp3','css','js','ts','tsx','jsx','json','xml','html','woff','ttf','eot','woff2','2x']);

function isValidEmail(email: string): boolean {
  if (!VALID_EMAIL_RE.test(email)) return false;
  const tld = email.split('.').pop()?.toLowerCase() ?? '';
  return !FAKE_EMAIL_EXTS.has(tld);
}

async function upsertLeads(leads: (RawLead & { source?: string })[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0; let skipped = 0;
  for (const l of leads) {
    if (!isValidEmail(l.email)) { skipped++; continue; }
    if (isCorporateNonDomainLead(l.company)) { skipped++; continue; }
    const source = l.source ?? 'scrape';
    if (isBlockedLead(l.email, source)) { skipped++; continue; }
    const rows = await sql`
      INSERT INTO leads (name, email, company, linkedin_url, source, raw_data, status, tier)
      VALUES (${l.name}, ${l.email}, ${l.company ?? null}, ${l.linkedin_url ?? null}, ${source}, ${JSON.stringify(l.raw_data)}, 'new', ${leadTier(l.email, source)})
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

// Physical-business search queries for Google Maps — drop abstract buyer-type
// phrases ("startup founder", "platform") that Maps can't resolve to real places.
function nicheMapsQueries(analysis: DomainAnalysis): string[] {
  const abstract = /startup|founder|investor|platform|\bbrand\b|company|online|e-?commerce|saas|\bapp\b|software|website|domain|developer|entrepreneur/i;
  return [...new Set([...analysis.industries, ...analysis.use_cases])]
    .map(s => s.trim())
    .filter(s => s.length > 3 && s.length <= 40 && !abstract.test(s));
}

type MapsBusiness = { name?: string; website?: string; address?: string; phone?: string; emails?: string[]; mapsUrl?: string };

async function getGoogleMapsBusinesses(searchTerms: string[]): Promise<MapsBusiness[]> {
  if (!config.apifyApiKey || !searchTerms.length) return [];

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${config.apifyApiKey}`,
      // scrapeContacts pulls emails/socials off each business website during the run
      { searchStringsArray: searchTerms.slice(0, 12), maxCrawledPlacesPerSearch: 12, language: 'en', countryCode: 'us', skipClosedPlaces: true, scrapeContacts: true },
      { timeout: 20000 }
    );
    const runId: string = runRes.data?.data?.id;
    if (!runId) return [];
    for (let i = 0; i < 48; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED') return [];
    }
    const items = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    type Item = { title?: string; website?: string; address?: string; phone?: string; phoneUnformatted?: string; emails?: string[]; url?: string };
    return (items.data as Item[]).map(i => ({
      name: i.title, website: i.website, address: i.address,
      phone: i.phone ?? i.phoneUnformatted, emails: i.emails, mapsUrl: i.url,
    }));
  } catch (err) {
    console.error('[GMaps]', (err as Error).message);
    return [];
  }
}

const FILE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','pdf','zip','mp4','mp3','css','js','ts','tsx','jsx','json','xml','html','woff','ttf','eot','woff2']);

async function extractBusinessEmail(websiteUrl: string): Promise<string | null> {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const skipPrefixes = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster'];
  // Suffix-matched against the email's domain (catches subdomains like *.fbcdn.net)
  const skipDomains = ['example.com', 'sentry.io', 'cloudflare.com', 'google.com', 'w3.org', 'schema.org', 'apple.com', 'wix.com', 'squarespace.com',
    'fbcdn.net', 'fbsbx.com', 'facebook.com', 'instagram.com', 'googleusercontent.com', 'gstatic.com', 'cloudfront.net', 'akamaihd.net', 'jsdelivr.net', 'gravatar.com', 'wp.com', 'sentry-cdn.com', 'wixpress.com'];

  function isRealEmail(e: string): boolean {
    const tld = e.split('.').pop()?.toLowerCase() ?? '';
    if (FILE_EXTS.has(tld)) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
    if (e.includes('..') || e.startsWith('.') || e.includes('@.')) return false;
    const eDomain = e.split('@')[1] ?? '';
    if (skipDomains.some(d => eDomain === d || eDomain.endsWith(`.${d}`))) return false;
    return true;
  }
  // Social/aggregator pages aren't real sites — scraping them yields CDN garbage
  const SOCIAL_HOST = /(facebook|instagram|twitter|linkedin|yelp|tiktok|youtube|pinterest|maps\.google|wa\.me|t\.me|m\.me)\./i;
  if (SOCIAL_HOST.test(websiteUrl)) return null;
  const domain = websiteUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
  const siteRoot = domain.replace(/^www\./, '');
  const base = `https://${domain}`;

  const pick = (html: string): string | null => {
    // mailto: links are the highest-confidence signal; fall back to body text,
    // de-obfuscating common "name [at] site dot com" tricks first.
    const mailtos = [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map(m => m[1].toLowerCase());
    const deobf = html.replace(/\s*\[?\(?\s*(at|@)\s*\)?\]?\s*/gi, '@').replace(/\s*\[?\(?\s*dot\s*\)?\]?\s*/gi, '.');
    const body = (deobf.match(emailRegex) ?? []).map(e => e.toLowerCase());
    const candidates = [...mailtos, ...body].filter(e =>
      isRealEmail(e) && !skipPrefixes.some(p => e.startsWith(p))
    );
    if (!candidates.length) return null;
    const ROLE = /^(hello|info|contact|sales|team|support|owner|founder|admin|hi)@/;
    // Prefer an address on the business's own domain (any), then a role inbox.
    const sameDomain = candidates.filter(e => e.endsWith(`@${siteRoot}`));
    if (sameDomain.length) return sameDomain.find(e => ROLE.test(e)) ?? sameDomain[0];
    // Cross-domain (e.g. a gmail on the contact page): only trust a role inbox —
    // a bare personal/garbled address off-domain is usually a scraping artifact.
    return candidates.find(e => ROLE.test(e)) ?? null;
  };

  for (const path of ['', '/contact', '/contact-us', '/contact.html', '/get-in-touch', '/about', '/about-us']) {
    try {
      const res = await axios.get(`${base}${path}`, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        maxRedirects: 3,
      });
      const valid = pick(res.data as string);
      if (valid) return valid;
    } catch { continue; }
  }
  return null;
}

// Biggest US legal-cannabis markets by retail revenue — top 2 niche queries × these
// gives broad market coverage (capped at 12 Maps searches in getGoogleMapsBusinesses).
const MAPS_LOCATIONS = ['California', 'Colorado', 'Michigan', 'Oregon', 'Massachusetts', 'Illinois'];

// Directory/platform emails (the listing's fallback, not the actual business)
const PLATFORM_EMAIL_RE = /@(weedmaps|leafly|dutchie|iheartjane|jane|getsauce|tymber)\.(com|co|io)$/i;

// Quality signal: a cannabis business with no site, a social-only page, or a
// website-builder subdomain genuinely NEEDS a real domain — a far stronger buyer
// than one already on a clean established .com. Injected into raw_data so enrich scores it.
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'yelp.com', 'linktr.ee', 'beacons.ai', 'linktree.com'];
const BUILDER_HOSTS = ['wixsite.com', 'squarespace.com', 'myshopify.com', 'sites.google.com', 'weebly.com', 'godaddysites.com', 'business.site', 'wordpress.com', 'webflow.io', 'carrd.co', 'mystrikingly.com'];
function webIntentSignal(url?: string | null): { web_quality: string; naming_intent: 'high' | 'medium' | 'low' } {
  if (!url || !/[a-z]\.[a-z]/i.test(url)) return { web_quality: 'no-site', naming_intent: 'high' };
  const host = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0].split(':')[0];
  const isHost = (list: string[]) => list.some(h => host === h || host.endsWith(`.${h}`));
  if (isHost(SOCIAL_HOSTS)) return { web_quality: 'social-only', naming_intent: 'high' };
  if (isHost(BUILDER_HOSTS)) return { web_quality: 'builder-subdomain', naming_intent: 'high' };
  if (host.endsWith('.com')) return { web_quality: 'established-com', naming_intent: 'low' };
  if (/\.(net|org|co|biz|info|us|shop|store)$/.test(host)) return { web_quality: 'non-com', naming_intent: 'medium' };
  return { web_quality: 'other', naming_intent: 'medium' };
}

// Pure Apify workflow: Google Maps → contact page scraping → real end-user business
// emails (no Apollo). Niche queries are deduped across the whole portfolio, so a
// 55-domain CBD portfolio runs ONE Maps search of the shared niche instead of 55.
export async function testApifyApollo(targetDomains?: string[], budgetMs = 120000): Promise<{ inserted: number; skipped: number; sources: Record<string, number>; breakdown: Record<string, number>; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = { 'googlemaps:found': 0, 'googlemaps:with-website': 0, 'contact:emails': 0, 'call:tasks': 0 };
  const errors: Record<string, string> = {};

  // Phase 0: collect deduped physical-business queries across the portfolio
  const queries = new Set<string>();
  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    if (!analysis) { errors[asset.domain] = 'no analysis — run Analyze first'; continue; }
    for (const q of nicheMapsQueries(analysis)) queries.add(q);
  }
  if (!queries.size) return { inserted: 0, skipped: 0, sources: {}, breakdown, errors };

  // Location-target the top niche queries at the biggest legal-cannabis markets so
  // Maps returns real dispensaries/CBD shops, not arbitrary out-of-state businesses.
  const cannaRe = /cbd|cannabis|dispensar|hemp|weed|marijuana|smoke ?shop|head ?shop|kush|420/i;
  const ranked = [...queries].sort((a, b) => (cannaRe.test(b) ? 1 : 0) - (cannaRe.test(a) ? 1 : 0));
  const topQueries = ranked.slice(0, 2);
  // Rotate through 3 markets per run (scrapeContacts makes the Maps run slow) so
  // coverage spreads across the markets over successive runs without overrunning.
  const locs = [...MAPS_LOCATIONS].sort(() => Math.random() - 0.5).slice(0, 3);
  const searchQueries: string[] = [];
  for (const loc of locs) for (const q of topQueries) searchQueries.push(`${q} ${loc}`);

  // Phase 1: one Google Maps run (with website contact enrichment) over the markets
  const businesses = await getGoogleMapsBusinesses(searchQueries.length ? searchQueries : [...queries]);
  breakdown['googlemaps:found'] = businesses.length;
  breakdown['googlemaps:with-website'] = businesses.filter(b => b.website).length;

  // Phase 2: the actor already enriched each site for emails (scrapeContacts), so this
  // is pure DB work — businesses with an email become leads; the rest (phone only,
  // ~the majority of dispensaries) become manual call tasks instead of being dropped.
  const phase2Start = Date.now();
  let callTasks = 0;
  for (const biz of businesses) {
    if (Date.now() - phase2Start > budgetMs) break;
    const email = (biz.emails ?? [])
      .map(e => e?.toLowerCase().trim())
      .find(e => !!e && e.includes('@') && !/^(noreply|no-reply|donotreply)/.test(e) && !PLATFORM_EMAIL_RE.test(e));

    if (email && !seen.has(email)) {
      seen.add(email);
      breakdown['contact:emails']++;
      allLeads.push({
        name: biz.name ?? email.split('@')[0],
        email,
        company: biz.name,
        source: 'apify:googlemaps',
        raw_data: { website: biz.website, address: biz.address, phone: biz.phone, ...webIntentSignal(biz.website), source: 'google-maps-contact' },
      });
    } else if (!email && (biz.phone || biz.website) && callTasks < 80) {
      const key = biz.website ?? biz.mapsUrl;
      if (key && !seen.has(key)) {
        seen.add(key);
        const ins = await sql`
          INSERT INTO dm_tasks (channel, url, handle, title, target_domain)
          VALUES ('call', ${key}, ${biz.phone ?? null}, ${`${biz.name ?? 'Cannabis business'}${biz.address ? ' — ' + biz.address : ''}`.slice(0, 200)}, ${null})
          ON CONFLICT (url) DO NOTHING RETURNING id`;
        if (ins.length) { callTasks++; breakdown['call:tasks']++; }
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  const sources: Record<string, number> = {};
  for (const l of allLeads) { const src = l.source ?? 'unknown'; sources[src] = (sources[src] ?? 0) + 1; }
  return { inserted, skipped, sources, breakdown, errors };
}

// ── WEEDMAPS DISPENSARIES ─────────────────────────────────────────────────────
// Weedmaps is the canonical cannabis directory: every licensed dispensary, with a
// contact email/phone in the listing. Far higher email yield than Google Maps for
// this niche. Emails → leads; phone-only → manual call tasks. Markets rotate per run.
type WeedmapsDispensary = { id?: string; slug?: string; name?: string; email?: string; phone_number?: string; web_url?: string; address?: string; city?: string; state?: string; zip_code?: string; license_type?: string };

export async function weedmapsLeads(maxPerLocation = 25): Promise<{ leads: number; callTasks: number; found: number; error?: string }> {
  if (!config.apifyApiKey) return { leads: 0, callTasks: 0, found: 0, error: 'no apify key' };
  const locs = [...MAPS_LOCATIONS].sort(() => Math.random() - 0.5).slice(0, 4);

  let dispensaries: WeedmapsDispensary[] = [];
  try {
    const r = await axios.post(
      `https://api.apify.com/v2/acts/krazee_kaushik~weedmaps-dispensary-scraper/run-sync-get-dataset-items?token=${config.apifyApiKey}`,
      { searchLocations: locs, dispensariesPerSearch: maxPerLocation },
      { timeout: 280000 }
    );
    dispensaries = r.data as WeedmapsDispensary[];
  } catch (e) { return { leads: 0, callTasks: 0, found: 0, error: (e as Error).message }; }

  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  let callTasks = 0;
  for (const d of dispensaries) {
    const email = (d.email ?? '').toLowerCase().trim();
    const addr = [d.address, d.city, d.state, d.zip_code].filter(Boolean).join(', ');
    const raw = { website: d.web_url, address: addr, phone: d.phone_number, license_type: d.license_type, ...webIntentSignal(d.web_url), source: 'weedmaps' };
    if (email && email.includes('@') && !/^(noreply|no-reply|donotreply)/.test(email) && !PLATFORM_EMAIL_RE.test(email) && !seen.has(email)) {
      seen.add(email);
      allLeads.push({ name: d.name ?? email.split('@')[0], email, company: d.name, source: 'weedmaps', raw_data: raw });
    } else if (!email && (d.phone_number || d.web_url) && callTasks < 80) {
      const key = d.web_url || `weedmaps:${d.id ?? d.slug ?? d.name}`;
      if (key && !seen.has(key)) {
        seen.add(key);
        const ins = await sql`
          INSERT INTO dm_tasks (channel, url, handle, title, target_domain)
          VALUES ('call', ${key}, ${d.phone_number ?? null}, ${`${d.name ?? 'Dispensary'}${addr ? ' — ' + addr : ''}`.slice(0, 200)}, ${null})
          ON CONFLICT (url) DO NOTHING RETURNING id`;
        if (ins.length) callTasks++;
      }
    }
  }
  const { inserted } = await upsertLeads(allLeads);
  return { leads: inserted, callTasks, found: dispensaries.length };
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

// RDAP: who holds a domain variant — registration age is the buying signal
async function rdapLookup(domain: string): Promise<{ registered: boolean; registrar?: string; registeredOn?: string; expiresOn?: string }> {
  try {
    const res = await axios.get(`https://rdap.org/domain/${domain}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const data = res.data as { events?: { eventAction: string; eventDate: string }[]; entities?: { roles?: string[]; vcardArray?: [string, [string, object, string, string][]] }[] };
    const ev = (action: string) => data.events?.find(e => e.eventAction === action)?.eventDate;
    const registrarEntity = data.entities?.find(e => e.roles?.includes('registrar'));
    const registrar = registrarEntity?.vcardArray?.[1]?.find(x => x[0] === 'fn')?.[3];
    return { registered: true, registrar, registeredOn: ev('registration'), expiresOn: ev('expiration') };
  } catch {
    return { registered: false };
  }
}

// Privacy-protected variant holders can only be reached via registrar relay forms.
// Automating the submission violates registrar ToS, so the agent does everything
// except the final click: RDAP enrichment, relay link, drafted message — surfaced
// in the daily report as a 60-second manual task.
async function upsertRelayLead(variant: string, asset: Asset, rdap: { registrar?: string; registeredOn?: string; expiresOn?: string }, isLive: boolean): Promise<boolean> {
  const relayUrl = rdap.registrar?.toLowerCase().includes('godaddy')
    ? `https://www.godaddy.com/whois/results.aspx?domain=${variant}&action=contactDomainOwner`
    : `https://who.is/whois/${variant}`;
  const heldSince = rdap.registeredOn ? new Date(rdap.registeredOn).getFullYear() : null;
  const storefront = config.baseUrl.includes('localhost') ? '' : ` Details or direct offers: ${config.baseUrl}/buy/${asset.domain}.`;
  const message = `Subject: ${asset.domain} — offering it to you first\n\nHi — I own ${asset.domain}. I noticed you've held ${variant}${heldSince ? ` since ${heldSince}` : ''}, so I wanted to offer you the matching domain before I sell it elsewhere. It's listed at $${asset.asking_price.toLocaleString()}.${storefront} If it's not for you, no worries.\n\n${config.fromName}`;

  const rows = await sql`
    INSERT INTO relay_leads (variant_domain, target_domain, registrar, registered_on, expires_on, is_live, relay_url, suggested_message)
    VALUES (${variant}, ${asset.domain}, ${rdap.registrar ?? null}, ${rdap.registeredOn ?? null}, ${rdap.expiresOn ?? null}, ${isLive}, ${relayUrl}, ${message})
    ON CONFLICT (variant_domain) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

export async function getRelayLeads(status = 'pending') {
  return await sql`SELECT * FROM relay_leads WHERE status = ${status} ORDER BY is_live DESC, created_at DESC`;
}

// TLDs a business settles for when the clean .com is taken — the wider the net,
// the more same-name variant owners we find (each a natural buyer of the .com).
const UPGRADE_TLDS = [
  'net', 'co', 'org', 'club', 'io', 'app', 'us', 'biz', 'info',
  'shop', 'store', 'online', 'site', 'xyz', 'life', 'pro', 'ca', 'co.uk', 'com.au',
];

export async function findUpgradeBuyers(targetDomains?: string[], budgetMs = 60000): Promise<{
  inserted: number; skipped: number; liveVariants: string[];
  breakdown: Record<string, number>; errors: Record<string, string>;
}> {
  // ~25 variant checks/domain is slow (live + RDAP lookups); time-box so the daily
  // cron never overruns, and shuffle so coverage rotates across the portfolio over
  // successive runs instead of always starting from the same domains.
  const start = Date.now();
  const portfolio = loadPortfolio(targetDomains)
    .map(a => ({ a, r: Math.random() }))
    .sort((x, y) => x.r - y.r)
    .map(x => x.a);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const liveVariants: string[] = [];
  const breakdown: Record<string, number> = { 'checked': 0, 'live': 0, 'apollo': 0, 'contact': 0, 'relay': 0 };
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    if (Date.now() - start > budgetMs) break; // resume remaining domains next run
    const baseName = asset.domain.replace(/\.(com|net|org|io|co|club|app|us|biz|info)$/i, '');
    // TLD variants + the prefix/suffix patterns real businesses settle for when
    // the clean .com is taken (getX, joinX, X-app, Xhq, hyphenated, keyword TLD split)
    const wordSplit = baseName.replace(/([a-z])(club|app|hub|lab|labs|shop|store)$/i, '$1.$2');
    const candidates = [...new Set([
      ...UPGRADE_TLDS.map(t => `${baseName}.${t}`),
      `get${baseName}.com`, `join${baseName}.com`, `try${baseName}.com`, `my${baseName}.com`,
      `${baseName}app.com`, `${baseName}hq.com`,
      ...(wordSplit !== baseName ? [wordSplit] : []),
      ...(baseName.length > 8 ? [baseName.replace(/([a-z]{4,})(club|app|hub|lab)$/i, '$1-$2') + '.com'].filter(c => c !== `${baseName}.com`) : []),
    ])];
    breakdown['checked'] += candidates.length;

    for (const candidate of candidates) {
      let isLive = false;
      try { isLive = await checkDomainLive(candidate); } catch { /* skip */ }
      if (!isLive) {
        // Not serving a site, but possibly registered and held — relay lead if so
        const rdap = await rdapLookup(candidate);
        if (rdap.registered && await upsertRelayLead(candidate, asset, rdap, false)) breakdown['relay']++;
        await sleep(300);
        continue;
      }

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

      // Live site, owner unreachable by email — registrar relay is the path
      if (!allLeads.some(l => (l.raw_data as Record<string, string>)?.upgrade_from === candidate)) {
        const rdap = await rdapLookup(candidate);
        if (rdap.registered && await upsertRelayLead(candidate, asset, rdap, true)) breakdown['relay']++;
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
  return `You are analysing a potential domain buyer. Extract structured intelligence.

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
Scoring rules:
- Score = likelihood this specific business would PURCHASE a $1k-5k domain for a real project.
- Celebrities, billionaires, VC partners, and Fortune-500 executives score UNDER 20 — they do not buy small domains from cold email, regardless of industry fit.
- The sweet spot (70+) is founders/owners of small companies (<50 people) actively building in a matching niche.
- Weight the "naming_intent" signal if present: "high" (no website, social-only page, or a website-builder subdomain) means the business genuinely NEEDS a real domain → score higher; "low" (already on an established .com) means it already has a brand → score lower. "non-com"/"medium" owners of a worse TLD are upgrade prospects → score moderately high.
Only use facts from the data. Return valid JSON only.`;
}

// ── DOMAIN ANALYSIS ───────────────────────────────────────────────────────────

interface Asset {
  domain: string;
  category: string;
  asking_price: number;
  description: string;
  deadline?: string;      // ISO date — presence switches this domain to closing mode
  floor_price?: number;   // counter-offers below this are never accepted; unset = flag every offer
}

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
  const existing = new Set((await sql`SELECT domain FROM domain_analyses` as { domain: string }[]).map(r => r.domain));
  const todo = portfolio.filter(a => !existing.has(a.domain));
  let analyzed = 0;

  // Batched + cheap-model analysis: one call covers many domains on Haiku, cutting
  // token cost ~10x vs one Sonnet call per domain. Resumable — only un-analyzed
  // domains are queued, so a failed batch is simply retried on the next run.
  const BATCH = 10;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const res = await client.messages.create({
        model: config.analyzeModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: batchAnalysisPrompt(batch) }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '[]';
      const rows = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as (DomainAnalysis & { domain: string })[];
      for (const row of rows) {
        const asset = batch.find(b => b.domain.toLowerCase() === String(row.domain ?? '').toLowerCase());
        if (!asset) continue;
        const { domain: _omit, ...analysis } = row;
        await sql`INSERT INTO domain_analyses (domain, analysis) VALUES (${asset.domain}, ${JSON.stringify(analysis)}) ON CONFLICT (domain) DO UPDATE SET analysis = EXCLUDED.analysis`;
        analyzed++;
      }
    } catch { /* batch failed — domains stay un-analyzed and are retried next run */ }
    await sleep(500);
  }

  return { analyzed, skipped: portfolio.length - todo.length };
}

function batchAnalysisPrompt(assets: Asset[]): string {
  const list = assets.map((a, i) => `${i + 1}. ${a.domain} — category: ${a.category}, asking: $${a.asking_price.toLocaleString()}${a.description ? `, note: ${a.description}` : ''}`).join('\n');
  return `You are a domain name expert and sales strategist. Analyse EACH domain below and generate sales intelligence for all of them.

Domains:
${list}

For every domain, target the END-USER who would build a brand on it (not domain investors). Use your knowledge of the domain aftermarket for comparable_sales.

Return ONLY a JSON array — one object per domain, in the same order:
[{
  "domain": "exact domain from the list",
  "ideal_buyer_types": ["who would buy and build on this"],
  "industries": ["industries it fits"],
  "use_cases": ["specific use case 1", "use case 2"],
  "value_props": ["why it's valuable — brand recall, SEO, niche fit"],
  "comparable_sales": ["e.g. cbdoil.com $25k — real where possible"],
  "email_hooks": ["cold-email opening angle 1", "angle 2"],
  "buyer_profile_summary": "2-3 sentences on the ideal buyer and why they'd want it",
  "one_liner": "one punchy value sentence"
}]
Return valid JSON only — no prose, no markdown.`;
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

export async function writeEmails(budgetMs?: number): Promise<{ written: number }> {
  const leads = await sql`SELECT DISTINCT l.id, l.name, l.email, l.company, l.enrichment, l.raw_data, l.source FROM leads l INNER JOIN lead_domain_matches ldm ON ldm.lead_id = l.id WHERE l.status = 'enriched' AND l.id NOT IN (SELECT DISTINCT lead_id FROM emails WHERE sequence_day = 1)` as LeadRow[];
  let written = 0;
  const start = Date.now();

  for (const lead of leads) {
    if (budgetMs && Date.now() - start > budgetMs) break;
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
  const isTrigger = lead.source?.startsWith('trigger:') && rawData.trigger;
  const upgradeContext = isUpgradeBuyer
    ? `\nUPGRADE BUYER: This person is currently using ${rawData.upgrade_from} — they already have this exact brand, just on a weaker TLD. Lead with: "I noticed you're running on ${rawData.upgrade_from} — I own ${rawData.upgrade_to} and thought you might want the .com." This is NOT cold — they already invested in this brand.`
    : isNameMatch
    ? `\nCOMPANY NAME MATCH: Their company is named "${rawData.company}" — which matches the domain keywords. Lead with: "I came across ${match.domain} and your company name immediately came to mind." They have a natural brand reason to want this domain, even if they haven't thought about it.`
    : isTrigger
    ? `\nTRIGGER MOMENT: ${rawData.trigger_company} just hit a buying moment — ${rawData.trigger}. Open by referencing that event specifically (congratulate briefly, no flattery), then connect the domain to what they're building NOW. This is why you're emailing TODAY and not last month — make that obvious.`
    : '';

  const storefrontLine = config.baseUrl.includes('localhost')
    ? ''
    : `\nStorefront link (include it naturally — they can see details, chat, or buy instantly there): ${config.baseUrl}/buy/${match.domain}`;

  return `Write a cold domain sales email. Sound like a real person, not a template.

Recipient: ${lead.name}${lead.company ? ` @ ${lead.company}` : ''}
Buyer signals: ${enrichment.key_signals.join('; ')}
Domain fit: ${match.domain} — ${match.relevance_reasoning}${domainInsights}${companySnippet}${upgradeContext}${storefrontLine}
Price placeholder: [PRICE]

Style: ${variantInstructions[variant as keyof typeof variantInstructions]}

Structure (research-backed — follow exactly):
1. First line: a specific observation about THEIR business that proves research (from the company snippet/signals). Never open with the domain or "I".
2. Bridge: why this domain fits what THEY are building — buyer-centric, not domain-centric. One comp sale max as a price anchor.
3. Price, stated plainly.
4. One low-commitment, concrete CTA (e.g. "worth a couple of minutes this week?" / "want me to hold it while you check with your team?") — never a bare "interested?" or "would this be a fit?".

Rules (strict):
- 50–90 words total. One ask only.
- Subject: 3–6 words, personalized with their company or what they're building, no buzzwords (bad: "domain opportunity", good: "${match.domain} — quick question").
${isUpgradeBuyer ? `- Open with: "I noticed you're on ${rawData.upgrade_from}..." — this is your hook, use it` : ''}
- Vary your wording — never use the phrases "screams", "premium brandable", or any phrase that sounds like a listing.
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
  const portfolio = loadPortfolio();

  for (const lead of contacted) {
    const analysis = await getDomainAnalysis(lead.domain);
    const asset = portfolio.find(a => a.domain === lead.domain);
    for (const day of [3, 5, 7]) {
      const existing = await sql`SELECT id FROM emails WHERE lead_id = ${lead.id} AND domain = ${lead.domain} AND sequence_day = ${day}`;
      if (existing.length) continue;
      try {
        const res = await client.messages.create({
          model: config.model, max_tokens: 400,
          messages: [{ role: 'user', content: followUpPrompt(lead, day, lead.day1_body, analysis, lead.domain, asset?.deadline) }],
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
  deadline?: string,
): string {
  const enrichment = JSON.parse(lead.enrichment) as LeadEnrichment;
  const deadlineNote = deadline
    ? ` The sale closes ${formatDeadline(deadline)} — state this plainly as a real deadline, best offer wins.`
    : '';
  const angles: Record<number, string> = {
    3: `Brief casual check-in, 2-3 sentences. Mention you reached out a couple days ago. No hard sell.${deadlineNote}`,
    5: `New angle — lead with a specific use case or value prop they may not have considered. 3-4 sentences.${deadlineNote}`,
    7: `Final follow-up. Create gentle urgency — mention other parties have shown interest. Keep it short and warm.${deadlineNote}`,
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

// ── REPLIES ───────────────────────────────────────────────────────────────────
// Pulls recent inbound Gmail messages and matches them to known leads.
// Requires the Gmail account to be connected with the gmail.readonly scope.

export async function syncReplies(sinceDays = 7): Promise<{ scanned: number; matched: number; bounced: number; error?: string }> {
  let inbound;
  try {
    inbound = await fetchRecentInboundEmails(sinceDays);
  } catch (e) {
    return { scanned: 0, matched: 0, bounced: 0, error: `${(e as Error).message} — reconnect Gmail in the dashboard to grant read access` };
  }

  let matched = 0;
  let bounced = 0;
  for (const msg of inbound) {
    // Bounce detection: mailer-daemon notices name the dead address in the snippet.
    // Bounced leads exit every queue — bounce rate is what kills Gmail sender reputation.
    if (/^(mailer-daemon|postmaster)@/i.test(msg.from) || /delivery status notification|address not found|wasn't delivered|undeliver/i.test(msg.subject)) {
      const deadEmails = (`${msg.subject} ${msg.snippet}`.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) ?? [])
        .filter(e => !/^(mailer-daemon|postmaster)@/i.test(e));
      for (const dead of [...new Set(deadEmails)]) {
        const rows = await sql`UPDATE leads SET status = 'bounced' WHERE LOWER(email) = ${dead.toLowerCase()} AND status NOT IN ('blocked') RETURNING id` as { id: number }[];
        if (rows.length) {
          bounced++;
          await sql`UPDATE emails SET status = 'rejected' WHERE lead_id = ${rows[0].id} AND status IN ('pending', 'approved')`;
        }
      }
      continue;
    }
    const rows = await sql`SELECT id, status FROM leads WHERE LOWER(email) = ${msg.from}` as { id: number; status: string }[];
    const lead = rows[0];
    if (!lead) continue;
    const ins = await sql`
      INSERT INTO replies (lead_id, gmail_message_id, gmail_thread_id, rfc_message_id, from_email, subject, snippet, received_at, gmail_account)
      VALUES (${lead.id}, ${msg.messageId}, ${msg.threadId}, ${msg.rfcMessageId}, ${msg.from}, ${msg.subject}, ${msg.snippet}, ${msg.receivedAt.toISOString()}, ${msg.account})
      ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`;
    if (!ins.length) continue;
    matched++;
    if (!['unsubscribed', 'blocked'].includes(lead.status)) {
      await sql`UPDATE leads SET status = 'replied', tier = 1 WHERE id = ${lead.id}`;
    }
    // Product system: every reply becomes a structured engagement data point
    await logEngagement(lead.id, (ins[0] as { id: number }).id, msg).catch(e => console.error('[engagement]', (e as Error).message));
  }
  return { scanned: inbound.length, matched, bounced };
}

// ── ENGAGEMENT LOG (Dataset 1) ────────────────────────────────────────────────
// Every response — broker or buyer — is a vote on domain quality. Classified by
// Claude and stored with domain characteristics for the Broker Interest Score.

async function logEngagement(leadId: number, replyId: number, msg: { from: string; subject: string; snippet: string; receivedAt: Date }): Promise<void> {
  const leadRows = await sql`SELECT name, email, company, raw_data FROM leads WHERE id = ${leadId}` as { name: string; email: string; company: string | null; raw_data: string }[];
  const lead = leadRows[0];
  const sentRows = await sql`SELECT domain, sent_at FROM emails WHERE lead_id = ${leadId} AND status = 'sent' AND sent_at < ${msg.receivedAt.toISOString()} ORDER BY sent_at DESC LIMIT 1` as { domain: string; sent_at: string }[];
  const lastSent = sentRows[0];
  if (!lastSent) return;

  const responseHours = (msg.receivedAt.getTime() - new Date(lastSent.sent_at).getTime()) / 3600000;
  const asset = loadPortfolio().find(a => a.domain === lastSent.domain);
  const metrics = (await sql`SELECT brandability_score, estimated_value_usd FROM domain_metrics WHERE domain = ${lastSent.domain}`)[0] as { brandability_score: number | null; estimated_value_usd: number | null } | undefined;

  let role = '';
  try { role = (JSON.parse(lead.raw_data) as { title?: string }).title ?? ''; } catch { /* ok */ }

  let cls = { responder_type: 'other', specialty: '', reasoning: '' };
  try {
    const res = await client.messages.create({
      model: config.model, max_tokens: 256,
      messages: [{ role: 'user', content: `Classify who sent this reply to a domain sales email.

Sender: ${lead.name} <${msg.from}>${lead.company ? `, company: ${lead.company}` : ''}${role ? `, title: ${role}` : ''}
Their reply: "${msg.snippet}"

Types: "broker" (domain broker/investor/reseller), "buyer" (end user who would build on the domain), "registrar" (registrar/marketplace employee), "other".

Return JSON only: {"responder_type": "...", "specialty": "their niche if broker, else empty", "reasoning": "one sentence"}` }],
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
    cls = { ...cls, ...JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) };
  } catch { /* keep defaults */ }

  await sql`
    INSERT INTO engagement_log (lead_id, reply_id, domain, domain_length, tld, asking_price, ai_valuation, brandability_score, contact_role, contact_company, responder_type, responder_specialty, response_hours, outcome, reasoning)
    VALUES (${leadId}, ${replyId}, ${lastSent.domain}, ${lastSent.domain.split('.')[0].length}, ${lastSent.domain.split('.').pop() ?? ''}, ${asset?.asking_price ?? null}, ${metrics?.estimated_value_usd ?? null}, ${metrics?.brandability_score ?? null}, ${role || null}, ${lead.company}, ${cls.responder_type}, ${cls.specialty || null}, ${Math.round(responseHours * 10) / 10}, 'responded', ${cls.reasoning || null})
    ON CONFLICT (lead_id, domain, outcome) DO NOTHING`;
}

// Silence is data: contacted leads whose sequence finished with zero replies → 'ignored'
export async function markIgnoredOutcomes(): Promise<{ marked: number }> {
  const rows = await sql`
    SELECT DISTINCT l.id, l.company, l.raw_data, e.domain
    FROM leads l
    INNER JOIN emails e ON e.lead_id = l.id AND e.status = 'sent' AND e.sequence_day >= 7
    WHERE l.status = 'contacted'
      AND e.sent_at < NOW() - INTERVAL '2 days'
      AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM engagement_log g WHERE g.lead_id = l.id AND g.domain = e.domain)
  ` as { id: number; company: string | null; raw_data: string; domain: string }[];

  const portfolio = loadPortfolio();
  let marked = 0;
  for (const r of rows) {
    const asset = portfolio.find(a => a.domain === r.domain);
    let role = '';
    try { role = (JSON.parse(r.raw_data) as { title?: string }).title ?? ''; } catch { /* ok */ }
    await sql`
      INSERT INTO engagement_log (lead_id, domain, domain_length, tld, asking_price, contact_role, contact_company, outcome)
      VALUES (${r.id}, ${r.domain}, ${r.domain.split('.')[0].length}, ${r.domain.split('.').pop() ?? ''}, ${asset?.asking_price ?? null}, ${role || null}, ${r.company}, 'ignored')
      ON CONFLICT (lead_id, domain, outcome) DO NOTHING`;
    marked++;
  }
  return { marked };
}

// ── DOMAIN METRICS ────────────────────────────────────────────────────────────
// Numeric characteristics + valuation per domain, snapshotted for correlation analysis.

export async function computeDomainMetrics(): Promise<{ computed: number; skipped: number }> {
  let computed = 0; let skipped = 0;
  for (const asset of loadPortfolio()) {
    const existing = await sql`SELECT id FROM domain_metrics WHERE domain = ${asset.domain}`;
    if (existing.length) { skipped++; continue; }
    let scores = { brandability_score: null as number | null, estimated_value_usd: null as number | null, keyword_type: null as string | null };
    try {
      const res = await client.messages.create({
        model: config.model, max_tokens: 256,
        messages: [{ role: 'user', content: `Score this domain for the aftermarket. Domain: ${asset.domain} (${asset.category}; listed at $${asset.asking_price.toLocaleString()}).

Return JSON only:
{"brandability_score": <0-100>, "estimated_value_usd": <realistic wholesale-to-retail midpoint>, "keyword_type": "invented|compound|dictionary|geo|other"}` }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
      scores = { ...scores, ...JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) };
    } catch { /* store characteristics only */ }
    await sql`
      INSERT INTO domain_metrics (domain, domain_length, tld, keyword_type, brandability_score, estimated_value_usd)
      VALUES (${asset.domain}, ${asset.domain.split('.')[0].length}, ${asset.domain.split('.').pop() ?? ''}, ${scores.keyword_type}, ${scores.brandability_score}, ${scores.estimated_value_usd})
      ON CONFLICT (domain) DO NOTHING`;
    computed++;
  }
  return { computed, skipped };
}

// ── LOST DEAL AUDIT (Dataset 2) ───────────────────────────────────────────────
// Runs the five audit questions over zero-response campaigns.

export async function auditLostDeals(limit = 20): Promise<{ audited: number; summary: Record<string, number> }> {
  type AuditTarget = { id: number; name: string; email: string; company: string | null; raw_data: string; source: string | null; domain: string; subject: string; body: string };
  const targets = await sql`
    SELECT DISTINCT ON (l.id) l.id, l.name, l.email, l.company, l.raw_data, l.source, e.domain, e.subject, e.body
    FROM leads l
    INNER JOIN emails e ON e.lead_id = l.id AND e.status = 'sent' AND e.sequence_day = 1
    WHERE l.status = 'contacted'
      AND e.sent_at < NOW() - INTERVAL '5 days'
      AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM campaign_audits c WHERE c.lead_id = l.id)
    ORDER BY l.id
    LIMIT ${limit}
  ` as AuditTarget[];

  const portfolio = loadPortfolio();
  const summary: Record<string, number> = { right_contact: 0, price_defensible: 0, buyer_centric: 0, clear_cta: 0, trigger_moment: 0 };
  let audited = 0;

  for (const t of targets) {
    const asset = portfolio.find(a => a.domain === t.domain);
    const analysis = await getDomainAnalysis(t.domain);
    const realComps = asset ? await getRelevantComps(t.domain, asset.asking_price).catch(() => [] as string[]) : [];
    let role = '';
    try { role = (JSON.parse(t.raw_data) as { title?: string }).title ?? ''; } catch { /* ok */ }
    try {
      const res = await client.messages.create({
        model: config.model, max_tokens: 512,
        messages: [{ role: 'user', content: `Audit this failed domain outreach (zero responses). Be brutally honest — the goal is to find why it failed.

Domain: ${t.domain}, asking $${asset?.asking_price.toLocaleString() ?? '?'}
Comparable sales: ${[...realComps, ...(analysis?.comparable_sales.slice(0, 2) ?? [])].slice(0, 4).join('; ') || 'unknown'}
Contact: ${t.name}${role ? ` (${role})` : ''}${t.company ? ` at ${t.company}` : ''}, sourced from: ${t.source}
Email sent:
Subject: ${t.subject}
"""
${t.body.slice(0, 2000)}
"""

Answer each strictly:
1. right_contact — is this person plausibly a domain BUYING decision-maker for their company (not a marketplace employee, not random staff)?
2. price_defensible — is the asking price within ~2x of the comparable sales?
3. buyer_centric — does the email explain why THIS company specifically needs the domain (vs. generic domain-centric pitch)?
4. clear_cta — is there one clear, low-friction next step?
5. trigger_moment — is there any evidence the company was in an active buying moment?

Return JSON only: {"right_contact": bool, "price_defensible": bool, "buyer_centric": bool, "clear_cta": bool, "trigger_moment": bool, "reasoning": "2 sentences max on the main failure"}` }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
      const a = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { right_contact: boolean; price_defensible: boolean; buyer_centric: boolean; clear_cta: boolean; trigger_moment: boolean; reasoning: string };
      await sql`
        INSERT INTO campaign_audits (lead_id, domain, right_contact, price_defensible, buyer_centric, clear_cta, trigger_moment, reasoning)
        VALUES (${t.id}, ${t.domain}, ${a.right_contact}, ${a.price_defensible}, ${a.buyer_centric}, ${a.clear_cta}, ${a.trigger_moment}, ${a.reasoning})
        ON CONFLICT (lead_id, domain) DO NOTHING`;
      for (const k of Object.keys(summary)) if (a[k as keyof typeof a]) summary[k]++;
      audited++;
    } catch { /* skip */ }
    await sleep(300);
  }
  return { audited, summary };
}

// ── BROKER INTEREST REPORT ────────────────────────────────────────────────────
// Descriptive stats over the engagement log. Becomes a real scoring model once
// the log reaches the 200-300 interactions the strategy doc calls for.

export async function getBrokerInterestReport() {
  const byType = await sql`SELECT responder_type, outcome, COUNT(*) as c FROM engagement_log GROUP BY responder_type, outcome ORDER BY c DESC`;
  const byDomain = await sql`
    SELECT domain, COUNT(*) FILTER (WHERE outcome = 'responded') as responses, COUNT(*) FILTER (WHERE outcome = 'ignored') as ignored,
           ROUND(AVG(response_hours) FILTER (WHERE response_hours IS NOT NULL)::numeric, 1) as avg_response_hours
    FROM engagement_log GROUP BY domain`;
  const brokerSpecialties = await sql`SELECT responder_specialty, COUNT(*) as c FROM engagement_log WHERE responder_type = 'broker' AND responder_specialty IS NOT NULL GROUP BY responder_specialty ORDER BY c DESC LIMIT 10`;
  const total = await sql`SELECT COUNT(*) as c FROM engagement_log`;
  return {
    total_interactions: Number((total[0] as { c: string | number }).c),
    target_for_model: 200,
    by_responder_type: byType,
    by_domain: byDomain,
    broker_specialties: brokerSpecialties,
  };
}

// ── TRIGGER EVENTS ────────────────────────────────────────────────────────────
// Companies in a moment of motivation: fresh funding news in the domain's
// industries → company names → Apollo contact lookup. The trigger is stored on
// the lead so the email writer can open with it.

export async function findTriggerLeads(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; companies: number; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const errors: Record<string, string> = {};
  const companies: { name: string; trigger: string; domain: string }[] = [];

  // Generic industries ("health and wellness", "technology") pull funding news for
  // any startup — the relevance gate. Use only the domain's specific niches so a
  // CBD domain matches cannabis/CBD companies, not every wellness app.
  const GENERIC_INDUSTRY_RE = /^(health( and| &)? wellness|wellness|health( ?care)?|technology|tech|e-?commerce|retail|business|consumer goods|saas|software|marketing|services|general|startups?|lifestyle|digital|online)$/i;

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    if (!analysis) { errors[asset.domain] = 'no analysis'; continue; }

    const niches = analysis.industries.filter(i => !GENERIC_INDUSTRY_RE.test(i.trim()));
    const useIndustries = (niches.length ? niches : analysis.industries).slice(0, 3);
    for (const industry of useIndustries) {
      // Any naming/branding moment — not just funding. New launches, openings, and
      // freshly-licensed businesses are the highest-intent buyers (they have no domain yet).
      const query = `"${industry}" ("raises" OR "series a" OR "seed round" OR "rebrand" OR "launches" OR "now open" OR "grand opening" OR "awarded license" OR "new dispensary" OR "debuts")`;
      try {
        const res = await axios.get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000,
        });
        const $ = cheerio.load(res.data as string, { xmlMode: true });
        const titles: string[] = [];
        $('item title').each((_, el) => { const t = $(el).text().trim(); if (t) titles.push(t); });
        if (!titles.length) continue;

        const extract = await client.messages.create({
          model: config.model, max_tokens: 512,
          messages: [{ role: 'user', content: `Extract company names from these "${industry}" news headlines. Keep ONLY businesses in a naming/branding moment: just RAISED money, REBRANDED, LAUNCHED, OPENED a new location/store, or were AWARDED a license. Exclude investors, acquirers, regulators, and established incumbents just making announcements.

${titles.slice(0, 25).map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return JSON only: [{"company": "...", "trigger": "short description, e.g. raised $8M Series A / just opened in Denver / awarded dispensary license"}]
Max 8. Return [] if none.` }],
        });
        const text = extract.content[0].type === 'text' ? extract.content[0].text : '[]';
        const found = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { company: string; trigger: string }[];
        for (const f of found) companies.push({ name: f.company, trigger: f.trigger, domain: asset.domain });
      } catch (e) { errors[`news:${industry}`] = (e as Error).message; }
      await sleep(500);
    }
  }

  // Only people who can actually authorize buying a domain — Apollo's seniority
  // filter leaks ICs (engineers, editors, IT), so gate on the title text itself.
  const DECISION_MAKER_RE = /\b(founder|co-?founder|ceo|chief executive|cmo|chief marketing|chief brand|cbo|owner|president|managing director|\bmd\b|partner|head of (brand|marketing|growth|digital|ecommerce)|vp,? (of )?(brand|marketing|growth|ecommerce)|(brand|marketing|growth) director)\b/i;

  // Contact discovery via Apollo (requires working Apollo API access)
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  for (const c of companies.slice(0, 15)) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        { q_organization_name: c.name, person_seniority: ['owner', 'founder', 'c_suite'], per_page: 5, page: 1 },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const people: ApolloPersonResult[] = res.data?.people ?? [];
      const relevant = people.filter(p =>
        p.organization?.name?.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]) &&
        DECISION_MAKER_RE.test(p.title ?? ''));
      const toReveal = relevant.filter(p => p.has_email && !p.email).slice(0, 3);
      const revealed = toReveal.length ? await revealEmails(toReveal) : [];
      for (const p of [...relevant.filter(p => p.email?.includes('@')), ...revealed].filter(p => p.email)) {
        if (seen.has(p.email!)) continue;
        seen.add(p.email!);
        allLeads.push({
          name: [p.first_name, p.last_name].filter(Boolean).join(' '),
          email: p.email!,
          company: p.organization?.name,
          linkedin_url: p.linkedin_url,
          source: 'trigger:funding',
          raw_data: { trigger: c.trigger, trigger_company: c.name, target_domain: c.domain, title: p.title },
        });
      }
    } catch (e) { errors[`apollo:${c.name}`] = (e as Error).message; }
    await sleep(400);
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, companies: companies.length, errors };
}

// ── CLOSING MODE ──────────────────────────────────────────────────────────────
// For domains with a deadline set in domains.json: replied leads get short,
// direct negotiation/nudge emails. Drafts are created as 'pending' — they only
// send after manual approval. Offers always flag the owner immediately.

function formatDeadline(deadline: string): string {
  return new Date(`${deadline}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Sprint mode auto-expires: a domain is only in closing mode until its deadline passes.
// After that, broker replies route to the engagement log (product mode) instead of the negotiation queue.
function activeClosingAssets(): Asset[] {
  const now = Date.now();
  return loadPortfolio().filter(a => a.deadline && new Date(`${a.deadline}T23:59:59Z`).getTime() >= now);
}

const OFFER_RE = /\$\s?\d|\b\d+(\.\d+)?k\b|\boffer\b|\bcounter\b|\bbudget\b|\bprice\b|\bpay\b/i;

export async function writeClosingFollowUps(): Promise<{ written: number; flagged: number; skipped: number }> {
  const closingAssets = activeClosingAssets();
  let written = 0; let flagged = 0; let skipped = 0;

  for (const asset of closingAssets) {
    type RepliedLead = { id: number; name: string; email: string; company: string | null; source: string | null };
    const replied = await sql`
      SELECT DISTINCT l.id, l.name, l.email, l.company, l.source
      FROM leads l
      INNER JOIN emails e ON e.lead_id = l.id AND e.domain = ${asset.domain} AND e.status = 'sent'
      WHERE l.status = 'replied'` as RepliedLead[];

    const competingCount = replied.length;

    for (const lead of replied) {
      if (isBlockedLead(lead.email, lead.source)) { skipped++; continue; }

      const lastReplyRows = await sql`SELECT subject, snippet, received_at FROM replies WHERE lead_id = ${lead.id} ORDER BY received_at DESC LIMIT 1` as { subject: string; snippet: string; received_at: string }[];
      const lastReply = lastReplyRows[0];
      if (!lastReply) continue;

      const queued = await sql`SELECT id FROM emails WHERE lead_id = ${lead.id} AND domain = ${asset.domain} AND variant LIKE 'closing%' AND status IN ('pending', 'approved')`;
      if (queued.length) { skipped++; continue; }

      const lastOutRows = await sql`SELECT sent_at, variant FROM emails WHERE lead_id = ${lead.id} AND domain = ${asset.domain} AND status = 'sent' ORDER BY sent_at DESC LIMIT 1` as { sent_at: string; variant: string }[];
      const lastOut = lastOutRows[0];
      const replyAt = new Date(lastReply.received_at).getTime();
      const lastOutAt = lastOut ? new Date(lastOut.sent_at).getTime() : 0;
      const isOffer = OFFER_RE.test(`${lastReply.subject} ${lastReply.snippet}`);

      let variant: string;
      if (replyAt > lastOutAt) {
        // They spoke last — respond now
        variant = isOffer ? 'closing-negotiation' : 'closing-reply';
      } else {
        // We spoke last — nudge at 24h, then 48h, then stop
        if (lastOut?.variant === 'closing-nudge-48h') { skipped++; continue; }
        const quietHours = (Date.now() - lastOutAt) / 3600000;
        if (quietHours < 24) { skipped++; continue; }
        variant = lastOut?.variant === 'closing-nudge-24h' ? 'closing-nudge-48h' : 'closing-nudge-24h';
      }

      try {
        const res = await client.messages.create({
          model: config.model, max_tokens: 400,
          messages: [{ role: 'user', content: closingPrompt(lead, asset, variant, lastReply, competingCount) }],
        });
        const text = res.content[0].type === 'text' ? res.content[0].text : '';
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { subject: string; body: string };
        await sql`INSERT INTO emails (lead_id, domain, subject, body, variant, status, sequence_day) VALUES (${lead.id}, ${asset.domain}, ${parsed.subject}, ${parsed.body}, ${variant}, 'pending', 1)`;
        written++;
        if (isOffer) {
          flagged++;
          await alertOwner(
            `[ACTION NEEDED] ${lead.name} (${lead.email}) — ${asset.domain}`,
            `Possible offer in their last reply:\n\n"${lastReply.snippet}"\n\nDrafted response (held as pending, will NOT send until you approve):\n\nSubject: ${parsed.subject}\n\n${parsed.body}\n\nAsking: $${asset.asking_price.toLocaleString()} | Floor: ${asset.floor_price ? `$${asset.floor_price.toLocaleString()}` : 'NOT SET — define floor_price in domains.json'} | Deadline: ${formatDeadline(asset.deadline!)}`
          );
        }
      } catch { skipped++; }
      await sleep(300);
    }
  }
  return { written, flagged, skipped };
}

function closingPrompt(
  lead: { name: string; company: string | null },
  asset: Asset,
  variant: string,
  lastReply: { subject: string; snippet: string },
  competingCount: number,
): string {
  const deadlineStr = formatDeadline(asset.deadline!);
  const floorRule = asset.floor_price
    ? `- If they made an offer at or above $${asset.floor_price.toLocaleString()}, you may signal it's workable and push to close. Below $${asset.floor_price.toLocaleString()}: do NOT accept or counter — say the owner is reviewing all offers before ${deadlineStr}.`
    : `- Do NOT accept, reject, or counter any specific price — say the owner is reviewing all offers before ${deadlineStr}.`;
  const competingRule = competingCount >= 2
    ? `- It is TRUE that ${competingCount} interested parties are in active conversations about this domain — mention competing interest once, factually, to drive urgency.`
    : '- Do NOT claim other interest — there is only this one active conversation.';

  const instructions: Record<string, string> = {
    'closing-reply': 'They replied with interest. Respond directly: confirm the asking price, state the deadline, ask if they want to move forward.',
    'closing-negotiation': 'They likely mentioned a price or offer. Move the negotiation forward per the price rules below.',
    'closing-nudge-24h': 'They replied earlier but went quiet for 24h+. One short nudge: 2 sentences max, reference the deadline, ask for their decision.',
    'closing-nudge-48h': 'Second and final nudge after 48h+ of silence. Even shorter. Deadline is firm — last chance to make an offer.',
  };

  return `Write the next email in an active domain sale negotiation. This is a WARM thread — they already replied.

Domain: ${asset.domain}
Asking price: $${asset.asking_price.toLocaleString()}
Hard deadline: ${deadlineStr} — the sale closes then, best offer wins. This is real.
Buyer: ${lead.name}${lead.company ? ` @ ${lead.company}` : ''}
Their last message: "${lastReply.snippet}"

Task: ${instructions[variant] ?? instructions['closing-reply']}

Rules (strict):
${floorRule}
${competingRule}
- Under 60 words. Plain human tone — like a busy founder typing on their phone.
- No "I hope this finds you well", no fluff, no exclamation marks, no AI-sounding phrasing.${config.baseUrl.includes('localhost') ? '' : `\n- They can make a binding offer or buy instantly at ${config.baseUrl}/buy/${asset.domain} — mention it when it helps close.`}
- Subject: if replying to their message, reuse their subject with "Re:" — their subject was "${lastReply.subject}".
- Sign as ${config.fromName}.

Return JSON only: {"subject": "...", "body": "..."}`;
}

async function alertOwner(subject: string, body: string): Promise<void> {
  if (!config.reportEmail) return;
  try {
    await sendViaGmail({ to: config.reportEmail, subject, body });
  } catch (e) {
    console.error('[alertOwner]', (e as Error).message);
  }
}

// ── DAILY REPORT ──────────────────────────────────────────────────────────────

export async function generateDailyReport(): Promise<string> {
  const closingAssets = activeClosingAssets();
  const lines: string[] = [];

  const newReplies = await sql`
    SELECT r.from_email, r.subject, r.snippet, r.received_at, l.name, l.company
    FROM replies r INNER JOIN leads l ON l.id = r.lead_id
    WHERE r.created_at > NOW() - INTERVAL '24 hours'
    ORDER BY r.received_at DESC` as { from_email: string; subject: string; snippet: string; received_at: string; name: string; company: string | null }[];

  lines.push(`REPLIES (last 24h): ${newReplies.length}`);
  for (const r of newReplies) {
    lines.push(`- ${r.name}${r.company ? ` (${r.company})` : ''} <${r.from_email}>: "${r.snippet.slice(0, 140)}"`);
  }

  for (const asset of closingAssets) {
    const daysLeft = Math.ceil((new Date(`${asset.deadline}T23:59:59Z`).getTime() - Date.now()) / 86400000);
    lines.push('');
    lines.push(`CLOSING — ${asset.domain} ($${asset.asking_price.toLocaleString()}, deadline ${formatDeadline(asset.deadline!)}, ${daysLeft} day(s) left)`);

    type ThreadRow = { id: number; name: string; email: string; company: string | null; last_reply: string | null; last_reply_at: string | null; last_out_variant: string | null; last_out_at: string | null };
    const threads = await sql`
      SELECT DISTINCT l.id, l.name, l.email, l.company,
        (SELECT snippet FROM replies WHERE lead_id = l.id ORDER BY received_at DESC LIMIT 1) as last_reply,
        (SELECT received_at::text FROM replies WHERE lead_id = l.id ORDER BY received_at DESC LIMIT 1) as last_reply_at,
        (SELECT variant FROM emails WHERE lead_id = l.id AND domain = ${asset.domain} AND status = 'sent' ORDER BY sent_at DESC LIMIT 1) as last_out_variant,
        (SELECT sent_at::text FROM emails WHERE lead_id = l.id AND domain = ${asset.domain} AND status = 'sent' ORDER BY sent_at DESC LIMIT 1) as last_out_at
      FROM leads l
      INNER JOIN emails e ON e.lead_id = l.id AND e.domain = ${asset.domain} AND e.status = 'sent'
      WHERE l.status = 'replied'` as ThreadRow[];

    if (!threads.length) lines.push('- No warm threads yet (no replies matched to this domain).');
    for (const t of threads) {
      const offer = t.last_reply && OFFER_RE.test(t.last_reply) ? ' ⚠ POSSIBLE OFFER — needs your input' : '';
      const weOwe = t.last_reply_at && (!t.last_out_at || new Date(t.last_reply_at) > new Date(t.last_out_at));
      const next = weOwe ? 'next: respond (draft pending approval)' : `next: ${t.last_out_variant === 'closing-nudge-48h' ? 'sequence done — your call' : 'nudge when 24h quiet'}`;
      lines.push(`- ${t.name}${t.company ? ` (${t.company})` : ''} <${t.email}> — last reply: "${(t.last_reply ?? '').slice(0, 100)}" — ${next}${offer}`);
    }

    const pending = await sql`
      SELECT e.id, e.subject, e.variant, l.email
      FROM emails e INNER JOIN leads l ON l.id = e.lead_id
      WHERE e.domain = ${asset.domain} AND e.variant LIKE 'closing%' AND e.status = 'pending'` as { id: number; subject: string; variant: string; email: string }[];
    if (pending.length) {
      lines.push(`AWAITING YOUR APPROVAL (${pending.length}):`);
      for (const p of pending) lines.push(`- #${p.id} [${p.variant}] to ${p.email}: "${p.subject}"`);
    }
  }

  const dmTasks = await sql`SELECT channel, url, handle, title FROM dm_tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5` as { channel: string; url: string; handle: string | null; title: string | null }[];
  if (dmTasks.length) {
    lines.push('');
    lines.push(`DM TASKS — manual outreach (${dmTasks.length} pending):`);
    for (const t of dmTasks) {
      lines.push(`- [${t.channel}]${t.handle ? ` u/${t.handle}` : ''} "${t.title}" → ${t.url}`);
      lines.push(`  Done/dismiss: ${config.baseUrl.replace(/\/$/, '')}/api/task/done?dm=${encodeURIComponent(t.url)}`);
    }
  }

  type RelayRow = { variant_domain: string; target_domain: string; registered_on: string | null; is_live: boolean; relay_url: string; suggested_message: string };
  const relays = await sql`SELECT variant_domain, target_domain, registered_on, is_live, relay_url, suggested_message FROM relay_leads WHERE status = 'pending' ORDER BY is_live DESC, created_at DESC LIMIT 5` as RelayRow[];
  if (relays.length) {
    lines.push('');
    lines.push(`REGISTRANT RELAY LEADS — manual, ~60s each (${relays.length} pending):`);
    for (const r of relays) {
      const held = r.registered_on ? ` (held since ${new Date(r.registered_on).getFullYear()})` : '';
      lines.push(`- ${r.variant_domain}${held}${r.is_live ? ' [LIVE SITE]' : ''} → owner is a prospect for ${r.target_domain}`);
      lines.push(`  Relay form: ${r.relay_url}`);
      lines.push(`  Message to paste:\n  ${r.suggested_message.split('\n').join('\n  ')}`);
      lines.push(`  ✓ Mark sent: ${config.baseUrl.replace(/\/$/, '')}/api/task/done?relay=${encodeURIComponent(r.variant_domain)}`);
    }
  }

  const intents = await sql`SELECT domain, email, budget_usd, summary FROM buyer_intent WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 10` as { domain: string; email: string | null; budget_usd: number | null; summary: string | null }[];
  if (intents.length) {
    lines.push('');
    lines.push(`BUYER INTENT CAPTURED (last 24h): ${intents.length}`);
    for (const i of intents) lines.push(`- ${i.domain}${i.email ? ` <${i.email}>` : ''}${i.budget_usd ? ` budget ~$${i.budget_usd.toLocaleString()}` : ''}: ${i.summary ?? ''}`);
  }

  const variants = await getVariantPerformance();
  const withReplies = variants.filter(v => v.replied > 0);
  if (withReplies.length) {
    lines.push('');
    lines.push('VARIANT PERFORMANCE (variants with replies):');
    for (const v of withReplies) lines.push(`- ${v.variant} on ${v.domain}: ${v.replied}/${v.sent} replied (${v.reply_rate})`);
  }

  const offers = await sql`SELECT domain, name, email, amount, status, created_at FROM storefront_offers WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC` as { domain: string; name: string | null; email: string; amount: number; status: string; created_at: string }[];
  if (offers.length) {
    lines.push('');
    lines.push(`STOREFRONT OFFERS (last 24h): ${offers.length}`);
    for (const o of offers) lines.push(`- ${o.domain}: $${o.amount.toLocaleString()} from ${o.name ?? '?'} <${o.email}> — ${o.status}`);
  }

  const sentToday = Number(((await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE AND result = 'ok'`)[0] as { c: string | number }).c ?? 0);
  lines.push('');
  lines.push(`Sent today: ${sentToday}`);
  return lines.join('\n');
}

export async function sendDailyReport(): Promise<{ sent: boolean }> {
  const report = await generateDailyReport();
  await alertOwner(`Daily domain sales report — ${new Date().toISOString().slice(0, 10)}`, report);
  return { sent: true };
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
  const remaining = Math.min((await getEffectiveDailyLimit()) - sentToday, await getSendCapacityToday());
  if (remaining <= 0) return { sent: 0, failed: 0 };

  const queue = (await buildSendQueue()).slice(0, remaining);
  let sent = 0; let failed = 0;

  for (const email of queue) {
    const lead = await getSendTarget(email);
    if (!lead) { failed++; continue; }
    try {
      await dispatchEmail(email, lead);
      sent++;
    } catch (e) {
      await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, ${`error: ${(e as Error).message}`})`;
      failed++;
    }
    await sleep(10000 + Math.random() * 5000);
  }
  return { sent, failed };
}

type SendItem = { id: number; lead_id: number; domain: string; subject: string; body: string; sequence_day: number; variant: string };

// Closing-mode emails (warm replied leads) go first, then day-1 by tier/score, then due follow-ups.
async function buildSendQueue(): Promise<SendItem[]> {
  const closing = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day, e.variant
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.variant LIKE 'closing%' AND l.status = 'replied'
    ORDER BY l.tier ASC, l.score DESC
  ` as SendItem[];

  const warmFirst = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day, e.variant
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.variant = 'warmfirst' AND l.status NOT IN ('blocked', 'unsubscribed', 'bounced')
    ORDER BY l.tier ASC, l.score DESC NULLS LAST
  ` as SendItem[];

  const day1 = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day, e.variant
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day = 1 AND e.variant NOT IN ('warmfirst') AND e.variant NOT LIKE 'closing%' AND l.status = 'enriched'
    ORDER BY l.tier ASC, l.score DESC
  ` as SendItem[];

  type FollowUpRow = SendItem & { day1_sent: Date | string | null };
  const dueFollowUpsAll = await sql`
    SELECT e.id, e.lead_id, e.domain, e.subject, e.body, e.sequence_day, e.variant,
           (SELECT MAX(e2.sent_at) FROM emails e2 WHERE e2.lead_id = e.lead_id AND e2.status = 'sent' AND e2.sequence_day = 1) as day1_sent
    FROM emails e INNER JOIN leads l ON l.id = e.lead_id
    WHERE e.status = 'approved' AND e.sequence_day > 1 AND l.status = 'contacted'
    ORDER BY l.tier ASC, l.score DESC
  ` as FollowUpRow[];
  // Max one follow-up per lead per day — when day1 is old, several days become
  // "due" at once and would otherwise all fire in the same run.
  const due = dueFollowUpsAll
    .filter(e => {
      if (!e.day1_sent) return false;
      const daysPassed = (Date.now() - new Date(e.day1_sent as string).getTime()) / 86400000;
      return daysPassed >= e.sequence_day - 1;
    })
    .sort((a, b) => a.sequence_day - b.sequence_day);
  const seenLead = new Set<number>();
  const dueFollowUps = due.filter(e => {
    if (seenLead.has(e.lead_id)) return false;
    seenLead.add(e.lead_id);
    return true;
  });

  return [...closing, ...warmFirst, ...day1, ...dueFollowUps];
}

// Resolves the recipient and enforces the blacklist at the last line of defense.
async function getSendTarget(email: SendItem): Promise<{ name: string; email: string } | null> {
  const leadRows = await sql`SELECT name, email, source FROM leads WHERE id = ${email.lead_id}`;
  const lead = leadRows[0] as { name: string; email: string; source: string | null } | undefined;
  if (!lead) return null;
  if (isBlockedLead(lead.email, lead.source)) {
    await sql`UPDATE emails SET status = 'rejected' WHERE id = ${email.id}`;
    await sql`INSERT INTO send_log (email_id, result) VALUES (${email.id}, 'blocked: blacklisted lead')`;
    return null;
  }
  return lead;
}

async function dispatchEmail(email: SendItem, lead: { name: string; email: string }): Promise<void> {
  const isClosing = email.variant.startsWith('closing');
  // Warm negotiation replies thread into the existing Gmail conversation, no unsubscribe footer
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let fromAccount: string | undefined;
  if (isClosing) {
    const replyRows = await sql`SELECT gmail_thread_id, rfc_message_id, gmail_account FROM replies WHERE lead_id = ${email.lead_id} ORDER BY received_at DESC LIMIT 1` as { gmail_thread_id: string | null; rfc_message_id: string | null; gmail_account: string | null }[];
    threadId = replyRows[0]?.gmail_thread_id ?? undefined;
    inReplyTo = replyRows[0]?.rfc_message_id ?? undefined;
    fromAccount = replyRows[0]?.gmail_account ?? undefined;
  }
  const body = isClosing
    ? email.body
    : `${email.body}\n\n---\nTo unsubscribe: ${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(lead.email)}`;

  const { from } = await sendViaGmail({ to: lead.email, subject: email.subject, body, threadId, inReplyTo, from: fromAccount });
  await sql`UPDATE emails SET status = 'sent', sent_at = NOW() WHERE id = ${email.id}`;
  // warmfirst recipients are already 'replied' — don't downgrade them to 'contacted'
  if (email.sequence_day === 1 && !isClosing && email.variant !== 'warmfirst') await sql`UPDATE leads SET status = 'contacted' WHERE id = ${email.lead_id}`;
  await sql`INSERT INTO send_log (email_id, result, gmail_account) VALUES (${email.id}, 'ok', ${from})`;
}

// ── SEND (streaming) ──────────────────────────────────────────────────────────

type Emitter = (data: object) => void;

export async function sendApprovedStream(emit: Emitter): Promise<void> {
  const sentTodayRows = await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`;
  const sentToday = Number((sentTodayRows[0] as { c: string | number }).c ?? 0);
  const dailyLimit = await getEffectiveDailyLimit();
  const capacity = await getSendCapacityToday();
  const remaining = Math.min(dailyLimit - sentToday, capacity);

  if (remaining <= 0) {
    emit({ type: 'log', message: capacity <= 0 ? 'All connected mailboxes have hit their daily cap.' : `Daily limit of ${dailyLimit} already reached.` });
    return;
  }

  const queue = (await buildSendQueue()).slice(0, remaining);

  emit({ type: 'log', message: `Sending ${queue.length} emails across mailboxes (limit: ${dailyLimit}, mailbox capacity: ${capacity} — ${remaining} to send)` });

  let sent = 0; let failed = 0;

  for (const email of queue) {
    const lead = await getSendTarget(email);
    if (!lead) {
      failed++;
      emit({ type: 'failed', message: `✗ lead #${email.lead_id}: blocked or missing` });
      continue;
    }
    const label = email.variant.startsWith('closing') ? email.variant : email.sequence_day > 1 ? `Day ${email.sequence_day} follow-up` : 'Day 1';
    try {
      await dispatchEmail(email, lead);
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

// ── COMP SALES ────────────────────────────────────────────────────────────────
// Real aftermarket sales scraped from DNJournal's public charts. Replaces
// "Claude remembers some comps" with observed market data for pricing and audits.

export async function scrapeCompSales(): Promise<{ inserted: number; scanned: number; error?: string }> {
  const urls = [
    'https://www.dnjournal.com/ytd-sales-charts.htm',
    'https://www.dnjournal.com/domainsales.htm',
  ];
  let inserted = 0; let scanned = 0;
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
        timeout: 15000,
      });
      const $ = cheerio.load(res.data as string);
      const text = $('body').text();
      // "domain.tld ... $123,456" pairs — venue is whatever sits between
      const re = /\b([a-z0-9][a-z0-9-]{0,40}\.[a-z]{2,6})\b[^$\n]{0,60}?\$\s?([\d,]{3,12})/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const domain = m[1].toLowerCase();
        const price = parseInt(m[2].replace(/,/g, ''), 10);
        if (!price || price < 100 || price > 100000000) continue;
        if (/dnjournal|sitemap|\.(htm|html|php|asp)$/i.test(domain)) continue;
        scanned++;
        const rows = await sql`
          INSERT INTO comp_sales (domain, price, venue, source)
          VALUES (${domain}, ${price}, ${null}, 'dnjournal')
          ON CONFLICT (domain) DO NOTHING RETURNING id`;
        if (rows.length) inserted++;
      }
    } catch (e) { errors.push(`${url}: ${(e as Error).message}`); }
    await sleep(800);
  }
  return { inserted, scanned, error: errors.length ? errors.join('; ') : undefined };
}

// Comps relevant to a domain: shared keywords first, then same TLD in a similar price band
export async function getRelevantComps(domain: string, askingPrice: number): Promise<string[]> {
  const base = domain.split('.')[0];
  const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[-_]/).join(' ').split(' ');
  const keywords = [...new Set([base, ...words.filter(w => w.length > 3)])];

  const patterns = keywords.map(k => `%${k}%`);
  const byKeyword = await sql`
    SELECT domain, price FROM comp_sales
    WHERE domain ILIKE ANY(${patterns})
    ORDER BY ABS(price - ${askingPrice}) ASC LIMIT 4` as { domain: string; price: number }[];

  const tld = domain.split('.').pop() ?? 'com';
  const byBand = await sql`
    SELECT domain, price FROM comp_sales
    WHERE domain LIKE ${'%.' + tld} AND price BETWEEN ${Math.round(askingPrice * 0.3)} AND ${askingPrice * 10}
    ORDER BY ABS(price - ${askingPrice}) ASC LIMIT 4` as { domain: string; price: number }[];

  const seen = new Set<string>();
  return [...byKeyword, ...byBand]
    .filter(c => { if (seen.has(c.domain)) return false; seen.add(c.domain); return true; })
    .slice(0, 5)
    .map(c => `${c.domain} sold for $${c.price.toLocaleString()}`);
}

// ── BUYER BOOK ────────────────────────────────────────────────────────────────
// The accumulating clientele: every contact who ever replied, chatted on a
// storefront, or made an offer. New domains pitch these warm contacts first —
// the same compounding asset brokers call their "buyer network".

export async function getBuyerBook() {
  return await sql`
    SELECT l.id, l.name, l.email, l.company, l.source, l.status,
      (SELECT string_agg(DISTINCT e.domain, ', ') FROM emails e WHERE e.lead_id = l.id AND e.status = 'sent') as pitched_domains,
      (SELECT MAX(r.received_at) FROM replies r WHERE r.lead_id = l.id) as last_reply_at,
      (SELECT MAX(o.amount) FROM storefront_offers o WHERE LOWER(o.email) = LOWER(l.email)) as best_offer,
      (SELECT g.responder_type FROM engagement_log g WHERE g.lead_id = l.id AND g.responder_type IS NOT NULL ORDER BY g.created_at DESC LIMIT 1) as responder_type,
      (SELECT bi.summary FROM buyer_intent bi WHERE bi.lead_id = l.id OR LOWER(bi.email) = LOWER(l.email) ORDER BY bi.created_at DESC LIMIT 1) as intent_summary,
      (SELECT bi.budget_usd FROM buyer_intent bi WHERE bi.lead_id = l.id OR LOWER(bi.email) = LOWER(l.email) ORDER BY bi.created_at DESC LIMIT 1) as stated_budget
    FROM leads l
    WHERE l.status NOT IN ('blocked', 'unsubscribed', 'bounced')
      AND (
        l.status = 'replied'
        OR EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = l.id)
        OR EXISTS (SELECT 1 FROM storefront_offers o WHERE LOWER(o.email) = LOWER(l.email))
        OR l.source LIKE 'storefront:%'
      )
    ORDER BY last_reply_at DESC NULLS LAST`;
}

// Pitch a domain to buyer-book contacts who haven't seen it yet — warm before cold.
export async function writeWarmFirstEmails(targetDomains?: string[]): Promise<{ written: number; skipped: number }> {
  const portfolio = loadPortfolio(targetDomains);
  type BookRow = { id: number; name: string; email: string; company: string | null; source: string; responder_type: string | null; best_offer: number | null };
  const book = await getBuyerBook() as BookRow[];
  let written = 0; let skipped = 0;

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    for (const contact of book) {
      // Skip registrar/marketplace employees — they're data, not buyers
      if (contact.responder_type === 'registrar') { skipped++; continue; }
      const already = await sql`SELECT id FROM emails WHERE lead_id = ${contact.id} AND domain = ${asset.domain}`;
      if (already.length) { skipped++; continue; }

      try {
        const res = await client.messages.create({
          model: config.model, max_tokens: 400,
          messages: [{ role: 'user', content: `Write a short warm email to someone who previously engaged with us about buying a domain — they ${contact.source.startsWith('storefront') ? 'visited a sales page and ' + (contact.best_offer ? `made an offer of $${contact.best_offer.toLocaleString()}` : 'asked questions') : 'replied to an earlier email'}. Now a different domain they might like is available.

Contact: ${contact.name}${contact.company ? ` @ ${contact.company}` : ''}
New domain: ${asset.domain} — $${asset.asking_price.toLocaleString()}
${analysis ? `Pitch: ${analysis.one_liner}` : `Description: ${asset.description}`}
${config.baseUrl.includes('localhost') ? '' : `Link: ${config.baseUrl}/buy/${asset.domain}`}

Rules: under 70 words, reference that you spoke before (warm, not cold), one low-friction CTA, include the link if provided, sign as ${config.fromName}, no fluff.

Return JSON only: {"subject": "...", "body": "..."}` }],
        });
        const text = res.content[0].type === 'text' ? res.content[0].text : '';
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { subject: string; body: string };
        await sql`INSERT INTO emails (lead_id, domain, subject, body, variant, status, sequence_day) VALUES (${contact.id}, ${asset.domain}, ${parsed.subject}, ${parsed.body}, 'warmfirst', 'approved', 1)`;
        written++;
      } catch { skipped++; }
      await sleep(300);
    }
  }
  return { written, skipped };
}

// ── CONVERSATIONAL INTENT (the data marketplaces can't collect) ───────────────
// Mines storefront chat transcripts into structured buyer intent: budget,
// timing, use case, objections. A marketplace knows someone searched "club
// domains"; this knows they said "I'd do $3k if payment splits over two months".

export async function extractChatIntent(): Promise<{ extracted: number; skipped: number }> {
  type SessionRow = { session_id: string; domain: string };
  const sessions = await sql`
    SELECT DISTINCT c.session_id, c.domain
    FROM storefront_chats c
    WHERE NOT EXISTS (SELECT 1 FROM buyer_intent bi WHERE bi.source = 'chat' AND bi.ref_id = c.session_id)
    GROUP BY c.session_id, c.domain
    HAVING COUNT(*) FILTER (WHERE c.role = 'user') >= 2
  ` as SessionRow[];

  let extracted = 0; let skipped = 0;
  for (const s of sessions) {
    const msgs = await sql`SELECT role, content FROM storefront_chats WHERE session_id = ${s.session_id} ORDER BY id` as { role: string; content: string }[];
    const transcript = msgs.map(m => `${m.role === 'user' ? 'BUYER' : 'AGENT'}: ${m.content}`).join('\n');
    const email = transcript.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase() ?? null;

    try {
      const res = await client.messages.create({
        model: config.model, max_tokens: 400,
        messages: [{ role: 'user', content: `Extract structured buyer intent from this domain-sale chat transcript.

Domain discussed: ${s.domain}
"""
${transcript.slice(0, 4000)}
"""

Return JSON only (null for anything not stated):
{"budget_usd": <number or null>, "timing": "when they'd buy, or null", "use_case": "what they'd build, or null", "objections": "their concerns/blockers, or null", "summary": "one sentence on where this buyer stands"}` }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
      const intent = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as { budget_usd: number | null; timing: string | null; use_case: string | null; objections: string | null; summary: string | null };
      const leadRows = email ? await sql`SELECT id FROM leads WHERE LOWER(email) = ${email}` as { id: number }[] : [];
      await sql`
        INSERT INTO buyer_intent (source, ref_id, lead_id, email, domain, budget_usd, timing, use_case, objections, summary)
        VALUES ('chat', ${s.session_id}, ${leadRows[0]?.id ?? null}, ${email}, ${s.domain}, ${intent.budget_usd}, ${intent.timing}, ${intent.use_case}, ${intent.objections}, ${intent.summary})
        ON CONFLICT (source, ref_id) DO NOTHING`;
      extracted++;
    } catch { skipped++; }
    await sleep(300);
  }
  return { extracted, skipped };
}

// ── VARIANT PERFORMANCE (the experiment loop) ─────────────────────────────────
// Which pitch angles actually get replies, per domain. Reads the engagement the
// system already records — no extra instrumentation.

export async function getVariantPerformance() {
  const rows = await sql`
    SELECT e.variant, e.domain, COUNT(*) as sent,
      COUNT(DISTINCT e.lead_id) FILTER (
        WHERE EXISTS (SELECT 1 FROM replies r WHERE r.lead_id = e.lead_id AND r.received_at > e.sent_at)
      ) as replied,
      COUNT(DISTINCT e.lead_id) FILTER (
        WHERE EXISTS (SELECT 1 FROM leads l2 WHERE l2.id = e.lead_id AND l2.status = 'unsubscribed')
      ) as unsubscribed
    FROM emails e
    WHERE e.status = 'sent'
    GROUP BY e.variant, e.domain
    ORDER BY sent DESC` as { variant: string; domain: string; sent: string | number; replied: string | number; unsubscribed: string | number }[];

  return rows.map(r => ({
    variant: r.variant,
    domain: r.domain,
    sent: Number(r.sent),
    replied: Number(r.replied),
    unsubscribed: Number(r.unsubscribed),
    reply_rate: Number(r.sent) ? `${(100 * Number(r.replied) / Number(r.sent)).toFixed(1)}%` : '0%',
  }));
}

// ── REDDIT WTB ────────────────────────────────────────────────────────────────
// People publicly posting "want to buy a domain" — highest free intent there is.
// Uses the existing Reddit JSON scraper with keywords from the domain analyses.

export async function redditWtbLeads(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; found: number; dmTasks: number; via: string; error?: string }> {
  const portfolio = loadPortfolio(targetDomains);
  const kwSet = new Set<string>();
  for (const asset of portfolio) {
    const base = asset.domain.split('.')[0].toLowerCase();
    kwSet.add(base);
    const suffix = base.match(/(club|app|hub|lab|shop|store)$/i)?.[1];
    if (suffix) { kwSet.add(suffix); kwSet.add(base.slice(0, -suffix.length)); }
    const analysis = await getDomainAnalysis(asset.domain);
    if (analysis) {
      [...analysis.industries, ...analysis.use_cases]
        .flatMap(s => s.toLowerCase().split(/[\s,/&]+/))
        .filter(w => w.length > 3)
        .slice(0, 20)
        .forEach(w => kwSet.add(w));
    }
  }
  // Direct first (free); Reddit blocks all scraper IPs (datacenter AND residential,
  // verified) — fall back to discovering WTB posts via Google SERP as manual DM tasks.
  const direct = await scrapeRedditJSON(kwSet);
  const leads = direct.leads;
  let dmPosts: { title: string; url: string }[] = [];
  let via = 'direct';
  let error = direct.error;
  if (!leads.length && direct.error?.includes('403') && config.apifyApiKey) {
    // Only the domain's own niche words signal relevance — drop generic domain jargon
    // so "looking for a non-alcoholic beer domain" doesn't surface for indikaclub.com.
    const generic = new Set(['domain', 'domains', 'name', 'names', 'brand', 'brands', 'website', 'online', 'business', 'company', 'premium', 'digital']);
    const relevantKws = [...kwSet].filter(w => w.length > 3 && !generic.has(w));
    const serp = await discoverRedditWtbViaGoogle(relevantKws);
    dmPosts = serp.dmPosts;
    via = 'google-serp';
    error = serp.error;
  }

  const targetLabel = portfolio.map(a => a.domain).join(', ');
  let dmTasks = 0;
  for (const p of dmPosts) {
    const rows = await sql`
      INSERT INTO dm_tasks (channel, url, handle, title, target_domain)
      VALUES ('reddit', ${p.url}, ${null}, ${p.title}, ${targetLabel})
      ON CONFLICT (url) DO NOTHING RETURNING id`;
    if (rows.length) dmTasks++;
  }

  const { inserted, skipped } = await upsertLeads(leads);
  return { inserted, skipped, found: leads.length, dmTasks, via, error };
}

// Reddit WTB discovery via Google SERP (Apify google-search-scraper). Yields
// post URL + title for a manual DM — posts rarely contain emails anyway.
async function discoverRedditWtbViaGoogle(relevantKws: string[] = []): Promise<{ dmPosts: { title: string; url: string }[]; error?: string }> {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const queries = [
    `site:reddit.com/r/domainnames (WTB OR buying OR "looking for") after:${since}`,
    `site:reddit.com/r/Domains (WTB OR "want to buy" OR "looking for") after:${since}`,
    `site:reddit.com "looking for a domain" after:${since}`,
  ].join('\n');

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${config.apifyApiKey}`,
      { queries, resultsPerPage: 20, maxPagesPerQuery: 1, languageCode: 'en', countryCode: 'us' },
      { timeout: 20000 }
    );
    const runId: string = runRes.data?.data?.id;
    if (!runId) return { dmPosts: [], error: 'Apify SERP run failed to start' };

    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const status: string = st.data?.data?.status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') break;
    }

    const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    type SerpItem = { organicResults?: { title?: string; url?: string }[] };
    const items = itemsRes.data as SerpItem[];

    const seen = new Set<string>();
    const intentRe = /\b(wtb|want(ing)? to buy|looking for|need(ing)?|searching for|help me find|suggest(ions)? for|buy(ing)?)\b/i;
    const dmPosts: { title: string; url: string }[] = [];
    for (const item of items) {
      for (const r of item.organicResults ?? []) {
        if (!r.url || !/reddit\.com\/r\/[^/]+\/comments\//i.test(r.url) || seen.has(r.url)) continue;
        const title = (r.title ?? '').replace(/ : r\/\w+.*$/i, '').slice(0, 200);
        // Only actual purchase intent about domain NAMES — SERPs return plenty of adjacent noise
        if (!intentRe.test(title) || !/domain|\.com\b|brand name/i.test(title)) continue;
        if (/co-?founder|job|hire|hiring|career|hosting|email|expert|engineer|developer|course|learn/i.test(title)) continue;
        // Relevance gate: the post must touch the domain's actual niche, else it's a
        // domain-buying post for something unrelated (beer, an expired .com, etc.)
        if (relevantKws.length && !relevantKws.some(kw => title.toLowerCase().includes(kw))) continue;
        seen.add(r.url);
        dmPosts.push({ title, url: r.url });
      }
    }
    return { dmPosts };
  } catch (e) {
    return { dmPosts: [], error: (e as Error).message };
  }
}

// ── HACKER NEWS WTB ───────────────────────────────────────────────────────────
// Founders in a naming moment ask HN for help ("Ask HN: what should I name…",
// "looking for a domain"). Free Algolia API — no scraping, no anti-bot. Each post
// is matched against the WHOLE portfolio's niche keywords and surfaced as a manual
// DM task tagged with whichever domains fit, so it scales with inventory.
type HnHit = { objectID: string; title?: string; url?: string | null; author?: string; story_text?: string | null; comment_text?: string | null };

export async function hackerNewsWtbLeads(targetDomains?: string[]): Promise<{ found: number; dmTasks: number; matched: number; error?: string }> {
  const portfolio = loadPortfolio(targetDomains);
  const generic = new Set(['domain', 'domains', 'name', 'names', 'brand', 'brands', 'website', 'online', 'business', 'company', 'premium', 'digital', 'startup', 'startups', 'product']);
  const domainKws: { domain: string; kws: string[] }[] = [];
  for (const asset of portfolio) {
    const base = asset.domain.split('.')[0].toLowerCase();
    const kw = new Set<string>([base]);
    const suffix = base.match(/(club|app|hub|lab|shop|store)$/i)?.[1];
    if (suffix) { kw.add(suffix); kw.add(base.slice(0, -suffix.length)); }
    const analysis = await getDomainAnalysis(asset.domain);
    if (analysis) {
      [...analysis.industries, ...analysis.use_cases]
        .flatMap(s => s.toLowerCase().split(/[\s,/&]+/))
        .filter(w => w.length > 3)
        .slice(0, 20)
        .forEach(w => kw.add(w));
    }
    domainKws.push({ domain: asset.domain, kws: [...kw].filter(w => w.length > 3 && !generic.has(w)) });
  }

  const since = Math.floor(Date.now() / 1000) - 21 * 86400;
  // Active seeking only — passive mentions ("domain name", "brand name") match
  // meta-discussion about domains, not people who actually want one.
  const intentRe = /\b(buy(ing)? a domain|register(ing)? a domain|looking for a (domain|name)|need a (domain|name)|what (should i|to) (call|name)|name for (my|our|a)|help (me )?name|suggest(ions)? for a name|naming (my|our|a) (startup|company|product|brand|app|tool|project))\b/i;
  const queries = ['domain name', 'what should i name', 'name for my', 'looking for a domain', 'naming my startup'];

  const hits = new Map<string, HnHit>();
  try {
    for (const q of queries) {
      const res = await axios.get('https://hn.algolia.com/api/v1/search_by_date', {
        params: { query: q, tags: 'story', numericFilters: `created_at_i>${since}`, hitsPerPage: 50, advancedSyntax: true },
        timeout: 15000,
      });
      for (const h of (res.data?.hits ?? []) as HnHit[]) if (h.objectID) hits.set(h.objectID, h);
      await sleep(300);
    }
  } catch (e) {
    return { found: 0, dmTasks: 0, matched: 0, error: (e as Error).message };
  }

  let dmTasks = 0;
  let matched = 0;
  for (const h of hits.values()) {
    const title = (h.title ?? '').replace(/<[^>]+>/g, ' ');
    // Show/Launch HN are finished products, not someone seeking a name — skip them
    if (/^\s*(show|launch)\s+hn/i.test(title)) continue;
    const text = `${title} ${h.story_text ?? ''} ${h.comment_text ?? ''}`.replace(/<[^>]+>/g, ' ');
    if (!intentRe.test(text)) continue;
    // Relevance matches the TITLE only — the body is too noisy and yields false hits
    const lcTitle = title.toLowerCase();
    const fit = domainKws.filter(d => d.kws.some(kw => lcTitle.includes(kw))).map(d => d.domain);
    if (!fit.length) continue;
    matched++;
    const url = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const rows = await sql`
      INSERT INTO dm_tasks (channel, url, handle, title, target_domain)
      VALUES ('hn', ${url}, ${h.author ?? null}, ${(h.title ?? 'HN post').slice(0, 200)}, ${fit.join(', ')})
      ON CONFLICT (url) DO NOTHING RETURNING id`;
    if (rows.length) dmTasks++;
  }
  return { found: hits.size, dmTasks, matched };
}

// ── X / TWITTER WTB ───────────────────────────────────────────────────────────
// Founders/brands occasionally post naming or domain intent on X. Direct search via
// Apify (kaito pay-per-result scraper — no X auth needed). Matched against the
// portfolio's niche and surfaced as manual DM tasks, same as Reddit/HN.
type XTweet = { url?: string; twitterUrl?: string; text?: string; createdAt?: string; author?: { userName?: string } };

export async function xWtbLeads(targetDomains?: string[]): Promise<{ found: number; dmTasks: number; matched: number; error?: string }> {
  if (!config.apifyApiKey) return { found: 0, dmTasks: 0, matched: 0, error: 'no apify key' };
  const portfolio = loadPortfolio(targetDomains);
  const generic = new Set(['domain', 'domains', 'name', 'names', 'brand', 'brands', 'website', 'online', 'business', 'company', 'premium', 'digital', 'startup', 'startups', 'product']);
  const domainKws: { domain: string; kws: string[] }[] = [];
  for (const asset of portfolio) {
    const base = asset.domain.split('.')[0].toLowerCase();
    const kw = new Set<string>([base]);
    const suffix = base.match(/(club|app|hub|lab|shop|store)$/i)?.[1];
    if (suffix) { kw.add(suffix); kw.add(base.slice(0, -suffix.length)); }
    const analysis = await getDomainAnalysis(asset.domain);
    if (analysis) {
      [...analysis.industries, ...analysis.use_cases]
        .flatMap(s => s.toLowerCase().split(/[\s,/&]+/))
        .filter(w => w.length > 3).slice(0, 20).forEach(w => kw.add(w));
    }
    domainKws.push({ domain: asset.domain, kws: [...kw].filter(w => w.length > 3 && !generic.has(w)) });
  }

  // Niche-scoped search terms with a since: operator so X only returns recent tweets
  // (raw search otherwise dredges up years-old posts). Intent + relevance gates below.
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const queries = ['cbd brand name', 'cannabis brand name', 'naming my cbd', 'looking for a cannabis domain', 'need a name for my cbd']
    .map(q => `${q} since:${since}`);
  let tweets: XTweet[] = [];
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest/run-sync-get-dataset-items?token=${config.apifyApiKey}`,
      { searchTerms: queries, maxItems: 60, sort: 'Latest', tweetLanguage: 'en' },
      { timeout: 120000 }
    );
    tweets = (res.data as XTweet[]).filter(t => t && t.text);
  } catch (e) { return { found: 0, dmTasks: 0, matched: 0, error: (e as Error).message }; }

  // First-person seeking only — bare "rebranding" matched news headlines and jokes.
  const intentRe = /\b(looking for a (domain|name)|need a (domain|name) for (my|our)|what (should i|to) (call|name)|name for (my|our) (brand|company|dispensary|shop|line|startup|cbd|cannabis)|help me name (my|our)|suggest(ions)? for a (name|domain)|naming (my|our) (brand|company|dispensary|shop|line|startup))\b/i;
  const cutoff = Date.now() - 130 * 86400000;
  const seen = new Set<string>();
  let matched = 0; let dmTasks = 0;
  for (const tw of tweets) {
    const text = (tw.text ?? '').replace(/\s+/g, ' ');
    const url = tw.url ?? tw.twitterUrl;
    if (!url || seen.has(url) || /^rt @/i.test(text) || !intentRe.test(text)) continue;
    const ts = tw.createdAt ? Date.parse(tw.createdAt) : NaN;
    if (!Number.isNaN(ts) && ts < cutoff) continue; // recency backstop
    const lc = text.toLowerCase();
    const fit = domainKws.filter(d => d.kws.some(kw => lc.includes(kw))).map(d => d.domain);
    if (!fit.length) continue;
    seen.add(url); matched++;
    const rows = await sql`
      INSERT INTO dm_tasks (channel, url, handle, title, target_domain)
      VALUES ('x', ${url}, ${tw.author?.userName ?? null}, ${text.slice(0, 200)}, ${fit.join(', ')})
      ON CONFLICT (url) DO NOTHING RETURNING id`;
    if (rows.length) dmTasks++;
  }
  return { found: tweets.length, dmTasks, matched };
}

// ── DAILY INGEST CHAIN ────────────────────────────────────────────────────────
// Time-budgeted front-of-funnel run for cron: find fresh buyers for closing-mode
// domains, then enrich → match → write → decide. Every step is resumable, so
// whatever doesn't fit in the budget completes on the next run.

export async function runDailyIngestChain(budgetMs = 270000): Promise<Record<string, unknown>> {
  const start = Date.now();
  const left = () => budgetMs - (Date.now() - start);
  const out: Record<string, unknown> = {};

  const closing = activeClosingAssets().map(a => a.domain);
  const targets = closing.length ? closing : undefined;

  out.metrics = await computeDomainMetrics().catch(e => ({ error: (e as Error).message }));
  out.ignored = await markIgnoredOutcomes().catch(e => ({ error: (e as Error).message }));
  out.comps = await scrapeCompSales().catch(e => ({ error: (e as Error).message }));
  out.warmfirst = await writeWarmFirstEmails(targets).catch(e => ({ error: (e as Error).message }));
  // testNewSources (job-title spray) disabled: for brandable .coms it matches anyone
  // with a vaguely-related title (e.g. every Pilates studio owner) — demographic, not
  // intent. Use the intent-based sources below (funding/rebrand triggers, upgrade,
  // name-match, Reddit WTB) which target buyers in an actual naming moment.
  if (left() > 90000) out.upgrade = await findUpgradeBuyers(targets, Math.min(60000, left() - 60000));
  if (left() > 90000) out.namematch = await findCompanyNameMatches(targets);
  if (left() > 90000) out.triggers = await findTriggerLeads(targets).catch(e => ({ error: (e as Error).message }));
  if (left() > 90000) out.reddit = await redditWtbLeads(targets).catch(e => ({ error: (e as Error).message }));
  if (left() > 60000) out.hn = await hackerNewsWtbLeads(targets).catch(e => ({ error: (e as Error).message }));
  if (left() > 60000) out.x = await xWtbLeads(targets).catch(e => ({ error: (e as Error).message }));
  // Note: the Google Maps business scraper runs in its own cron (/api/cron/business)
  // — its scrapeContacts run is too slow (~4min) to sit inside this chain.
  if (left() > 90000) out.enrich = await enrichLeads();
  if (left() > 60000) out.match = await matchDomains(targets);
  if (left() > 40000) out.write = await writeEmails(left() - 20000);
  if (left() > 10000) out.decide = await decideAndApprove();
  out.elapsedMs = Date.now() - start;
  return out;
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
