import { getConnectedAccounts, removeAccount, setAccountActive, setAccountDailyLimit } from '@/lib/gmail';
import { NextRequest, NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ accounts: await getConnectedAccounts() });
}

export async function PATCH(req: NextRequest) {
  const { email, is_active, daily_limit } = await req.json() as { email: string; is_active?: boolean; daily_limit?: number };
  if (!email) return NextResponse.json({ ok: false, error: 'email required' }, { status: 400 });
  if (typeof is_active === 'boolean') await setAccountActive(email, is_active);
  if (typeof daily_limit === 'number') await setAccountDailyLimit(email, daily_limit);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email');
  if (!email) return NextResponse.json({ ok: false, error: 'email required' }, { status: 400 });
  await removeAccount(email);
  return NextResponse.json({ ok: true });
}
