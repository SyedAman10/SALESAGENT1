import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
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

  // Industry searches — requires domain root keyword + industry term to match together
  // Filters results to companies whose name/domain actually contains the root keyword
  const root = asset.domain.split('.')[0];
  const rootParts = root.match(/[a-z]{3,}/gi) ?? [root];
  for (const industry of analysis.industries.slice(0, 3)) {
    for (const kw of rootParts.slice(0, 2)) {
      try {
        const res = await axios.post(
          'https://api.apollo.io/api/v1/mixed_people/api_search',
          {
            q_keywords: `${kw} ${industry}`,
            person_seniority: ['owner', 'founder', 'c_suite'],
            organization_num_employees_ranges: ['1,10', '11,50', '51,200'],
            per_page: 25,
            page: 1,
          },
          { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
        );
        const people: ApolloPersonResult[] = res.data?.people ?? [];
        // Keep only people whose company name or domain actually contains our keyword
        const relevant = people.filter(p => {
          const co = (p.organization?.name ?? '').toLowerCase();
          const dom = (p.organization?.primary_domain ?? '').toLowerCase();
          return co.includes(kw) || dom.includes(kw);
        });
        const withEmail = relevant.filter(p => p.email?.includes('@'));
        const toReveal = relevant.filter(p => p.has_email && !p.email).slice(0, 6);
        const revealed = toReveal.length ? await revealEmails(toReveal) : [];
        for (const p of [...withEmail, ...revealed].filter(p => p.email)) {
          leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `apollo:${asset.domain}-industry`, raw_data: { keyword: kw, industry, title: p.title, companyDomain: p.organization?.primary_domain } });
        }
      } catch { /* continue */ }
      await sleep(400);
    }
  }

  return leads;
}

// ── MARKET SCRAPERS (domain-specific) ────────────────────────────────────────

