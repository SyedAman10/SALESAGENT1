export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = await import('node-cron');
    const { writeFollowUps, sendApproved } = await import('./lib/pipeline');

    // Every day at 9am UTC — write due follow-ups then send everything due
    cron.default.schedule('0 9 * * *', async () => {
      console.log('[cron] daily automation starting...');
      const followUps = await writeFollowUps();
      const send = await sendApproved();
      console.log(`[cron] done — follow-ups written: ${followUps.written} | sent: ${send.sent} | failed: ${send.failed}`);
    });

    console.log('[cron] daily automation scheduled — 9am UTC');
  }
}
