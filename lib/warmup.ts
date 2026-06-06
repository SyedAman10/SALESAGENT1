import { sql } from './db';
import { config } from './config';
import { sendViaGmail } from './gmail';

interface ScheduleEntry { maxDay: number; realLimit: number; warmupCount: number }

const SCHEDULE: ScheduleEntry[] = [
  { maxDay: 7,  realLimit: 5,  warmupCount: 3 },
  { maxDay: 14, realLimit: 10, warmupCount: 5 },
  { maxDay: 21, realLimit: 20, warmupCount: 8 },
  { maxDay: 28, realLimit: 35, warmupCount: 10 },
];

interface WarmupTemplate { subject: string; body: string }

function getTemplates(): WarmupTemplate[] {
  const name = config.fromName || 'Alex';
  return [
    { subject: 'Quick question', body: `Hi,\n\nHope your week is going well. I've been researching online brand building and had a quick question — how much weight do you think a company's domain name carries when making a first impression?\n\nWould genuinely love to hear your take.\n\nBest,\n${name}` },
    { subject: 'Checking in', body: `Hey,\n\nJust wanted to drop a note and say hi. Been heads-down on some projects lately and realized I haven't been great at keeping in touch.\n\nHope things are going well on your end.\n\n${name}` },
    { subject: 'Worth a read', body: `Hi,\n\nCame across something interesting this morning — a piece on how premium domain names have been outperforming other digital assets over the past few years. Happy to share the link if you're curious.\n\nHope you're having a good one.\n\n${name}` },
    { subject: 'Brief note', body: `Hey,\n\nJust a quick note — I've been thinking about how much the B2B sales landscape has shifted toward digital-first impressions. Curious if you've noticed that in your own experience.\n\nNo need to reply if you're slammed, just thought it was an interesting topic.\n\n${name}` },
    { subject: 'One thing I wanted to share', body: `Hi,\n\nI was reading about brandable domain names and their impact on business growth today and it made me think of this quote: "You can't build a reputation on what you are going to do."\n\nJust felt worth sharing. Hope the week is treating you well.\n\nBest,\n${name}` },
    { subject: 'A question for you', body: `Hi,\n\nIf you were starting a business from scratch tomorrow, how much time would you spend on choosing the right domain name? It's something I've been thinking about a lot lately.\n\nAlways interested in different perspectives on this.\n\n${name}` },
    { subject: 'Interesting perspective', body: `Hey,\n\nI've been reading a lot about digital brand equity lately — specifically around how domain names are increasingly being treated as long-term business assets rather than just web addresses.\n\nThought it might be relevant to some of what you're working on.\n\nBest,\n${name}` },
    { subject: 'Following up', body: `Hi,\n\nJust wanted to reach out and reconnect. It's been a while since we've been in touch and I thought of you when reading about trends in digital business infrastructure.\n\nHope everything is going well.\n\n${name}` },
    { subject: 'Had a thought', body: `Hey,\n\nRandom thought — do you think the companies that invest early in premium online real estate (domains, handles, etc.) have a measurable advantage over those that don't? Been debating this with a few people lately.\n\nCurious what you think.\n\n${name}` },
    { subject: 'Quick note', body: `Hi,\n\nI hope you're doing well. I wanted to reach out because I've been doing a lot of thinking about digital brand strategy and would love to exchange ideas if you're ever open to a quick chat.\n\nNo pressure at all — just always looking to learn from smart people.\n\nBest,\n${name}` },
    { subject: 'Thinking of you', body: `Hey,\n\nJust wanted to drop a note and hope you're having a great week. I've been knee-deep in work on digital assets and growth strategy — would love to reconnect sometime if you're free.\n\nHope all is well.\n\n${name}` },
    { subject: 'Something worth knowing', body: `Hi,\n\nI came across some data recently showing that businesses with short, memorable domain names see meaningfully higher direct traffic and brand recall. Nothing groundbreaking, but it was a useful reminder of the fundamentals.\n\nHope you're doing well.\n\nBest,\n${name}` },
  ];
}

function getCurrentDay(startedAt: string): number {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 86400000) + 1;
}

function getScheduleEntry(dayN: number): ScheduleEntry | null {
  return SCHEDULE.find(e => dayN <= e.maxDay) ?? null;
}

