import { getDb } from './lib/db';

const db = getDb();

const blocklist = ['bank','financial','insurance','automotive','siemens','renault','volkswagen',
  'sligro','food group','pharma','hospital','university','government','ministry',
  'telecom','airline','retail','supermarket','logistics','consulting'];

const leads = db.prepare('SELECT id, company FROM leads').all() as { id: number; company: string | null }[];

let removed = 0;
for (const lead of leads) {
  const company = (lead.company ?? '').toLowerCase();
  if (blocklist.some(t => company.includes(t))) {
    db.prepare('DELETE FROM emails WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM lead_domain_matches WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
    removed++;
  }
}

// Reset no_match leads so they get re-matched with the improved prompt
const reset = db.prepare(`UPDATE leads SET status = 'enriched' WHERE status = 'no_match'`).run();
db.prepare(`DELETE FROM lead_domain_matches WHERE lead_id IN (SELECT id FROM leads WHERE status = 'enriched')`).run();
db.prepare(`DELETE FROM emails WHERE lead_id IN (SELECT id FROM leads WHERE status = 'enriched') AND sequence_day = 1`).run();

console.log(`Removed ${removed} corporate non-domain leads`);
console.log(`Reset ${reset.changes} no_match leads for re-matching`);
console.log(`Remaining leads: ${(db.prepare('SELECT COUNT(*) as c FROM leads').get() as { c: number }).c}`);
