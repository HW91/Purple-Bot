# Purple Bot — Kalshi automated trading (single owner)

One Cloudflare Worker + one Durable Object + one D1 database. Email and AI come from the existing
business coach worker (`recruiter-coach-worker`) over a private service binding — the same link the
recruiting software uses — so there is no new Gmail setup, no new AI key, and no extra secret for them.

Single user on purpose: Kalshi's Developer Agreement lists "facilitating trading … by other members" and
"sublicensing the API" as prohibited, so this is built for **your own** Kalshi account only. Do not add other
people's keys without written approval from Kalshi.

## What it does
- **Shared live feed:** one authenticated Kalshi WebSocket (ticker channel) for every bot. No polling loops.
  If the socket drops it reconnects, records the gap in `data_gaps`, and uses slow REST polling meanwhile
  (positions stay managed; **new entries are blocked** because order-book depth is unknown).
- **Strategies:** crypto (N of the selected assets agree) and metals (gold **and** silver agree), with
  probability threshold, per-bot Time Delay, minimum time remaining, spread/liquidity check.
- **Orders:** every order is IMMEDIATE-OR-CANCEL, so nothing can rest unnoticed. Closing orders are also
  reduce-only. Entry, partial fill, fill, cancel and reject are recorded separately; an accepted order is never
  treated as a fill — positions are built only from `fill_count` and the actual average fill price and fee.
- **Stop loss / take profit** per position (independent on/off), computed from real fills and fees. Otherwise the
  contract is held to expiry and settled from Kalshi's reported result.
- **Safety:** bots always start OFF and only a person turns them on; the bot's `enabled` flag is re-read from the
  database immediately before every order; Stop and Stop-and-Close-All turn entries off first; one entry per bot per
  contract (database unique index) plus an in-memory lock; account-wide limits across bots; the engine reconciles
  with Kalshi's real positions before the first order and every 5 minutes, and an unclear order result (network
  error) blocks new orders until reconciled.
- **Dashboard:** live probabilities, bot controls, positions, trades, performance metrics, charts (YES green / NO red,
  0–100%, contract open/expiry lines, hover inspection, past contract periods), hourly AI analysis, AI chat with saved
  conversations, backtesting, settings, logs, emergency shutdown.
- **Email:** critical alerts (auth errors, failed/incomplete orders, emergency shutdown, serious errors) always send
  immediately. Everything else follows each bot's setting: immediate / hourly / daily / off. No market-open/closed emails.
- **AI is advisory only.** The hourly analysis runs at most once an hour, only while a bot is on (or traded in the last
  hour) and at least one tracked market is open; the chat only calls AI when you send a message.

