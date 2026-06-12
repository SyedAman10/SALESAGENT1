# 3VLTN AI Sales Agent — Implementation Log

Client-facing record of what has been built, mapped to the June 2026 strategy handoff. Updated continuously as features ship.

**Last updated:** 2026-06-12

---

## 1. Strategy Handoff → Implementation Status

| Strategy doc ask | Status | What was built |
|---|---|---|
| **Dataset 1 — Broker Engagement Log** | ✅ Live | Every inbound reply is captured, classified by AI (broker / buyer / registrar / other, with specialty), and stored with domain characteristics, valuation snapshot, asking price, contact role, response time, and outcome. Silence is logged too: completed sequences with zero replies are recorded as `ignored`. 34 interactions logged to date. |
| **Dataset 2 — Lost Deal Log** | ✅ Live | The doc's five audit questions (right contact / price defensible / buyer-centric / clear CTA / trigger moment) run automatically via AI over every zero-response campaign. The first 20-campaign audit is complete (findings below). |
| **Dataset 3 — Human Intervention Log** | ✅ Schema ready | Table in place (`human_interventions`), populated at first human handoff as specified. |
| **Trigger-event targeting** | 🟡 Partial | Funding/rebrand news scanning is live (Google News → AI company extraction → contact lookup); found 18 in-moment companies on first run. Contact lookup blocked pending Apollo API renewal. USPTO trademark triggers: in progress. |
| **Broker Interest Score** | 🟡 Collecting | Reporting endpoint live (stats by responder type, domain, specialty, response time). Becomes a scoring model at the doc's 200–300 interaction threshold (34/200). |
| **Retroactive reply tagging** | ✅ Done | 30-day inbox backfill completed; all historical replies matched and classified. |

## 2. Key Finding — The Strategy Doc's Diagnosis, Confirmed With Our Own Data

