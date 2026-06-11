import { NextRequest, NextResponse } from 'next/server';
import { storefrontChat } from '@/lib/storefront';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { domain, sessionId, message } = await req.json() as { domain: string; sessionId: string; message: string };
    if (!domain || !sessionId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing fields' }, { status: 400 });
    }
    const reply = await storefrontChat(domain.toLowerCase(), sessionId.slice(0, 64), message.trim());
    return NextResponse.json({ ok: true, reply });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
