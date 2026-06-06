import { NextRequest, NextResponse } from 'next/server';
import { generateBrokerPitches } from '@/lib/pipeline';

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const domains = req.nextUrl.searchParams.getAll('domain');
  try {
    const pitches = await generateBrokerPitches(domains.length ? domains : undefined);
    return NextResponse.json({ ok: true, pitches });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
