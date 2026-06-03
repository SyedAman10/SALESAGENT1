export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (!process.env.DATABASE_URL) {
      console.warn('[db] DATABASE_URL not set — skipping initDb');
      return;
    }
    try {
      const { initDb } = await import('./lib/db');
      await initDb();
      console.log('[db] schema ready');
    } catch (e) {
      console.error('[db] initDb failed:', (e as Error).message);
    }
  }
}
