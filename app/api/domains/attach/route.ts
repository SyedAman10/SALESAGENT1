import { NextRequest, NextResponse } from 'next/server';
import { attachDomain } from '@/lib/domain-attach';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { domain } = await req.json() as { domain: string };
    if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return NextResponse.json({ ok: false, error: 'Invalid domain' }, { status: 400 });
    }
    const result = await attachDomain(domain.toLowerCase());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
