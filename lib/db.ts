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
}
