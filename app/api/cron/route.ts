import { NextResponse } from 'next/server';
import { syncReplies, writeFollowUps, writeClosingFollowUps, sendApproved, sendDailyReport } from '@/lib/pipeline';

export const maxDuration = 300;

export async function GET() {
  const replies = await syncReplies();
  const followUps = await writeFollowUps();
  const closing = await writeClosingFollowUps();
  // Report before send: the send loop can run close to maxDuration, the report must not get cut
  await sendDailyReport().catch(e => console.error('[cron] report failed:', (e as Error).message));
  const send = await sendApproved();
  console.log('[cron] daily run — replies:', replies.matched, '| follow-ups:', followUps.written, '| closing drafts:', closing.written, `(${closing.flagged} flagged)`, '| sent:', send.sent, '| failed:', send.failed);
  return NextResponse.json({ ok: true, replies, followUps, closing, ...send });
}
