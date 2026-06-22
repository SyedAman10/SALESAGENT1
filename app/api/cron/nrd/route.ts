import { NextResponse } from 'next/server';
import { newlyRegisteredLeads } from '@/lib/pipeline';

export const maxDuration = 120;

// Newly-registered-domain upgrade buyers — its own slot (downloads + LLM match).
// Surfaces matches as registrant relay leads in the Outreach tab.
export async function GET() {
  const result = await newlyRegisteredLeads();
  console.log('[cron:nrd]', JSON.stringify(result));
  return NextResponse.json({ ok: true, ...result });
}
