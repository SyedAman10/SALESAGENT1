import { NextResponse } from 'next/server';
import { writeFollowUps, sendApproved } from '@/lib/pipeline';

export const maxDuration = 300;

export async function GET() {
  const followUps = await writeFollowUps();
  const send = await sendApproved();
  console.log('[cron] daily run — follow-ups written:', followUps.written, '| sent:', send.sent, '| failed:', send.failed);
  return NextResponse.json({ ok: true, ...followUps, ...send });
}
