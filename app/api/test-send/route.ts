import { NextRequest, NextResponse } from 'next/server';
import { sendViaGmail } from '@/lib/gmail';
import { sql } from '@/lib/db';

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const to = req.nextUrl.searchParams.get('to');
  const from = req.nextUrl.searchParams.get('from');

  const accounts = await sql`SELECT email FROM gmail_accounts WHERE is_active = true ORDER BY created_at ASC` as { email: string }[];

  if (!to) {
    return NextResponse.json({
      instructions: 'Add ?to=<mail-tester-address>&from=<account> to send a test. Use ?from= with one of the accounts below. Repeat with a fresh mail-tester address for each account.',
      accounts: accounts.map(a => a.email),
      example: `?to=test-xxx@srv1.mail-tester.com&from=${accounts[0]?.email ?? 'your@gmail.com'}`,
    });
  }

  const subject = 'Quick thought on your brand domain';
  const body = `Hi there,

I came across your company and wanted to reach out about a domain that could be a strong fit for your brand — indikaclub.com.

It's short, memorable, and available. A lot of companies in the wellness and lifestyle space are picking up category-defining .com domains before the market tightens up. This one is priced at $3,900.

Would it make sense to have a quick conversation about it?

Best,
Syed`;

  try {
    const result = await sendViaGmail({ to, subject, body, from: from ?? undefined });
    return NextResponse.json({ ok: true, from: result.from, to });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
