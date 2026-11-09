# Project: Purple-Bot (Kalshi trading bot, Cloudflare Worker)

Read `README.md` first — it lists the design, the definitions, and what was NOT verified against the real exchange.

## Lessons (mistakes already made — don't repeat)
- **Read the real response shape of the business coach before parsing it.** `askAI()` read `response`/`text`/`message`/`content`,
  but `handleChat` (business-coach `src/index.ts`) answers `{ reply, tip, threadId, model, … }`. Every AI answer was silently
  discarded, so the hourly analysis and the dashboard chat always said the AI was unavailable. The e2e fake coach had copied the
  same wrong guess, so tests passed. Fake services in tests must mirror the REAL code's response, read from the source.
- **handleChat returns HTTP 200 with an apology text when both AI providers fail** ("I'm having trouble connecting right now…").
  `askAI()` treats those texts as failures.

## Rules for working here
- **Real money.** Never change order, risk, or reconcile logic without running `npm test` and `node test/e2e/run.mjs`.
- **Bots only start OFF and only a person turns them on.** Nothing in the code may set `enabled = 1` except the
  dashboard's Start button. Restarts/deploys must never switch a bot on.
- **Verify Kalshi facts against https://docs.kalshi.com** (use `/llms.txt` and the `.md` pages) before changing any
  endpoint, field, or signing detail. Don't write them from memory. Only `docs.kalshi.com` is reachable from the cloud
  sandbox — the trading API itself is not, so live behavior can only be tested against `test/e2e/mock-kalshi.mjs`.
- **No new paid services or API integrations without asking.** Email and AI go through the business coach worker
  (`COACH` service binding). Kalshi's Pyth metals feed costs $1,000/month — not used.
- **Never log or return the private key.** It is AES-GCM encrypted in D1 (`settings.kalshi_key_enc`).
- Keep dashboard JS free of template literals where possible; `src/ui.html` is served as plain text.
- Pushes to `master` or `claude/**` deploy automatically (`.github/workflows/deploy.yml`).
