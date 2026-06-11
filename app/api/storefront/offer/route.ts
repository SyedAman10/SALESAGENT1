import { NextRequest, NextResponse } from 'next/server';
import { evaluateOffer } from '@/lib/storefront';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { domain, name, email, amount, message } = await req.json() as { domain: string; name?: string; email: string; amount: number; message?: string };
    if (!domain || !email?.includes('@') || !amount || amount <= 0) {
      return NextResponse.json({ ok: false, error: 'Valid email and amount required' }, { status: 400 });
    }
    const result = await evaluateOffer({ domain: domain.toLowerCase(), name, email, amount: Math.round(amount), message });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