// Master coordinator: runs all market sources for a single domain in parallel
async function scrapeAllMarketSources(asset: Asset, analysis: DomainAnalysis): Promise<RawLead[]> {
  const results = await Promise.allSettled([
    fetchDomainSpecificLeads(asset, analysis),     // Apollo: targeted end-user buyers + industry org search
    scrapeNameprosWanted(analysis),                // Namepros "Buy" section: explicit intent
    scrapeGoDaddyAuctions(asset, analysis),        // GoDaddy Auctions: active domain buyers
    scrapeAfternicSedo(asset, analysis),           // Afternic/Sedo: similar domain sellers → Apollo
    scrapeNameBio(asset),                          // NameBio recent sales → Apollo org lookup (no Apify)
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

// NameBio recent sales → Apollo org-domain lookup
// Finds founders/owners at companies that recently bought a similar-category domain (proven buyers)
// Uses direct HTTP scrape — no Apify
async function scrapeNameBio(asset: Asset): Promise<RawLead[]> {
  if (!config.apolloApiKey) return [];
  const leads: RawLead[] = [];
  const root = asset.domain.split('.')[0]; // "indikaclub"
  // extract sub-keywords from compound domain: "indikaclub" → ["indika", "club"]
  const parts = root.match(/[a-z]{3,}/gi) ?? [];
  const kws = [...new Set([root, ...parts])].slice(0, 2);
  const seenDomains = new Set<string>();

  for (const kw of kws) {
    try {
      const res = await axios.get(`https://namebio.com/?s=${encodeURIComponent(kw)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml' },
        timeout: 12000,
      });
      const $ = cheerio.load(res.data as string);
      const soldDomains: string[] = [];

      $('table tr, .nb-results tr, [class*="sale"] tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const txt = $(cells[0]).text().trim().toLowerCase().replace(/\s/g, '');
        if (/^[a-z0-9][a-z0-9-]{1,40}\.[a-z]{2,6}$/.test(txt) && !seenDomains.has(txt) && !txt.includes('namebio')) {
          soldDomains.push(txt);
          seenDomains.add(txt);
        }
      });

      if (soldDomains.length === 0) continue;

      // Batch Apollo org-domain lookup — find founders/CEOs at companies using those domains
      const batch = soldDomains.slice(0, 15);
      const aRes = await axios.post(
        'https://api.apollo.io/api/v1/mixed_people/api_search',
        { organization_domains: batch, person_seniority: ['owner', 'founder', 'c_suite'], per_page: 25, page: 1 },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const people: ApolloPersonResult[] = aRes.data?.people ?? [];
      const withEmail = people.filter(p => p.email?.includes('@'));
      const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 8);
      const revealed = toReveal.length ? await revealEmails(toReveal) : [];
      for (const p of [...withEmail, ...revealed].filter(p => p.email)) {
        leads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: `namebio:${kw}`, raw_data: { keyword: kw, targetDomain: asset.domain, companyDomain: p.organization?.primary_domain } });
      }
    } catch { /* continue */ }
    await sleep(700);
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

// Namepros + domain forums: scrape via Apify web-scraper (Playwright), fallback to direct HTTP
async function scrapeNameprosProfiles(): Promise<RawLead[]> {
  const [apifyLeads, directLeads] = await Promise.allSettled([
    scrapeViaApify(),
    scrapeForumsDirect(),
  ]);
  const out: RawLead[] = [];
  if (apifyLeads.status === 'fulfilled') out.push(...apifyLeads.value);
  if (directLeads.status === 'fulfilled') out.push(...directLeads.value);
  return out;
}

async function scrapeViaApify(): Promise<RawLead[]> {
  if (!config.apifyApiKey) return [];

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~playwright-scraper/runs?token=${config.apifyApiKey}`,
      {
        startUrls: [
          { url: 'https://www.namepros.com/forums/domains-for-sale.26/' },
          { url: 'https://www.namepros.com/forums/buy-domains.141/' },
          { url: 'https://www.namepros.com/forums/domain-name-discussion.67/' },
        ],
        pageFunction: `async function pageFunction({ page, request, enqueueLinks }) {
          const emailRegex = /[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g;
          const results = [];
          const skipDomains = ['namepros.com','example.com','sentry.io','cloudflare.com','google.com'];

          const text = await page.evaluate(() => document.body.innerText);
          const found = text.match(emailRegex) || [];
          found.forEach(email => {
            if (!skipDomains.some(d => email.includes(d))) {
              results.push({ email, sourceUrl: request.url });
            }
          });

          const profileLinks = await page.evaluate(() => {
            return [...document.querySelectorAll('a[href*="/members/"]')]
              .map(a => a.href)
              .filter(h => h && !h.includes('?'))
              .slice(0, 25);
          });
          await enqueueLinks({ urls: [...new Set(profileLinks)], label: 'profile' });

          if (request.label === 'profile') {
            const name = await page.evaluate(() => (document.querySelector('h1.username, .p-title-value') || {innerText: ''}).innerText.trim());
            const about = await page.evaluate(() => (document.querySelector('.memberAbout, .p-body-pageContent') || {innerText: ''}).innerText);
            const website = await page.evaluate(() => { const a = document.querySelector('a[href*="://"]'); return a ? a.href : ''; });
            const emails = about.match(emailRegex) || [];
            emails.forEach(email => {
              if (!skipDomains.some(d => email.includes(d))) {
                results.push({ name, email, website, sourceUrl: request.url });
              }
            });
          }
          return results;
        }`,
        proxyConfiguration: { useApifyProxy: true },
        maxRequestsPerCrawl: 15,
        maxConcurrency: 2,
      },
      { timeout: 15000 }
    );

    const runId: string = runRes.data?.data?.id;
    if (!runId) return [];

    for (let i = 0; i < 36; i++) {
      await sleep(5000);
      const statusRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
      const s: string = statusRes.data?.data?.status;
      if (s === 'SUCCEEDED') break;
      if (s === 'FAILED' || s === 'ABORTED') return [];
    }

    const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
    const items = itemsRes.data as { name?: string; email?: string; website?: string; sourceUrl?: string }[];
    return items
      .filter(r => r.email?.includes('@'))
      .map(r => ({ name: r.name ?? r.email!.split('@')[0], email: r.email!, source: 'apify:namepros', raw_data: r as object }));

  } catch (err) {
    console.error('[Apify]', (err as Error).message);
    return [];
  }
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

export async function testNewSources(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; breakdown: Record<string, number>; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);

    // NameBio
    try {
      const namebioLeads = await scrapeNameBio(asset);
      for (const l of namebioLeads) {
        if (l.email && l.source && !seen.has(l.email)) { seen.add(l.email); allLeads.push(l); breakdown[l.source] = (breakdown[l.source] ?? 0) + 1; }
      }
    } catch (e) { errors[`namebio:${asset.domain}`] = (e as Error).message; }

    if (!analysis) { errors[`apollo-industry:${asset.domain}`] = 'no analysis — run Analyze first'; continue; }

    // Apollo industry search — requires domain root keyword + industry together, filters by company relevance
    const assetRoot = asset.domain.split('.')[0];
    const assetParts = assetRoot.match(/[a-z]{3,}/gi) ?? [assetRoot];
    for (const industry of analysis.industries.slice(0, 3)) {
      for (const kw of assetParts.slice(0, 2)) {
        try {
          const res = await axios.post(
            'https://api.apollo.io/api/v1/mixed_people/api_search',
            { q_keywords: `${kw} ${industry}`, person_seniority: ['owner', 'founder', 'c_suite'], organization_num_employees_ranges: ['1,10', '11,50', '51,200'], per_page: 25, page: 1 },
            { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
          );
          const people: ApolloPersonResult[] = res.data?.people ?? [];
          const relevant = people.filter(p => {
            const co = (p.organization?.name ?? '').toLowerCase();
            const dom = (p.organization?.primary_domain ?? '').toLowerCase();
            return co.includes(kw) || dom.includes(kw);
          });
          const withEmail = relevant.filter(p => p.email?.includes('@'));
          const toReveal = relevant.filter(p => p.has_email && !p.email).slice(0, 6);
          const revealed = toReveal.length ? await revealEmails(toReveal) : [];
          for (const p of [...withEmail, ...revealed].filter(p => p.email)) {
            if (!seen.has(p.email!)) {
              seen.add(p.email!);
              const src = `apollo:${asset.domain}-industry`;
              breakdown[src] = (breakdown[src] ?? 0) + 1;
              allLeads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email!, company: p.organization?.name, linkedin_url: p.linkedin_url, source: src, raw_data: { keyword: kw, industry, title: p.title } });
            }
          }
        } catch (e) { errors[`apollo-industry:${kw}:${industry}`] = (e as Error).message; }
        await sleep(400);
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  return { inserted, skipped, breakdown, errors };
}

export async function testApifyApollo(targetDomains?: string[]): Promise<{ inserted: number; skipped: number; sources: Record<string, number>; breakdown: Record<string, number>; errors: Record<string, string> }> {
  const portfolio = loadPortfolio(targetDomains);
  const allLeads: RawLead[] = [];
  const seen = new Set<string>();
  const breakdown: Record<string, number> = { 'sedo:direct': 0, 'afternic:apify': 0, 'expireddomains:apify': 0, 'apollo:reverse': 0, 'apollo:direct': 0 };
  const errors: Record<string, string> = {};

  for (const asset of portfolio) {
    const analysis = await getDomainAnalysis(asset.domain);
    const rootKw = asset.domain.split('.')[0];
    const industryKws = analysis?.industries.slice(0, 2).map(i => i.split(' ')[0]) ?? [];
    const keywords = [...new Set([rootKw, ...industryKws])].filter(k => k.length > 2).slice(0, 3);

    const discoveredDomains: string[] = [];
    const domainRe = /^[a-z0-9][a-z0-9-]{1,50}\.(com|net|org|io|co|club|app|us|biz|info)$/i;

    // ── Phase 1a: Sedo marketplace search — direct HTTP ─────────────────────
    for (const kw of keywords.slice(0, 2)) {
      try {
        const res = await axios.get(
          `https://sedo.com/search/searchresult.php4?keyword=${encodeURIComponent(kw)}&language=e&searchOptions=2`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': 'https://sedo.com/',
            },
            timeout: 12000,
          }
        );
        const $ = cheerio.load(res.data as string);
        let found = 0;
        $('td, .domain, [class*="domain"], a').each((_, el) => {
          const txt = $(el).text().trim().toLowerCase().split(/\s+/)[0];
          if (domainRe.test(txt) && !txt.includes('sedo')) { discoveredDomains.push(txt); found++; }
        });
        breakdown['sedo:direct'] = (breakdown['sedo:direct'] ?? 0) + found;
      } catch (e) {
        errors[`sedo:${kw}`] = (e as Error).message;
      }
      await sleep(800);
    }

    // ── Phase 1c: Afternic + GoDaddy Auctions via Apify (JS-rendered) ─────────
    if (config.apifyApiKey) {
      const auctionUrls = [
        ...keywords.slice(0, 2).map(kw => ({ url: `https://www.afternic.com/forsale?q=${encodeURIComponent(kw)}`, site: 'afternic' })),
        ...keywords.slice(0, 1).map(kw => ({ url: `https://www.expireddomains.net/domain-name-search/?q=${encodeURIComponent(kw)}&fwhois=22&fdomain=1`, site: 'expireddomains' })),
      ];

      try {
        const runRes = await axios.post(
          `https://api.apify.com/v2/acts/apify~playwright-scraper/runs?token=${config.apifyApiKey}`,
          {
            startUrls: auctionUrls.map(u => ({ url: u.url, userData: { site: u.site } })),
            pageFunction: `async function pageFunction({ page, request }) {
              const site = (request.userData || {}).site || 'unknown';
              await page.waitForTimeout(6000);
              const skipHosts = ['afternic.com','godaddy.com','apify.com','cloudflare.com','google.com','sedo.com','verisign.com','icann.org'];
              const re = /\\b([a-z0-9][a-z0-9-]{1,50}\\.(com|net|org|io|co|club|app|us|biz|info))\\b/gi;
              const text = await page.evaluate(() => document.body ? document.body.innerText : '');
              const found = [...new Set((text.match(re) || []).map(d => d.toLowerCase()))]
                .filter(d => !skipHosts.some(s => d.endsWith(s) || d.includes('.' + s)));
              return found.slice(0, 50).map(d => ({ domain: d, site }));
            }`,
            proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
            navigationTimeoutSecs: 60,
            maxRequestRetries: 2,
            maxRequestsPerCrawl: auctionUrls.length,
            maxConcurrency: 2,
          },
          { timeout: 20000 }
        );

        const runId: string = runRes.data?.data?.id;
        if (runId) {
          for (let i = 0; i < 72; i++) { // up to 6 min
            await sleep(5000);
            const st = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${config.apifyApiKey}`);
            const s: string = st.data?.data?.status;
            if (s === 'SUCCEEDED' || s === 'FAILED' || s === 'ABORTED') break;
          }
          const itemsRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${config.apifyApiKey}`);
          (itemsRes.data as { domain?: string; site?: string }[]).forEach(item => {
            if (item.domain) {
              discoveredDomains.push(item.domain);
              const key = item.site === 'expireddomains' ? 'expireddomains:apify' : 'afternic:apify';
              breakdown[key] = (breakdown[key] ?? 0) + 1;
            }
          });
        }
      } catch (e) {
        errors['apify:auctions'] = (e as Error).message;
        console.error('[Apify auctions]', (e as Error).message);
      }
    }

    // ── Phase 2: Apollo reverse lookup on all discovered domains (cap 15) ──────
    // organization_domains finds people whose company website IS that domain → potential buyers upgrading
    const uniqueDomains = [...new Set(discoveredDomains)].slice(0, 15);
    for (const domain of uniqueDomains) {
      const leads = await apolloReverseFromDomain(domain, 'marketplace:apollo');
      for (const l of leads) {
        if (l.email && !seen.has(l.email)) { seen.add(l.email); allLeads.push(l); breakdown['apollo:reverse']++; }
      }
      await sleep(350);
    }

    // ── Phase 3: Apollo direct search — targeted queries from domain analysis ──
    // This is the most reliable path: find founders/CMOs in relevant industries
    if (config.apolloApiKey) {
      const queries = analysis
        ? await generateSearchQueries(asset, analysis)
        : [{ titles: ['Founder', 'CEO', 'Co-Founder', 'CMO'], keywords: asset.domain.split('.')[0], seniority: ['founder', 'c_suite'] }];

      for (const q of queries.slice(0, 3)) {
        try {
          const res = await axios.post(
            'https://api.apollo.io/api/v1/mixed_people/api_search',
            {
              person_titles: q.titles,
              person_seniority: q.seniority.length ? q.seniority : undefined,
              q_keywords: q.keywords || undefined,
              per_page: 25,
              page: 1,
            },
            { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
          );
          const people: ApolloPersonResult[] = res.data?.people ?? [];
          const withEmail = people.filter(p => p.email?.includes('@'));
          const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 15);
          const revealed = toReveal.length ? await revealEmails(toReveal) : [];
          for (const p of [...withEmail, ...revealed]) {
            if (p.email && !seen.has(p.email)) {
              seen.add(p.email);
              allLeads.push({
                name: [p.first_name, p.last_name].filter(Boolean).join(' '),
                email: p.email,
                company: p.organization?.name,
                linkedin_url: p.linkedin_url,
                source: `apollo:direct:${asset.domain}`,
                raw_data: p,
              });
              breakdown['apollo:direct']++;
            }
          }
        } catch (e) {
          errors[`apollo:direct:${q.keywords}`] = (e as Error).message;
        }
        await sleep(400);
      }

      // ── Phase 3b: Apollo domain broker / investor search (always run) ────────
      const brokerSearches = [
        { titles: ['Domain Broker', 'Domain Advisor', 'Domain Investor'], keywords: '' },
        { titles: ['Director', 'VP', 'Head'], keywords: 'domain acquisitions' },
        { titles: ['Brand Strategist', 'Naming Consultant'], keywords: 'domain' },
      ];
      for (const s of brokerSearches) {
        try {
          const res = await axios.post(
            'https://api.apollo.io/api/v1/mixed_people/api_search',
            { person_titles: s.titles, q_keywords: s.keywords || undefined, per_page: 25, page: 1 },
            { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
          );
          const people: ApolloPersonResult[] = res.data?.people ?? [];
          const withEmail = people.filter(p => p.email?.includes('@'));
          const toReveal = people.filter(p => p.has_email && !p.email).slice(0, 10);
          const revealed = toReveal.length ? await revealEmails(toReveal) : [];
          for (const p of [...withEmail, ...revealed]) {
            if (p.email && !seen.has(p.email)) {
              seen.add(p.email);
              allLeads.push({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.email, company: p.organization?.name, linkedin_url: p.linkedin_url, source: 'apollo:broker', raw_data: p });
              breakdown['apollo:direct']++;
            }
          }
        } catch (e) {
          errors[`apollo:broker:${s.titles[0]}`] = (e as Error).message;
        }
        await sleep(500);
      }
    }
  }

  const { inserted, skipped } = await upsertLeads(allLeads);
  const sources: Record<string, number> = {};
  for (const l of allLeads) { const src = l.source ?? 'unknown'; sources[src] = (sources[src] ?? 0) + 1; }
  return { inserted, skipped, sources, breakdown, errors };
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
  return targetDomains?.length ? all.filter(a => targetDomains.includes(a.domain)) : all;
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
  const leads = await sql`SELECT DISTINCT l.id, l.name, l.email, l.company, l.enrichment, l.raw_data FROM leads l INNER JOIN lead_domain_matches ldm ON ldm.lead_id = l.id WHERE l.status = 'enriched' AND l.id NOT IN (SELECT DISTINCT lead_id FROM emails WHERE sequence_day = 1)` as (LeadRow & { raw_data: string })[];
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

  return `Write a cold domain sales email. Sound like a real person, not a template.

Recipient: ${lead.name}${lead.company ? ` @ ${lead.company}` : ''}
Buyer signals: ${enrichment.key_signals.join('; ')}
Domain fit: ${match.domain} — ${match.relevance_reasoning}${domainInsights}${companySnippet}
Price placeholder: [PRICE]

Style: ${variantInstructions[variant as keyof typeof variantInstructions]}

Rules (strict):
- Under 100 words total
- Subject: 3–6 words, name the domain or their company specifically, no buzzwords (bad: "domain opportunity", good: "${match.domain} — quick question")
- Reference ONE specific thing about their business from the company snippet or buyer signals
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
  const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: { user: config.smtp.user, pass: config.smtp.pass } });

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
      await transport.sendMail({ from: `"${config.fromName}" <${config.fromEmail}>`, to: lead.email, bcc: config.fromEmail, subject: email.subject, text: bodyWithFooter });
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
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });

  const sentTodayRows = await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`;
  const sentToday = Number((sentTodayRows[0] as { c: string | number }).c ?? 0);
  const remaining = config.dailySendLimit - sentToday;

  if (remaining <= 0) {
    emit({ type: 'log', message: `Daily limit of ${config.dailySendLimit} already reached.` });
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

  emit({ type: 'log', message: `Sending ${queue.length} emails (${day1.length} new + ${dueFollowUps.length} follow-ups due, limit: ${remaining} remaining today)` });

  let sent = 0; let failed = 0;

  for (const email of queue) {
    const leadRows = await sql`SELECT name, email FROM leads WHERE id = ${email.lead_id}`;
    const lead = leadRows[0] as { name: string; email: string };
    const label = email.sequence_day > 1 ? `Day ${email.sequence_day} follow-up` : 'Day 1';
    const bodyWithFooter = `${email.body}\n\n---\nTo unsubscribe: ${config.baseUrl}/api/unsubscribe?email=${encodeURIComponent(lead.email)}`;
    try {
      await transport.sendMail({ from: `"${config.fromName}" <${config.fromEmail}>`, to: lead.email, bcc: config.fromEmail, subject: email.subject, text: bodyWithFooter });
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

interface LeadRow { id: number; name: string; email: string; company: string | null; raw_data: string; enrichment: string; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
