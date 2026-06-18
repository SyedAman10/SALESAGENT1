import { NextRequest, NextResponse } from 'next/server';
import { runLeadBatch } from '@/lib/pipeline';

export const maxDuration = 300;

// Run a bounded batch of new leads through enrich → match → write → decide and
// email a per-lead cost report. Trigger: /api/cron/batch?limit=25
export async function GET(req: NextRequest) {
  const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') ?? '25', 10) || 25));
  const result = await runLeadBatch(limit);
  console.log('[cron:batch]', JSON.stringify(result));
  return NextResponse.json({ ok: true, ...result });
}
