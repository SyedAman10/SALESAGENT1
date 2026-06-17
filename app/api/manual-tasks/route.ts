import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  const relays = await sql`
    SELECT variant_domain, target_domain, registrar, registered_on, is_live, relay_url, suggested_message
    FROM relay_leads WHERE status = 'pending' ORDER BY is_live DESC, created_at DESC`;
  const dmTasks = await sql`
    SELECT channel, url, handle, title, target_domain
    FROM dm_tasks WHERE status = 'pending' ORDER BY created_at DESC`;
  return NextResponse.json({ relays, dmTasks });
}
