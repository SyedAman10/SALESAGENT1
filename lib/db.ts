import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let _sql: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

export const sql: NeonQueryFunction<false, false> = new Proxy((() => {}) as unknown as NeonQueryFunction<false, false>, {
  apply(_target, _thisArg, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    return (getSql() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export async function initDb(): Promise<void> {
  const db = getSql();
  await db`CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    company TEXT,
    linkedin_url TEXT,
    source TEXT NOT NULL,
    raw_data TEXT NOT NULL,
    enrichment TEXT,
    score INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    tier INTEGER NOT NULL DEFAULT 2,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`ALTER TABLE leads ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 2`;
  await db`CREATE TABLE IF NOT EXISTS replies (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    gmail_message_id TEXT NOT NULL UNIQUE,
    gmail_thread_id TEXT,
    rfc_message_id TEXT,
    from_email TEXT NOT NULL,
    subject TEXT,
    snippet TEXT,
    received_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS engagement_log (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    reply_id INTEGER REFERENCES replies(id),
    domain TEXT NOT NULL,
    domain_length INTEGER,
    tld TEXT,
    asking_price INTEGER,
    ai_valuation INTEGER,
    brandability_score INTEGER,
    contact_role TEXT,
    contact_company TEXT,
    responder_type TEXT,
    responder_specialty TEXT,
    response_hours REAL,
    outcome TEXT NOT NULL,
    reasoning TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(lead_id, domain, outcome)
  )`;
  await db`CREATE TABLE IF NOT EXISTS campaign_audits (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    domain TEXT NOT NULL,
    right_contact BOOLEAN,
    price_defensible BOOLEAN,
    buyer_centric BOOLEAN,
    clear_cta BOOLEAN,
    trigger_moment BOOLEAN,
    reasoning TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(lead_id, domain)
  )`;
  await db`CREATE TABLE IF NOT EXISTS human_interventions (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    domain TEXT NOT NULL,
    human_knowledge TEXT,
    objection_handled TEXT,
    what_changed TEXT,
    outcome TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS domain_metrics (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    domain_length INTEGER NOT NULL,
    tld TEXT NOT NULL,
    keyword_type TEXT,
    brandability_score INTEGER,
    estimated_value_usd INTEGER,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS dm_tasks (
    id SERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    handle TEXT,
    title TEXT,
    target_domain TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`ALTER TABLE dm_tasks ADD COLUMN IF NOT EXISTS message TEXT`;
  await db`CREATE TABLE IF NOT EXISTS relay_leads (
    id SERIAL PRIMARY KEY,
    variant_domain TEXT NOT NULL UNIQUE,
    target_domain TEXT NOT NULL,
    registrar TEXT,
    registered_on TEXT,
    expires_on TEXT,
    is_live BOOLEAN NOT NULL DEFAULT false,
    relay_url TEXT NOT NULL,
    suggested_message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS buyer_intent (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    lead_id INTEGER REFERENCES leads(id),
    email TEXT,
    domain TEXT NOT NULL,
    budget_usd INTEGER,
    timing TEXT,
    use_case TEXT,
    objections TEXT,
    summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source, ref_id)
  )`;
  await db`CREATE TABLE IF NOT EXISTS comp_sales (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL,
    venue TEXT,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS storefront_offers (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL,
    name TEXT,
    email TEXT NOT NULL,
    amount INTEGER NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    agent_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS storefront_chats (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS lead_domain_matches (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    domain TEXT NOT NULL,
    relevance_reasoning TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(lead_id, domain)
  )`;
  await db`CREATE TABLE IF NOT EXISTS emails (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    domain TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    variant TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TIMESTAMPTZ,
    sequence_day INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS domain_analyses (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    analysis TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS send_log (
    id SERIAL PRIMARY KEY,
    email_id INTEGER NOT NULL REFERENCES emails(id),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result TEXT NOT NULL
  )`;
  await db`CREATE TABLE IF NOT EXISTS gmail_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    access_token TEXT,
    refresh_token TEXT NOT NULL,
    token_expiry TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS warmup_config (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT true
  )`;
  await db`CREATE TABLE IF NOT EXISTS warmup_seeds (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS warmup_sends (
    id SERIAL PRIMARY KEY,
    seed_email TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    subject TEXT NOT NULL
  )`;

  // Multi-mailbox rotation: track which Gmail account sent each email and
  // give each account its own active flag + per-day send cap for deliverability.
  await db`ALTER TABLE send_log ADD COLUMN IF NOT EXISTS gmail_account TEXT`;
  await db`ALTER TABLE replies ADD COLUMN IF NOT EXISTS gmail_account TEXT`;
  await db`ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`;
  await db`ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 30`;

  // Change detection for the Weedmaps source: a dispensary newly appearing (in a
  // market already scraped before) is a recency/naming signal — a likely new opening.
  await db`CREATE TABLE IF NOT EXISTS seen_dispensaries (
    id TEXT PRIMARY KEY,
    state TEXT,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}
