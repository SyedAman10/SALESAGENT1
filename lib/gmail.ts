import { google } from 'googleapis';
import { sql } from './db';
import { config } from './config';

type GmailAccount = {
  email: string;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
};

function oauthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    `${config.baseUrl.replace(/\/$/, '')}/api/auth/google/callback`,
  );
}

export function getAuthUrl(): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  if (!data.email) throw new Error('Could not retrieve email from Google');

  await sql`
    INSERT INTO gmail_accounts (email, access_token, refresh_token, token_expiry)
    VALUES (
      ${data.email},
      ${tokens.access_token ?? null},
      ${tokens.refresh_token!},
      ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null}
    )
    ON CONFLICT (email) DO UPDATE SET
      access_token  = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_accounts.refresh_token),
      token_expiry  = EXCLUDED.token_expiry
  `;
}

export interface ConnectedAccount {
  email: string;
  is_active: boolean;
  daily_limit: number;
  sent_today: number;
}

export async function getConnectedAccounts(): Promise<ConnectedAccount[]> {
  const rows = await sql`
    SELECT g.email, g.is_active, g.daily_limit,
      (SELECT COUNT(*) FROM send_log s
         WHERE s.gmail_account = g.email AND s.sent_at::date = CURRENT_DATE AND s.result = 'ok')::int AS sent_today
    FROM gmail_accounts g
    ORDER BY g.created_at ASC`;
  return rows as ConnectedAccount[];
}

export async function removeAccount(email: string): Promise<void> {
  await sql`DELETE FROM gmail_accounts WHERE email = ${email}`;
}

export async function setAccountActive(email: string, isActive: boolean): Promise<void> {
  await sql`UPDATE gmail_accounts SET is_active = ${isActive} WHERE email = ${email}`;
}

export async function setAccountDailyLimit(email: string, dailyLimit: number): Promise<void> {
  await sql`UPDATE gmail_accounts SET daily_limit = ${Math.max(0, Math.round(dailyLimit))} WHERE email = ${email}`;
}

// Total emails the connected mailboxes can still send today (sum of each active
// account's remaining headroom). Send loops slice their queue to this.
export async function getSendCapacityToday(): Promise<number> {
  const accounts = await getConnectedAccounts();
  return accounts
    .filter(a => a.is_active)
    .reduce((sum, a) => sum + Math.max(0, a.daily_limit - a.sent_today), 0);
}

// Rotation: send from the active mailbox with the fewest sends today, spreading
// volume evenly across accounts. Campaign volume is capped upstream via
// getSendCapacityToday(); low-volume internal mail (reports, alerts) may exceed a
// single account's cap here, which is fine.
async function pickSendAccount(): Promise<string> {
  const accounts = (await getConnectedAccounts()).filter(a => a.is_active);
  if (accounts.length === 0) throw new Error('No active Gmail mailbox connected — connect one in the dashboard first.');
  const underCap = accounts.filter(a => a.sent_today < a.daily_limit);
  const pool = underCap.length > 0 ? underCap : accounts;
  pool.sort((a, b) => a.sent_today - b.sent_today);
  return pool[0].email;
}

// Email headers must be ASCII — RFC 2047 encode anything else (em-dashes, accents)
function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildRawMessage(opts: {
  from: string; to: string; subject: string; body: string; inReplyTo?: string;
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    opts.body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function getGmailClient(email?: string) {
  const rows = email
    ? await sql`SELECT email, access_token, refresh_token, token_expiry FROM gmail_accounts WHERE email = ${email} LIMIT 1`
    : await sql`SELECT email, access_token, refresh_token, token_expiry FROM gmail_accounts ORDER BY created_at ASC LIMIT 1`;
  const account = rows[0] as GmailAccount | undefined;
  if (!account) throw new Error('No Gmail account connected — connect one in the dashboard first.');

  const client = oauthClient();
  client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : undefined,
  });

  client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await sql`
        UPDATE gmail_accounts
        SET access_token = ${tokens.access_token},
            token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null}
        WHERE email = ${account.email}
      `;
    }
  });

  return { gmail: google.gmail({ version: 'v1', auth: client }), account };
}

export async function sendViaGmail(opts: {
  to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; from?: string;
}): Promise<{ from: string }> {
  // Replies must go from the same mailbox that owns the thread; new sends rotate.
  const accountEmail = opts.from ?? (opts.threadId ? undefined : await pickSendAccount());
  const { gmail, account } = await getGmailClient(accountEmail);

  const fromHeader = !config.fromName
    ? account.email
    : /^[\x20-\x7E]*$/.test(config.fromName)
      ? `"${config.fromName}" <${account.email}>`
      : `${encodeHeader(config.fromName)} <${account.email}>`;

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: buildRawMessage({ from: fromHeader, to: opts.to, subject: opts.subject, body: opts.body, inReplyTo: opts.inReplyTo }),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    },
  });

  return { from: account.email };
}

export interface InboundEmail {
  messageId: string;
  threadId: string;
  rfcMessageId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  account: string;
}

export async function fetchRecentInboundEmails(sinceDays: number): Promise<InboundEmail[]> {
  const accounts = await sql`SELECT email FROM gmail_accounts WHERE is_active = true ORDER BY created_at ASC` as { email: string }[];
  if (accounts.length === 0) throw new Error('No active Gmail account connected — connect one in the dashboard first.');

  const out: InboundEmail[] = [];
  for (const acc of accounts) {
    const { gmail, account } = await getGmailClient(acc.email);
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `in:inbox newer_than:${sinceDays}d`,
      maxResults: 100,
    });

    for (const m of list.data.messages ?? []) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: m.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Message-ID'],
      });
      const headers = msg.data.payload?.headers ?? [];
      const h = (name: string) => headers.find(x => x.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      const fromRaw = h('From');
      const from = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase();
      if (!from || from === account.email.toLowerCase()) continue;
      out.push({
        messageId: m.id!,
        threadId: msg.data.threadId ?? '',
        rfcMessageId: h('Message-ID'),
        from,
        subject: h('Subject'),
        snippet: msg.data.snippet ?? '',
        receivedAt: msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : new Date(),
        account: account.email,
      });
    }
  }
  return out;
}
