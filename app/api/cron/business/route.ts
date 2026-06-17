import { NextResponse } from 'next/server';
import { testApifyApollo } from '@/lib/pipeline';

export const maxDuration = 300;

// Dedicated slot for the Google Maps business scraper — its scrapeContacts run is
// too slow (~4 min) to share the daily ingest chain. Leads it inserts are picked up
// by the next ingest run's enrich → match → write.
export async function GET() {
  const result = await testApifyApollo(undefined, 60000);
  console.log('[cron:business]', JSON.stringify(result.breakdown));
  return NextResponse.json({ ok: true, ...result });
}
