# Project: Purple-Bot (Kalshi trading bot, Cloudflare Worker)

Read `README.md` first — it lists the design, the definitions, and what was NOT verified against the real exchange.

## Lessons (mistakes already made — don't repeat)
- **Read the real response shape of the business coach before parsing it.** `askAI()` read `response`/`text`/`message`/`content`,
  but `handleChat` (business-coach `src/index.ts`) answers `{ reply, tip, threadId, model, … }`. Every AI answer was silently
  discarded, so the hourly analysis and the dashboard chat always said the AI was unavailable. The e2e fake coach had copied the
  same wrong guess, so tests passed. Fake services in tests must mirror the REAL code's response, read from the source.
- **handleChat returns HTTP 200 with an apology text when both AI providers fail** ("I'm having trouble connecting right now…").
  `askAI()` treats those texts as failures.

- **Kalshi splits money across exchange shards, and API orders can only spend the shard their market lives on.** Crypto and
  Commodities (gold, silver) are exchange index 2; most other markets are index 0
  (https://docs.kalshi.com/getting_started/exchange_sharding.md). `GET /portfolio/balance` returns the TOTAL across all
  shards (the per-shard split is in `balance_breakdown`), so the bot's own balance check passed while Kalshi refused gold
  orders with `insufficient_balance`. The owner fixed it by turning on "Disable balance management" at
  kalshi.com/account/exchange-indexes (the transfer controls appear only after that) and moving money into Exchange 2.
  Do not tell the owner to leave that switch off: it hides the transfer controls, and the app/web auto-transfer never
  applies to API orders anyway.

## How to work with this owner
- **If the owner does not need it to act or decide, do not say it.** No internal details (how counts are pooled, how tests were run,
  invented labels like "fake" or "test copy"). Say what was done, what they should do next, and nothing else.
- **Answer in the first sentence, in plain words, then stop.** Do not add background, caveats or tables unless asked. If the owner
  states the answer in their own words and it is right, say "Yes" — do not re-explain (past failure: a one-line meaning of the
  Edge report's "expensive" and "cheap" verdicts took four replies because each one added more words).

- **Every new table, report or number the owner can see must also go into the AI's data (`chatContext` in `src/index.ts`) in the same
  change, with a line in the chat prompt saying how to read it.** Past failure: the Edge report's price-vs-probability table was built
  for the dashboard only, and the owner had to ask for the AI to see it.

## Rules for working here
- **Real money.** Never change order, risk, or reconcile logic without running `npm test` and `node test/e2e/run.mjs`.
- **Bots only start OFF and only a person turns them on.** Nothing in the code may set `enabled = 1` except the
  Bots tab's Start Bot button. Restarts/deploys must never switch a bot on.
- **Verify Kalshi facts against https://docs.kalshi.com** (use `/llms.txt` and the `.md` pages) before changing any
  endpoint, field, or signing detail. Don't write them from memory. Only `docs.kalshi.com` is reachable from the cloud
  sandbox — the trading API itself is not, so live behavior can only be tested against `test/e2e/mock-kalshi.mjs`.
- **No new paid services or API integrations without asking.** Email and AI go through the business coach worker
  (`COACH` service binding). Kalshi's Pyth metals feed costs $1,000/month — not used.
- **Never log or return the private key.** It is AES-GCM encrypted in D1 (`settings.kalshi_key_enc`).
- Keep dashboard JS free of template literals where possible; `src/ui.html` is served as plain text.
- Pushes to `master` or `claude/**` deploy automatically (`.github/workflows/deploy.yml`).
