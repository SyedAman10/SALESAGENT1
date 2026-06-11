import { NextResponse } from 'next/server';
import { runDailyIngestChain } from '@/lib/pipeline';

export const maxDuration = 300;

export async function GET() {
  const result = await runDailyIngestChain();
  console.log('[cron:ingest]', JSON.stringify(result));
  return NextResponse.json({ ok: true, ...result });
}
