import { NextRequest, NextResponse } from 'next/server';
import { sendViaGmail } from '@/lib/gmail';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get('to');
  if (!to) return NextResponse.json({ error: 'missing ?to=' }, { status: 400 });

  const subject = 'Quick thought on your brand domain';
  const body = `Hi there,

I came across your company and wanted to reach out about a domain that could be a strong fit for your brand — indikaclub.com.

It's short, memorable, and available. A lot of companies in the wellness and lifestyle space are picking up category-defining .com domains before the market tightens up. This one is priced at $3,900.

Would it make sense to have a quick conversation about it?

Best,
Syed`;

  try {
    const result = await sendViaGmail({ to, subject, body });
    return NextResponse.json({ ok: true, from: result.from, to, subject });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