export async function getWarmupStatus(): Promise<{
  active: boolean;
  dayN: number;
  realLimit: number;
  warmupCount: number;
  startedAt: string | null;
  sentToday: number;
  warmupSentToday: number;
  seeds: string[];
  complete: boolean;
}> {
  const rows = await sql`SELECT started_at FROM warmup_config WHERE is_active = true LIMIT 1`;
  const seeds = await sql`SELECT email FROM warmup_seeds ORDER BY created_at`;
  const seedEmails = (seeds as { email: string }[]).map(r => r.email);

  if (!rows[0]) {
    return { active: false, dayN: 0, realLimit: config.dailySendLimit, warmupCount: 0, startedAt: null, sentToday: 0, warmupSentToday: 0, seeds: seedEmails, complete: false };
  }

  const startedAt = (rows[0] as { started_at: string }).started_at;
  const dayN = getCurrentDay(startedAt);
  const entry = getScheduleEntry(dayN);
  const complete = !entry;

  const sentRows = await sql`SELECT COUNT(*) as c FROM send_log WHERE sent_at::date = CURRENT_DATE`;
  const sentToday = Number((sentRows[0] as { c: string }).c ?? 0);

  const warmupRows = await sql`SELECT COUNT(*) as c FROM warmup_sends WHERE sent_at::date = CURRENT_DATE`;
  const warmupSentToday = Number((warmupRows[0] as { c: string }).c ?? 0);

  return {
    active: true,
    dayN,
    realLimit: complete ? config.dailySendLimit : entry!.realLimit,
    warmupCount: complete ? 0 : entry!.warmupCount,
    startedAt,
    sentToday,
    warmupSentToday,
    seeds: seedEmails,
    complete,
  };
}

export async function getEffectiveDailyLimit(): Promise<number> {
  const rows = await sql`SELECT started_at FROM warmup_config WHERE is_active = true LIMIT 1`;
  if (!rows[0]) return config.dailySendLimit;
  const dayN = getCurrentDay((rows[0] as { started_at: string }).started_at);
  const entry = getScheduleEntry(dayN);
  return entry ? entry.realLimit : config.dailySendLimit;
}

export async function startWarmup(): Promise<void> {
  await sql`UPDATE warmup_config SET is_active = false WHERE is_active = true`;
  await sql`INSERT INTO warmup_config (started_at, is_active) VALUES (NOW(), true)`;
}

export async function stopWarmup(): Promise<void> {
  await sql`UPDATE warmup_config SET is_active = false WHERE is_active = true`;
}

export async function addSeed(email: string): Promise<void> {
  await sql`INSERT INTO warmup_seeds (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING`;
}

export async function removeSeed(email: string): Promise<void> {
  await sql`DELETE FROM warmup_seeds WHERE email = ${email}`;
}

export async function sendWarmupBatch(): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const rows = await sql`SELECT started_at FROM warmup_config WHERE is_active = true LIMIT 1`;
  if (!rows[0]) return { sent: 0, skipped: 0, errors: ['Warmup not active'] };

  const dayN = getCurrentDay((rows[0] as { started_at: string }).started_at);
  const entry = getScheduleEntry(dayN);
  if (!entry) return { sent: 0, skipped: 0, errors: ['Warmup complete — running at full limit'] };

  const seeds = await sql`SELECT email FROM warmup_seeds ORDER BY created_at`;
  const seedEmails = (seeds as { email: string }[]).map(r => r.email);
  if (seedEmails.length === 0) return { sent: 0, skipped: 0, errors: ['No seed emails configured'] };

  const alreadySentRows = await sql`SELECT COUNT(*) as c FROM warmup_sends WHERE sent_at::date = CURRENT_DATE`;
  const alreadySent = Number((alreadySentRows[0] as { c: string }).c ?? 0);
  const toSend = Math.max(0, entry.warmupCount - alreadySent);
  if (toSend === 0) return { sent: 0, skipped: entry.warmupCount, errors: [] };

  const recentSubjects = await sql`SELECT subject FROM warmup_sends ORDER BY sent_at DESC LIMIT 20`;
  const usedSubjects = new Set((recentSubjects as { subject: string }[]).map(r => r.subject));
  const templates = getTemplates();
  const fresh = templates.filter(t => !usedSubjects.has(t.subject));
  const pool = fresh.length > 0 ? fresh : templates;

  let sent = 0;
  const errors: string[] = [];
  const targets = [...seedEmails].sort(() => Math.random() - 0.5).slice(0, toSend);

  for (const seedEmail of targets) {
    const template = pool[Math.floor(Math.random() * pool.length)];
    try {
      await sendViaGmail({ to: seedEmail, subject: template.subject, body: template.body });
      await sql`INSERT INTO warmup_sends (seed_email, subject) VALUES (${seedEmail}, ${template.subject})`;
      sent++;
      if (sent < targets.length) await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
    } catch (e) {
      errors.push(`${seedEmail}: ${(e as Error).message}`);
    }
  }

  return { sent, skipped: alreadySent, errors };
}
