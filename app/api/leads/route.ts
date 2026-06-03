import { NextRequest, NextResponse } from 'next/server';
import { getLeads } from '@/lib/pipeline';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const leads = getLeads(status);
  return NextResponse.json(leads);
}

export async function PATCH(req: NextRequest) {
  const { id, status } = await req.json() as { id: number; status: string };
  const db = getDb();
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
  if (status === 'unsubscribed') {
    db.prepare(`UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND status = 'approved'`).run(id);
  }
  return NextResponse.json({ ok: true });
}
