import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { sql } from './db';
import { config } from './config';
import { sendViaGmail } from './gmail';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface StorefrontAsset {
  domain: string;
  category: string;
  asking_price: number;
  description: string;
  deadline?: string;
  floor_price?: number;
}

export function getStorefrontAsset(domain: string): StorefrontAsset | null {
  const p = path.join(process.cwd(), 'domains.json');
  const all: StorefrontAsset[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : [];
  return all.find(a => a.domain === domain.toLowerCase()) ?? null;
}

export async function getAnalysisSummary(domain: string): Promise<{ one_liner: string; value_props: string[]; comparable_sales: string[] } | null> {
  const rows = await sql`SELECT analysis FROM domain_analyses WHERE domain = ${domain}`;
  if (!rows[0]) return null;
  const a = JSON.parse((rows[0] as { analysis: string }).analysis) as { one_liner: string; value_props: string[]; comparable_sales: string[] };
  return { one_liner: a.one_liner, value_props: a.value_props ?? [], comparable_sales: a.comparable_sales ?? [] };
}

async function upsertEngagedContact(email: string, name: string, source: string, context: object): Promise<void> {
  await sql`
    INSERT INTO leads (name, email, company, linkedin_url, source, raw_data, status, tier)
    VALUES (${name}, ${email.toLowerCase()}, ${null}, ${null}, ${source}, ${JSON.stringify(context)}, 'replied', 1)
    ON CONFLICT (email) DO UPDATE SET
      status = CASE WHEN leads.status IN ('blocked', 'unsubscribed', 'bounced') THEN leads.status ELSE 'replied' END,
      tier = 1`;
}

async function alert(subject: string, body: string): Promise<void> {
  if (!config.reportEmail) return;
  try { await sendViaGmail({ to: config.reportEmail, subject, body }); }
  catch (e) { console.error('[storefront alert]', (e as Error).message); }
}

// ── OFFER EVALUATION ──────────────────────────────────────────────────────────
// Floor rule: at/above floor the agent can accept on the spot; below floor it
// counters and the owner is alerted either way.

export async function evaluateOffer(input: { domain: string; name?: string; email: string; amount: number; message?: string }): Promise<{ status: string; response: string }> {
  const asset = getStorefrontAsset(input.domain);
  if (!asset) return { status: 'rejected', response: 'This domain is not currently for sale.' };

  const floor = asset.floor_price ?? asset.asking_price;
  let status: string;
  let response: string;

  if (input.amount >= asset.asking_price) {
    status = 'accepted';
    response = `Deal — $${input.amount.toLocaleString()} for ${asset.domain}. I'll send the escrow and transfer details to ${input.email} within a few hours. The domain comes off the market once escrow opens.`;
  } else if (input.amount >= floor) {
    status = 'accepted';
    response = `$${input.amount.toLocaleString()} works. I'll send escrow and transfer details to ${input.email} shortly — once escrow opens the domain is yours pending transfer.`;
  } else {
    const counter = Math.max(floor, Math.round((asset.asking_price + input.amount) / 2 / 50) * 50);
    status = 'countered';
    response = `$${input.amount.toLocaleString()} is below what I can take for this one. I can do $${counter.toLocaleString()} — that's as close as I can get to your number. Want me to lock that in?`;
  }

  const rows = await sql`
    INSERT INTO storefront_offers (domain, name, email, amount, message, status, agent_response)
    VALUES (${input.domain}, ${input.name ?? null}, ${input.email}, ${input.amount}, ${input.message ?? null}, ${status}, ${response})
    RETURNING id`;

  // Buyer book: anyone who makes an offer is a proven domain buyer — keep them forever
  await upsertEngagedContact(input.email, input.name ?? input.email.split('@')[0], 'storefront:offer', { domain: input.domain, amount: input.amount });

  await alert(
    `[OFFER ${status.toUpperCase()}] $${input.amount.toLocaleString()} for ${input.domain}`,
    `Offer #${(rows[0] as { id: number }).id} via storefront\n\nFrom: ${input.name ?? 'unknown'} <${input.email}>\nAmount: $${input.amount.toLocaleString()} (asking $${asset.asking_price.toLocaleString()}, floor ${asset.floor_price ? `$${asset.floor_price.toLocaleString()}` : 'not set'})\nMessage: ${input.message ?? '—'}\n\nAgent replied: "${response}"\n\n${status === 'accepted' ? 'ACTION: send escrow/transfer details to the buyer now.' : 'Countered — no action needed unless you want to override.'}`
  );

  return { status, response };
}

// ── NEGOTIATION CHAT ──────────────────────────────────────────────────────────

const OFFER_HINT_RE = /\$\s?\d|\b\d{3,}\b|\boffer\b|\bprice\b|\bdiscount\b|\blower\b/i;

export async function storefrontChat(domain: string, sessionId: string, userMessage: string): Promise<string> {
  const asset = getStorefrontAsset(domain);
  if (!asset) return 'This domain is not currently for sale.';
  const analysis = await getAnalysisSummary(domain);

  await sql`INSERT INTO storefront_chats (session_id, domain, role, content) VALUES (${sessionId}, ${domain}, 'user', ${userMessage.slice(0, 2000)})`;

  const historyRows = await sql`SELECT role, content FROM storefront_chats WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 20` as { role: 'user' | 'assistant'; content: string }[];
  const history = historyRows.reverse();

  const floor = asset.floor_price ?? asset.asking_price;
  const deadlineNote = asset.deadline && new Date(`${asset.deadline}T23:59:59Z`).getTime() >= Date.now()
    ? `Active deadline: best offers are being reviewed by ${asset.deadline}. Use it for urgency, truthfully.`
    : 'No active deadline — do not invent one.';

  const system = `You are the sales agent for the domain ${asset.domain}, sold directly by its owner through this page. You are an AI agent and say so if asked — selling domains autonomously is the whole point.

Facts:
- Asking price: $${asset.asking_price.toLocaleString()}
- ${analysis ? `Pitch: ${analysis.one_liner}\n- Value: ${analysis.value_props.slice(0, 3).join('; ')}\n- Comparable sales: ${analysis.comparable_sales.slice(0, 3).join('; ')}` : `Description: ${asset.description}`}
- ${deadlineNote}
- Payment runs through escrow; transfer typically completes in 1-3 days.

Negotiation rules (hard):
- You may agree to any price at or above $${floor.toLocaleString()}. NEVER agree below that — say the owner won't go lower and hold.
- NEVER reveal that a minimum/floor exists or what it is. Anchor on the asking price; if their number is too low, say it won't work and invite a stronger offer — do not name the lowest acceptable figure yourself.
- If they state a number, push them to submit it via the Make an Offer form on this page (that's the binding step), or collect their email.
- Always try to get their email before the conversation ends.
- Be direct, human, brief — 1-3 sentences per reply. No fluff, no exclamation marks, no pressure tactics beyond the real deadline.
- Never claim other bidders exist unless told so here: no competing-interest claims.
- Only discuss this domain and this sale. Refuse anything else politely.`;

  let reply = "Sorry — I glitched. Ask me that again?";
  try {
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 300,
      system,
      messages: history.map(h => ({ role: h.role, content: h.content })),
    });
    reply = res.content[0].type === 'text' ? res.content[0].text : reply;
  } catch (e) {
    console.error('[storefront chat]', (e as Error).message);
  }

  await sql`INSERT INTO storefront_chats (session_id, domain, role, content) VALUES (${sessionId}, ${domain}, 'assistant', ${reply})`;

  // Buyer book: capture any email the visitor shares in chat
  const sharedEmail = userMessage.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0];
  if (sharedEmail) {
    await upsertEngagedContact(sharedEmail, sharedEmail.split('@')[0], 'storefront:chat', { domain, sessionId }).catch(() => { /* non-fatal */ });
  }

  if (OFFER_HINT_RE.test(userMessage)) {
    await alert(
      `[STOREFRONT CHAT] possible price talk — ${domain}`,
      `Session ${sessionId}\n\nVisitor: "${userMessage}"\nAgent: "${reply}"\n\nFull session in storefront_chats table.`
    );
  }

  return reply;
}
