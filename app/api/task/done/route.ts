import { NextRequest } from 'next/server';
import { sql } from '@/lib/db';

// Clicked from the daily report email to mark a manual task done, so it stops
// appearing as pending. GET so it works straight from an email link.
export async function GET(req: NextRequest) {
  const relay = req.nextUrl.searchParams.get('relay');
  const dm = req.nextUrl.searchParams.get('dm');

  let label = '';
  if (relay) {
    await sql`UPDATE relay_leads SET status = 'sent' WHERE variant_domain = ${relay}`;
    label = `Relay to ${relay} marked sent.`;
  } else if (dm) {
    await sql`UPDATE dm_tasks SET status = 'done' WHERE url = ${dm}`;
    label = 'DM task marked done.';
  } else {
    return new Response('Missing relay or dm param', { status: 400 });
  }

  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center"><p style="font-size:18px">✓ ${label}</p><p style="color:#71717a;font-size:14px">You can close this tab.</p></div></body>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}