## Definitions (so nothing is ambiguous)
- **YES probability** = midpoint of the best YES bid and ask. **NO** = 1 − YES.
- **An asset is "up"** when its own 15-minute market leans YES (> 50%), "down" when it leans NO. This uses the markets
  themselves — no separate price feed. (Kalshi's Pyth metals price feed costs $1,000/month; it is not used.)
- **Entry** is checked on every update once the Time Delay has passed, and the first update where every condition is true
  enters immediately. YES trade = up direction + YES probability; NO trade = down direction + NO probability.
- Bot picks, among agreeing assets above the threshold, the one with the highest probability.
- YES order = buy YES at the ask. NO order = sell YES at the YES bid (which opens a NO position, same price as buying NO).

## One-time setup
1. `npm install`
2. Database: the deploy workflow finds or creates the D1 database `purple-bot-db` automatically
   (`scripts/ensure-d1.mjs`) and applies the schema. To do it by hand instead:
   `npx wrangler d1 create purple-bot-db`, paste the id into `wrangler.jsonc`, then `npm run migrate:remote`.
4. Set three secrets:
   ```bash
   npx wrangler secret put DASHBOARD_PASSWORD   # the password you'll type to sign in
   npx wrangler secret put SESSION_SECRET       # any long random string
   npx wrangler secret put ENCRYPTION_KEY       # base64 of 32 random bytes: openssl rand -base64 32
   ```
5. Deploy: `npm run deploy` (or just push — `.github/workflows/deploy.yml` finds/creates the database, applies migrations and deploys `master` and `claude/**`;
   add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token needs Workers and D1 edit permission).
6. Open the Worker's URL, sign in, **Settings → Kalshi connection**: paste (or upload) your production API Key ID and
   private key. The key is checked against your real account before it is saved, then encrypted.
7. **Settings → Market series → "Find 15-minute series"** and correct any asset whose series name is wrong.
8. Create a bot (it starts OFF), check its numbers, press **Start Bot**.

`wrangler.jsonc` uses the service binding `COACH → recruiter-coach-worker`; that worker must already be deployed in the
same Cloudflare account. Production URLs are in `vars` (`KALSHI_BASE`, `KALSHI_WS`).

## Secrets / settings reference
| Name | Where | Purpose |
|---|---|---|
| `DASHBOARD_PASSWORD` | secret | dashboard sign-in |
| `SESSION_SECRET` | secret | signs the session cookie |
| `ENCRYPTION_KEY` | secret | AES-GCM key for the stored Kalshi private key |
| `KALSHI_BASE`, `KALSHI_WS` | `vars` | Kalshi production REST / WebSocket |
| Kalshi key id + private key | dashboard (stored encrypted in D1) | trading |
| notification email, account limits, series names | dashboard (D1) | configuration |

## Defaults (all editable per bot)
Trade $5 · 1 position · 4 trades/hour · daily loss $20 · daily invest $50 · probability 80% · crypto 7 of 9 ·
metals gold+silver · Time Delay 5 min · stop loss ON $2.50 · take profit ON $1.00 · min 120 s remaining · max spread 6¢.
Account-wide (all bots): daily loss $40 · daily invest $100 · 3 open positions (editable in Settings).

## Things I could not verify from the build environment — check before real money
The build sandbox could reach Kalshi's documentation but **not** its trading API, so the code was tested against a fake
Kalshi that verifies signatures exactly as the docs describe (`test/e2e`). Not yet proven against the real exchange:
1. ~~Series names~~ — checked against Kalshi's own 15-minute series list (all crypto defaults and all five metals exist;
   LINK does not, so BCH replaced it in the default nine and NEAR, TON, ZEC are selectable). An asset with no open contract never trades.
2. **YES = "up".** Confirm in the dashboard market table / Kalshi that each contract's YES means the price goes up.
3. **Time Delay clock.** It counts from the market's `open_time`. If Kalshi opens a contract earlier than its reference
   period starts, the delay is measured from the earlier time.
4. **NO orders.** Sent as `ask` (sell YES) at the YES bid, per Kalshi's Create Order V2 docs; first live NO trade should
   be a small one you watch.
5. **Fees** are taken from the order response (`average_fee_paid`); there is no pre-trade fee estimate.
6. **Business coach `/chat`.** That route requires a `userId` and answers as "Coach P" with its own memory. Purple-Bot calls
   it as the fixed user `purple-bot-trading@internal`. If answers look off, the clean fix is a small AI route in the
   business coach; all AI calls go through `askAI()` in `src/notify.ts`, so it's a one-place change.

## Backtesting
Uses the probabilities this bot recorded (about every 10 seconds, only while it runs or the dashboard is open) plus Kalshi's
settled results — it applies the bot's exact entry rules, Time Delay, stop loss and take profit with conservative estimated
fills (1¢ slippage, fees from your real fills or a flat $0.02 assumption). It is **not** an order-book replay and says so.
Kalshi's historical endpoints (`/historical/*`, candlesticks) are not wired in: they do not contain order-book depth, and the
live/historical cutoff must be read from `GET /historical/cutoff` first.

## Cost notes
The Engine Durable Object holds the outbound WebSocket, so it bills duration while a bot is ON, a position is open, or the
dashboard is open (it stops itself otherwise). Observations are throttled to one per market per 10 seconds and written in
batches. Kalshi API limits (basic tier): 200 read tokens/s, balance 1 call/s — the bot reads balance on demand, not in a loop.

## Tests
```bash
npm run check        # TypeScript
npm test             # signing, strategy, risk, backtest unit tests
node test/e2e/run.mjs   # full local run: Worker + Durable Object + D1 vs a fake Kalshi (takes ~4 minutes)
```
