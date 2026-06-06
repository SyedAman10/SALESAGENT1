import { NextResponse } from 'next/server';
import axios from 'axios';
import { config } from '@/lib/config';

export async function GET() {
  const results: Record<string, unknown> = {};

  // 1. Apollo: people search by title
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { person_titles: ['Domain Broker', 'Domain Advisor'], per_page: 5, page: 1 },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people = res.data?.people ?? [];
    results.apollo_title = {
      ok: true,
      total: res.data?.total_entries,
      returned: people.length,
      sample: people.slice(0, 2).map((p: Record<string, unknown>) => ({
        name: `${p.first_name} ${p.last_name_obfuscated ?? p.last_name}`,
        title: p.title,
        company: (p.organization as Record<string, unknown>)?.name,
        has_email: p.has_email,
        email: p.email ?? null,
      })),
    };
  } catch (e) {
    results.apollo_title = { error: (e as { response?: { data: unknown }; message: string }).response?.data ?? (e as Error).message };
  }

  // 2. Apollo: search by org name (domain marketplace company)
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { q_organization_name: 'Sedo', per_page: 5, page: 1 },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people = res.data?.people ?? [];
    results.apollo_sedo = {
      ok: true,
      total: res.data?.total_entries,
      returned: people.length,
      sample: people.slice(0, 2).map((p: Record<string, unknown>) => ({
        name: `${p.first_name} ${p.last_name_obfuscated ?? p.last_name}`,
        title: p.title,
        has_email: p.has_email,
        email: p.email ?? null,
      })),
    };
  } catch (e) {
    results.apollo_sedo = { error: (e as { response?: { data: unknown }; message: string }).response?.data ?? (e as Error).message };
  }

  // 3. Apollo: organization_domains reverse lookup (the core mechanic)
  try {
    const res = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      {
        organization_domains: ['sedo.com'],
        person_seniority: ['owner', 'founder', 'c_suite'],
        per_page: 5,
        page: 1,
      },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people = res.data?.people ?? [];
    results.apollo_domain_reverse = {
      ok: true,
      note: 'organization_domains: [sedo.com] — finds people whose company IS at sedo.com',
      total: res.data?.total_entries,
      returned: people.length,
      sample: people.slice(0, 2).map((p: Record<string, unknown>) => ({
        name: `${p.first_name} ${p.last_name_obfuscated ?? p.last_name}`,
        title: p.title,
        has_email: p.has_email,
        email: p.email ?? null,
      })),
    };
  } catch (e) {
    results.apollo_domain_reverse = { error: (e as { response?: { data: unknown }; message: string }).response?.data ?? (e as Error).message };
  }

  // 4. Apollo: bulk_match to reveal emails
  try {
    const searchRes = await axios.post(
      'https://api.apollo.io/api/v1/mixed_people/api_search',
      { person_titles: ['Domain Broker'], per_page: 3, page: 1 },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
    );
    const people = searchRes.data?.people ?? [];
    const toReveal = people.filter((p: Record<string, unknown>) => p.has_email && p.id);
    if (toReveal.length > 0) {
      const revealRes = await axios.post(
        'https://api.apollo.io/api/v1/people/bulk_match',
        { reveal_personal_emails: true, details: toReveal.slice(0, 2).map((p: Record<string, unknown>) => ({ id: p.id, reveal_personal_emails: true })) },
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apolloApiKey } }
      );
      const matched = revealRes.data?.matches ?? revealRes.data?.people ?? [];
      results.bulk_match = {
        ok: true,
        attempted: toReveal.length,
        returned: matched.length,
        emails_found: matched.filter((p: Record<string, unknown>) => p.email).length,
        sample: matched.slice(0, 2).map((p: Record<string, unknown>) => ({ name: p.first_name, email: p.email ?? 'none' })),
      };
    } else {
      results.bulk_match = { skipped: 'no has_email leads in title search sample' };
    }
  } catch (e) {
    results.bulk_match = { error: (e as { response?: { data: unknown }; message: string }).response?.data ?? (e as Error).message };
  }

  // 5. GoDaddy Auctions direct scrape test
  try {
    const res = await axios.get('https://auctions.godaddy.com/trpItemListing.aspx?mitype=expiry&miCat=&keyword=club&Submit=Search', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://auctions.godaddy.com/',
      },
      timeout: 15000,
    });
    const html = res.data as string;
    const domainRe = /\b([a-z0-9][a-z0-9-]{2,50}\.(com|net|org|io|co|club|app))\b/gi;
    const matches = [...new Set((html.match(domainRe) ?? []).filter(d => !d.includes('godaddy') && !d.includes('example')))].slice(0, 10);
    results.godaddy_auctions = { ok: true, status: res.status, html_length: html.length, domains_found: matches.length, sample: matches };
  } catch (e) {
    results.godaddy_auctions = { error: (e as { response?: { status: number }; message: string }).response?.status ?? (e as Error).message };
  }

  // 6. Apify account check
  try {
    const res = await axios.get(`https://api.apify.com/v2/users/me?token=${config.apifyApiKey}`);
    results.apify = { ok: true, plan: res.data?.data?.plan?.id, monthlyUsage: res.data?.data?.monthlyUsage };
  } catch (e) {
    results.apify = { error: (e as { response?: { data: unknown }; message: string }).response?.data ?? (e as Error).message };
  }

  // 7. Config sanity check
  results.config = {
    apollo_key_set: !!config.apolloApiKey,
    apollo_key_prefix: config.apolloApiKey?.slice(0, 6) + '...',
    apify_key_set: !!config.apifyApiKey,
    anthropic_key_set: !!config.anthropicApiKey,
    google_client_id_set: !!config.googleClientId,
    from_name: config.fromName,
  };

  return NextResponse.json(results, { status: 200 });
}
