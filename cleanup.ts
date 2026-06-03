import { sql } from './lib/db';

const blocklist = ['bank','financial','insurance','automotive','siemens','renault','volkswagen',
  'sligro','food group','pharma','hospital','university','government','ministry',
  'telecom','airline','retail','supermarket','logistics','consulting'];

async function main() {
  const leads = await sql`SELECT id, company FROM leads` as { id: number; company: string | null }[];

  let removed = 0;
  for (const lead of leads) {
    const company = (lead.company ?? '').toLowerCase();
    if (blocklist.some(t => company.includes(t))) {
      await sql`DELETE FROM emails WHERE lead_id = ${lead.id}`;
      await sql`DELETE FROM lead_domain_matches WHERE lead_id = ${lead.id}`;
      await sql`DELETE FROM leads WHERE id = ${lead.id}`;
      removed++;
    }
  }

  await sql`UPDATE leads SET status = 'enriched' WHERE status = 'no_match'`;
  await sql`DELETE FROM lead_domain_matches WHERE lead_id IN (SELECT id FROM leads WHERE status = 'enriched')`;
  await sql`DELETE FROM emails WHERE lead_id IN (SELECT id FROM leads WHERE status = 'enriched') AND sequence_day = 1`;

  const countRows = await sql`SELECT COUNT(*) as c FROM leads`;
  console.log(`Removed ${removed} corporate non-domain leads`);
  console.log(`Remaining leads: ${(countRows[0] as { c: string | number }).c}`);
}

main().catch(console.error);