- **250 outreach emails → 1 reply** (a marketplace employee explaining they don't buy domains).
- First 20-campaign audit: price was defensible in **20/20** — price was never the problem. But the right contact was reached in only **2/20**, the copy was buyer-centric in **0/20**, and **0/20** were timed to a buying moment.
- Conclusion matches the handoff exactly: targeting, framing, and timing were the failure points — not inventory or pricing. Every fix below addresses one of those three.

## 3. Agent Storefront (Marketplace Replacement)

The missing "demand capture" half of the agent — what Afternic/Sedo/Atom provide — now exists in-house:

- **`/buy/[domain]` sales page** per portfolio domain: pitch, value props, price, deadline.
- **AI negotiation chat**: answers buyer questions, negotiates within an owner-set floor (never reveals the floor exists), pushes to binding offers, collects contact details. Discloses it is an AI when asked — autonomous selling is the product.
- **Binding offer form**: offers at/above the floor are accepted on the spot; below-floor offers are countered automatically. The owner is alerted instantly on every offer with the action needed.
- **Host routing**: any portfolio domain pointed at the platform serves its own storefront at the root — the domain becomes its own sales page.
- **One-click Go Live**: dashboard button attaches a domain to the hosting project and sets its DNS records via registrar API (Vercel + GoDaddy APIs). Falls back to printed manual records if API keys are absent. Long-term path: platform nameservers (`ns1.3vltn.com`) for one-time bulk delegation, the same model incumbents use.
- Outbound emails link to the storefront as the call-to-action, so cold email's job shrinks to driving traffic and the storefront closes.

## 4. Outreach Engine Overhaul

- **Lead plausibility screening**: AI scoring rewritten to measure *purchase likelihood*, not seniority (previously scored Bill Gates 85/100 as a $3,900 domain buyer). A re-screen of the queued batch cut 24 of 40 leads (celebrities, VC partners, large-company execs).
- **Research-backed copy framework** (from 2025–26 cold-email benchmark data): personalized first line proving research (+142% replies), buyer-centric bridge, 50–90 words, one comp as price anchor, low-commitment concrete CTA (2× replies vs. aggressive asks), banned listing-speak phrases.
- **Two-mode architecture**: *Sprint mode* (per-domain deadline, urgency mechanics, broker-priority sends — auto-expires at the deadline) is kept strictly separate from *Product mode* (brokers treated as data, buyer-centric end-user targeting) so test-case tactics never leak into the product.
- **Reply handling**: Gmail integration upgraded from send-only to full reply sync; replies route to negotiation (sprint) or the engagement log (product). Warm threads get 24h/48h nudges; negotiation drafts are held for owner approval; offers are flagged immediately.
- **Hard guardrails**: source blacklist (never contact excluded companies, enforced at ingest and at send), never price below the owner's floor, daily send cap, one follow-up per lead per day.

## 5. Deliverability (found and fixed in production)

| Issue | Fix |
|---|---|
| Bounced addresses invisible to the system (bounce rate is what kills sender reputation) | Mailer-daemon notices are parsed; dead leads are marked `bounced` and all queued sends to them cancelled — automatic. |
| Three overdue follow-ups fired to one person in five minutes | Capped at one follow-up per lead per send run. |
| Non-ASCII subject lines (em-dashes) rendered as mojibake (`Ã¢Â€Â"`) in recipients' clients | RFC 2047 header encoding on all outbound mail. |
| Warmup throttle misconfigured (capping sends at 5/day while another code path ignored it entirely) | Unified daily limit, warmup deactivated. |
| Junk contact data (e.g., a "domain company" at a city-government address) | Bounce handling + suspicious-pattern sweep (.gov/.edu/role accounts). |

## 6. Automation & Reporting

- **Daily 6am UTC**: domain metrics, ignored-outcome backfill, lead sourcing (name-match, upgrade buyers, trigger events, title searches), AI enrichment and scoring, domain matching, email writing and variant selection — time-budgeted and resumable.
- **Daily 9am UTC**: reply sync + classification, bounce detection, follow-up writing (day 3/5/7), closing-mode drafts for warm threads, owner's daily report email, then sends.
- **Daily report**: replies received, per-thread negotiation status, pending approvals, storefront offers, send counts. Items needing owner input are flagged immediately rather than waiting for the report.
- **24/7**: storefront chat, offer evaluation, lead capture, instant offer alerts.

## 7. In Progress / Roadmap

| Item | Status |
|---|---|
| **Buyer book** — every engaged contact (replies, storefront chats, offers) accumulates into a reusable cross-domain clientele; new domains pitch warm contacts before any cold lead; registrar/marketplace employees auto-excluded | ✅ Live (2026-06-12) |
| **Aftermarket comp sales ingestion** — real sales scraped daily from public charts (DNJournal); feeds domain analysis, negotiation copy, and audit price checks with observed market data instead of model memory. 30 comps on first run; grows daily | ✅ Live (2026-06-12) |
| **Conversational intent mining** — storefront chat transcripts are distilled by AI into structured buyer intent (budget, timing, use case, objections) attached to the buyer book; surfaces in the daily report. This is data marketplace funnels structurally cannot collect | ✅ Live (2026-06-12) |
| **Variant performance report** — reply and unsubscribe rates per pitch angle per domain, computed from existing engagement data. First read: the "direct" pitch style drove 0 replies and the most unsubscribes; "curious" performed best — the experiment loop the strategy doc called for | ✅ Live (2026-06-12) |
| **Recipient-timezone send window** — daily sends moved from 9:00 UTC (4am US East) to 14:00 UTC (10am US East), matching cold-email benchmark best practice for the mostly-US audience | ✅ Live (2026-06-12) |
| **Expanded upgrade-buyer patterns** — beyond TLD variants, now checks the patterns businesses actually settle for: getX/joinX/tryX/myX.com, Xapp/Xhq.com, hyphenated, and keyword-TLD splits (indika.club). First run found a live hit: indika.club, registered and renewed since 2022 — a 4-year holder of the brand is a qualified prospect for the .com | ✅ Live (2026-06-12) |
| Reddit "want to buy" lead source — wired into the daily chain, but Reddit blocks all datacenter access (403); requires residential proxy routing (Apify) to activate | 🟡 Wired, blocked upstream |
| USPTO trademark-filing triggers (exact-match against portfolio = highest-intent lead that exists) | 🔴 Blocked — USPTO's new search API is undocumented/unstable; revisit via TSDR API key or bulk data files |
| Escrow.com API integration — removes the last manual step in the money path | Planned (needs account) |
| Platform nameservers for zero-touch domain onboarding at scale | Planned |
| Broker Interest Score model | Auto-activates as engagement log reaches volume |

---

*Maintained by the dev team. Each shipped item is committed to the repository with full history.*
