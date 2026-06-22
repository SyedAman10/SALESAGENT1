import { NextResponse } from 'next/server';
import { findUpgradeBuyers } from '@/lib/pipeline';

export const maxDuration = 300;

// Dedicated WHOIS/variant relay hunter — checks TLD variants of every domain in
// the portfolio for companies already invested in the brand (best outbound signal).
// Runs with a full 250s budget vs the 60s slice inside the ingest chain, so it
// covers 4-5x more of the 112-domain portfolio per run.
export async function GET() {
  const result = await findUpgradeBuyers(undefined, 250000);
  console.log('[cron:relay]', JSON.stringify(result));
  return NextResponse.json({ ok: true, ...result });
}
