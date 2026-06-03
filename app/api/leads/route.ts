import { NextRequest, NextResponse } from 'next/server';
import { getLeads } from '@/lib/pipeline';
import { sql } from '@/lib/db';

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const leads = await getLeads(status);
  return NextResponse.json(leads);
}

export async function PATCH(req: NextRequest) {
  const { id, status } = await req.json() as { id: number; status: string };
  await sql`UPDATE leads SET status = ${status} WHERE id = ${id}`;
  if (status === 'unsubscribed') {
    await sql`UPDATE emails SET status = 'cancelled' WHERE lead_id = ${id} AND status = 'approved'`;
  }
  return NextResponse.json({ ok: true });
}
