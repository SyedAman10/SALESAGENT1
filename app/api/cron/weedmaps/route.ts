import { NextResponse } from 'next/server';
import { weedmapsLeads } from '@/lib/pipeline';

export const maxDuration = 300;

// Weedmaps dispensary harvest — its own slot (slow Apify run). Leads it inserts are
// picked up by the next ingest run's enrich → match → write.
export async function GET() {
  const result = await weedmapsLeads();
  console.log('[cron:weedmaps]', JSON.stringify(result));
  return NextResponse.json({ ok: true, ...result });
}
