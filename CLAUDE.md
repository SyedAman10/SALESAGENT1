@AGENTS.md

# Domain Agent — Project Context

## What This Is

An AI-powered domain sales automation tool. It scrapes leads, enriches them with Claude, matches them to domains in `domains.json`, writes outbound email variants, picks the best via Claude, and sends them via nodemailer. Has a Next.js dashboard UI.

## Tech Stack

- **Framework:** Next.js 16.2.6, React 19, TypeScript strict
- **Database:** SQLite via `better-sqlite3` — db file is `db.sqlite` (local only, not committed)
- **AI:** Anthropic Claude SDK (`@anthropic-ai/sdk`), model `claude-sonnet-4-20250514` (set in `lib/config.ts`)
- **Lead sources:** Apollo API, Apify (GoDaddy/Sedo/Afternic scraping), Namepros/DNForum scraping via cheerio
- **Email:** nodemailer via SMTP
- **Deploy:** Vercel (primary)

## Key Files

| File | Purpose |
|---|---|
| `domains.json` | Domain portfolio — source of truth for what's being sold |
| `lib/pipeline.ts` | All pipeline logic: ingest, enrich, match, write, decide, sequence, send |
| `lib/db.ts` | SQLite DB setup and queries |
| `lib/config.ts` | All env var bindings; model selection |
| `app/page.tsx` | Dashboard UI (client component) |
| `app/api/pipeline/route.ts` | Pipeline step dispatcher |
| `app/api/send/route.ts` | Email send with SSE streaming |
| `app/api/cron/route.ts` | Daily cron endpoint |
| `instrumentation.ts` | Next.js instrumentation hook |

## Pipeline Steps

0. **analyze** — Claude analyzes each domain, generates buyer profiles, email hooks, comparable sales
1. **ingest** — scrapes Apollo + Apify + forums for leads matching domain buyer profiles
2. **enrich** — Claude scores each lead (0–100) for fit
3. **match** — matches enriched leads to the best domain in portfolio
4. **write** — Claude writes 3 email variants per matched lead
5. **decide** — Claude picks the best variant, marks it `approved`
6. **sequence** — writes Day 3/5/7 follow-up emails for contacted leads

## Environment Variables Required

```
ANTHROPIC_API_KEY
APOLLO_API_KEY
APIFY_API_KEY
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
FROM_EMAIL / FROM_NAME
DAILY_SEND_LIMIT (default 50)
LEAD_SCORE_THRESHOLD (default 60)
NEXT_PUBLIC_BASE_URL
```

## Current Portfolio

- `indikaclub.com` — brandable, $3,900
- `primecrafters.com` — brandable, $1,200

## Notes

- `db.sqlite` is local-only; Vercel deploy needs a persistent DB or volume — not yet configured
- Daily cron auto-sends at 9am UTC via `/api/cron`
- Max function duration set to 300s on pipeline + send routes (`export const maxDuration = 300`)

