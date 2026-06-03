import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email');
  if (!email) return new NextResponse('Missing email', { status: 400 });

  const db = getDb();
  const lead = db.prepare('SELECT id FROM leads WHERE LOWER(email) = LOWER(?)').get(email) as { id: number } | undefined;

  if (lead) {
    db.prepare(`UPDATE leads SET status = 'unsubscribed' WHERE id = ?`).run(lead.id);
    db.prepare(`UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND status = 'approved'`).run(lead.id);
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
