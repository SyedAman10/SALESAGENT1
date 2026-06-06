export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  apolloApiKey: process.env.APOLLO_API_KEY ?? '',
  apifyApiKey: process.env.APIFY_API_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL!,
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  fromName: process.env.FROM_NAME ?? '',
  dailySendLimit: parseInt(process.env.DAILY_SEND_LIMIT ?? '50'),
  leadScoreThreshold: parseInt(process.env.LEAD_SCORE_THRESHOLD ?? '60'),
  model: 'claude-sonnet-4-20250514' as const,
  baseUrl: process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000',
};
