import { NextRequest, NextResponse } from 'next/server';
import { getWarmupStatus, startWarmup, stopWarmup, addSeed, removeSeed, sendWarmupBatch } from '@/lib/warmup';

export async function GET() {
  const status = await getWarmupStatus();
  return NextResponse.json(status);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: string; email?: string };
  switch (body.action) {
    case 'start': await startWarmup(); return NextResponse.json({ ok: true });
    case 'stop': await stopWarmup(); return NextResponse.json({ ok: true });
    case 'add-seed': {
      if (!body.email) return NextResponse.json({ error: 'email required' }, { status: 400 });
      await addSeed(body.email.trim().toLowerCase());
      return NextResponse.json({ ok: true });
    }
    case 'remove-seed': {
      if (!body.email) return NextResponse.json({ error: 'email required' }, { status: 400 });
      await removeSeed(body.email);
      return NextResponse.json({ ok: true });
    }
    case 'send': {
      const result = await sendWarmupBatch();
      return NextResponse.json({ ok: true, ...result });
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
