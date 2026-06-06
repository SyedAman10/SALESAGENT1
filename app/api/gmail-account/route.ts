import { getConnectedAccount, disconnectAccount } from '@/lib/gmail';
import { NextResponse } from 'next/server';

export async function GET() {
  const account = await getConnectedAccount();
  return NextResponse.json(account ?? { email: null });
}

export async function DELETE() {
  await disconnectAccount();
  return NextResponse.json({ ok: true });
}
