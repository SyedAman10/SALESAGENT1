import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email');
  if (!email) return new NextResponse('Missing email', { status: 400 });

  const rows = await sql`SELECT id FROM leads WHERE LOWER(email) = LOWER(${email})`;
  const lead = rows[0] as { id: number } | undefined;

  if (lead) {
    await sql`UPDATE leads SET status = 'unsubscribed' WHERE id = ${lead.id}`;
    await sql`UPDATE emails SET status = 'cancelled' WHERE lead_id = ${lead.id} AND status = 'approved'`;
  }

  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5;}
    .box{text-align:center;max-width:400px;padding:2rem;}h1{color:#fff;font-size:1.25rem;margin-bottom:0.5rem;}p{color:#888;font-size:0.875rem;}</style>
    </head><body><div class="box"><h1>You've been unsubscribed</h1>
    <p>${email} has been removed from our mailing list. You won't receive any further emails from us.</p></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}
