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

export async function getConnectedAccount(): Promise<{ email: string } | null> {
  const rows = await sql`SELECT email FROM gmail_accounts LIMIT 1`;
  return (rows[0] as { email: string } | undefined) ?? null;
}

export async function disconnectAccount(): Promise<void> {
  await sql`DELETE FROM gmail_accounts`;
}

function buildRawMessage(opts: {
  from: string; to: string; subject: string; body: string; inReplyTo?: string;
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    opts.body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function getGmailClient() {
  const rows = await sql`SELECT email, access_token, refresh_token, token_expiry FROM gmail_accounts LIMIT 1`;
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
  to: string; subject: string; body: string; threadId?: string; inReplyTo?: string;
}): Promise<void> {
  const { gmail, account } = await getGmailClient();

  const fromHeader = config.fromName
    ? `"${config.fromName}" <${account.email}>`
    : account.email;

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: buildRawMessage({ from: fromHeader, to: opts.to, subject: opts.subject, body: opts.body, inReplyTo: opts.inReplyTo }),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    },
  });
}

export interface InboundEmail {
  messageId: string;
  threadId: string;
  rfcMessageId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
}

export async function fetchRecentInboundEmails(sinceDays: number): Promise<InboundEmail[]> {
  const { gmail, account } = await getGmailClient();

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `in:inbox newer_than:${sinceDays}d`,
    maxResults: 100,
  });

  const out: InboundEmail[] = [];
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
    });
  }
  return out;
}
