/**
 * The Engine is ONE Durable Object that owns the single shared Kalshi WebSocket and runs every bot.
 *
 * It only stays alive while it has a reason to: an enabled bot, an open position, or the dashboard
 * being watched. Otherwise it closes the socket, stops its alarm, and Cloudflare evicts it.
 * It NEVER turns a bot on by itself — `enabled` is only ever set by a person through the dashboard.
 */
import { DurableObject } from "cloudflare:workers";
import { KalshiAuthError, KalshiClient, KalshiHttpError, num, type KalshiMarket } from "./kalshi";
import { authHeaders, importSigningKey, type SigningKey } from "./kalshi-auth";
import { getAccountLimits, getCreds, getSetting, isBotEnabled, loadBots, log, openPositions, setSetting, type PositionRow } from "./db";
import { emailShell, esc, sendEmail } from "./notify";
import { etDateString, overviewEmail, runOverview } from "./analysis";
import { checklistFor, type CheckLine } from "./checklist";
import { FlowTracker } from "./flow";
import { samplesFromCandles, samplesFromObs, type Cell, type EdgeLookup } from "./edge";
import { checkRisk, dayStartMs, directionOf, evaluateEntry, evaluateExit, favorableProb, yesProb, type AssetView, type EntryDecision, type OpenPos, type RiskStats, unrealizedPnl } from "./strategy";
import { CRYPTO_ASSETS, METAL_ASSETS, type Bot, type Env, type MarketInfo, type Quote } from "./types";

const TICK_MS = 10_000;
const OBS_MIN_INTERVAL_MS = 10_000;
const WATCH_LEASE_MS = 90_000;
const BALANCE_MAX_AGE_MS = 15_000;

/** Series tickers, confirmed against Kalshi's own 15-minute series list. Editable in the dashboard if Kalshi renames one. */
export const DEFAULT_SERIES: Record<string, string> = {
  BTC: "KXBTC15M",
  ETH: "KXETH15M",
  SOL: "KXSOL15M",
  XRP: "KXXRP15M",
  DOGE: "KXDOGE15M",
  BNB: "KXBNB15M",
  HYPE: "KXHYPE15M",
  ADA: "KXADA15M",
  BCH: "KXBCH15M",
  NEAR: "KXNEAR15M",
  TON: "KXTON15M",
  ZEC: "KXZEC15M",
  GOLD: "KXGOLD15M",
  SILVER: "KXSILVER15M",
  PLATINUM: "KXPLATINUM15M",
  PALLADIUM: "KXPALLADIUM15M",
  COPPER: "KXCOPPER15M",
};

export interface LiveState {
  now: number;
  connected: boolean;
  restFallback: boolean;
  reconciled: boolean;
  reconcileProblem: string | null;
  credentialsOk: boolean;
  authError: string | null;
  balance: number | null;
  portfolioValue: number | null;
  assets: Array<{
    asset: string;
    series: string;
    ticker: string | null;
    title: string | null;
    openTs: number | null;
    closeTs: number | null;
    nextOpenTs: number | null;
    yes: number | null;
    no: number | null;
    bid: number | null;
    ask: number | null;
    quoteAgeMs: number | null;
  }>;
  bots: Array<{ id: string; enabled: boolean; reason: string; up: number; down: number }>;
  positions: Array<PositionRow & { unrealized: number | null; favNow: number | null }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (x: number) => Math.round(x * 100) / 100;

export class Engine extends DurableObject<Env> {
  private sk: SigningKey | null = null;
  private keyId = "";
  private client: KalshiClient | null = null;
  private credentialsOk = true;
  private authError: string | null = null;

  private ws: WebSocket | null = null;
  private sid: number | null = null;
  private subscribed = new Set<string>();
  // order flow: Kalshi's live trade channel (only subscribed while an enabled bot uses it) and the running money totals
  private tradeSid: number | null = null;
  private tradeSubscribed = new Set<string>();
  private flow = new FlowTracker();
  private flowLoading = new Set<string>();
  private flowIncomplete = new Set<string>();
  private historyRunning = false;
  // the edge rule's history: for each asset, win counts by minute-before-close and price level (refreshed every minute)
  private edgeCache = new Map<string, { at: number; cells: Map<number, Cell> }>();
  private edgeLookup: EdgeLookup = (asset, minuteLeft, bucket) => this.edgeCache.get(asset)?.cells.get(minuteLeft * 100 + bucket) ?? null;
  private flowMeta = new Map<string, { asset: string; openTs: number; closeTs: number }>(); // contracts being recorded, until they end
  private downSince: number | null = null;
  private restFallback = false;

  private quotes = new Map<string, Quote>();
  private markets = new Map<string, MarketInfo>();
  private nextOpen = new Map<string, number>();
  private lastDiscovery = 0;

  private bots: Bot[] = [];
  private posCache = new Map<string, PositionRow>();
  private dirtyPos = new Set<string>();
  private lastFav = new Map<string, number>();
  private obsBuf: Array<[string, number, number, number, number, number | null, number | null]> = [];
  private lastObs = new Map<string, number>();
  private lastObsKey = new Map<string, string>();

  private inflight = new Set<string>();
  private closeRequests = new Map<string, string>();
  private lastExitAttempt = new Map<string, number>();
  private entryAttempts = new Map<string, { n: number; last: number }>();
  private lastReason = new Map<string, { reason: string; ts: number; up: number; down: number }>();
  private lastAlert = new Map<string, number>();
  private settleChecked = new Map<string, number>();
  private resultTried = new Map<string, number>(); // ticker -> last time we asked Kalshi for its final result
  private entered = new Set<string>(); // "botId|ticker" of contracts a bot has already entered
  private settingsSeen = new Map<string, string>(); // "botId|ticker" -> the probability min|max last saved for it
  private notes = new Map<string, { botId: string; ticker: string; samples: number; counts: Record<string, number>; texts: Record<string, string>; checks: CheckLine[] | null; last: number; dirty: boolean }>();

  private reconciled = false;
  private reconcileProblem: string | null = null;
  private lastReconcile = 0;
  private balance: { value: number; portfolio: number; ts: number } | null = null;
  private watchUntil = 0;
  private loaded = false;

  // ---------------------------------------------------------------- public RPC (called from the Worker)

  /** Config / bot state changed (created, edited, started, stopped). Reload and make sure we're running. */
  async poke(): Promise<void> {
    await this.refreshBots();
    await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  /** Dashboard heartbeat: keeps the engine alive while someone is looking, returns live state. */
  async watch(): Promise<LiveState> {
    const wasWatching = this.watchUntil > Date.now();
    this.watchUntil = Date.now() + WATCH_LEASE_MS;
    if (!this.loaded) await this.refreshBots();
    if (!wasWatching || !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 200);
    return this.liveState();
  }

  /** Stop and Close All Positions (one bot) or everything when botId is null. Disabling is done by the caller first. */
  async closeAll(botId: string | null, reason: "manual_close" | "emergency"): Promise<number> {
    await this.refreshBots();
    await this.loadPositions();
    let n = 0;
    for (const p of this.posCache.values()) {
      if (botId && p.bot_id !== botId) continue;
      this.closeRequests.set(p.id, reason);
      n++;
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return n;
  }

  /** Big red button: disable every bot, then try to close every position. */
  async emergency(): Promise<number> {
    await this.env.DB.prepare("UPDATE bots SET enabled = 0, updated_ts = ?").bind(Date.now()).run();
    for (const b of this.bots) b.enabled = false;
    await log(this.env, "error", "control", "EMERGENCY SHUTDOWN: all bots disabled, closing every position");
    const n = await this.closeAll(null, "emergency");
    await this.critical("emergency", "Emergency shutdown", `All bots were turned off and ${n} open position(s) are being closed. Check the dashboard to confirm each one closed.`);
    return n;
  }

  async reconcileNow(): Promise<{ reconciled: boolean; problem: string | null }> {
    await this.ensureClient();
    this.reconciled = false;
    await this.reconcile();
    return { reconciled: this.reconciled, problem: this.reconcileProblem };
  }

  /** Drop the cached Kalshi client (credentials were replaced or removed). */
  async credentialsChanged(): Promise<void> {
    this.client = null;
    this.sk = null;
    this.credentialsOk = true;
    this.authError = null;
    this.reconciled = false;
    this.balance = null;
    this.closeSocket();
    await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  // ---------------------------------------------------------------- alarm loop

  async alarm(): Promise<void> {
    const now = Date.now();
    let wanted = false;
    try {
      await this.refreshBots();
      await this.loadPositions();
      this.historyRunning = await this.readHistoryRunning();
      wanted = this.bots.some((b) => b.enabled) || this.posCache.size > 0 || now < this.watchUntil || this.historyRunning;
      if (!wanted) {
        this.closeSocket();
        return; // no alarm rescheduled -> Cloudflare can evict us
      }
      if (!(await this.ensureClient())) return; // no credentials: stay idle, no alarm
      await this.discoverIfNeeded();
      if (!this.ws) await this.openSocket();
      this.syncSubscription(); // new contracts, or an order-flow bot was just turned on
      await this.ensureFlowReady();
      await this.saveFlowSummaries();
      if (!this.ws || this.restFallback) await this.restPoll();
      else await this.refreshQuietQuotes();
      if (!this.reconciled || now - this.lastReconcile > 300_000) await this.reconcile();
      await this.refreshBalanceIfStale();
      // Check entries on the clock too, not only when a price message arrives: the Time Delay can
      // pass, or a quiet market can sit still, with no new message to trigger a check.
      await this.refreshEdgeTables(); // the edge rule needs its history loaded before it is asked
      await this.evaluateAllEntries();
      await this.flush();
      await this.checkSettlements();
      await this.backfillResults();
      await this.calibrateSettled();
      await this.historyJobTick();
      await this.processCloseRequests();
      await this.dailyJobs();
    } catch (e) {
      await this.handleError("alarm", e);
    } finally {
      if (wanted && this.client) {
        let next = Date.now() + TICK_MS;
        for (const m of this.markets.values()) if (m.closeTs + 1500 > Date.now() && m.closeTs + 1500 < next) next = m.closeTs + 1500;
        // wake exactly when an enabled bot's Time Delay ends
        for (const b of this.bots) {
          if (!b.enabled) continue;
          const cm = this.currentMarket(b.config.tradeAsset);
          const t = cm ? cm.openTs + b.config.timeDelaySec * 1000 + 300 : 0;
          if (t > Date.now() && t < next) next = t;
        }
        try {
          await this.ctx.storage.setAlarm(next);
        } catch (e) {
          console.error("setAlarm failed", e);
        }
      }
    }
  }

  // ---------------------------------------------------------------- setup helpers

  private async refreshBots(): Promise<void> {
    this.bots = await loadBots(this.env);
    this.loaded = true;
  }

  private async loadPositions(): Promise<void> {
    const rows = await openPositions(this.env);
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      this.entered.add(`${r.bot_id}|${r.ticker}`);
      const cached = this.posCache.get(r.id);
      // keep in-memory extremes (they're ahead of D1 between flushes)
      this.posCache.set(r.id, cached && this.dirtyPos.has(r.id) ? { ...r, fav_max: cached.fav_max, fav_min: cached.fav_min, prob_before_close: cached.prob_before_close } : r);
    }
    for (const id of [...this.posCache.keys()]) if (!seen.has(id)) this.posCache.delete(id);
  }

  private async ensureClient(): Promise<boolean> {
    if (this.client) return true;
    const creds = await getCreds(this.env);
    if (!creds) {
      this.credentialsOk = false;
      return false;
    }
    try {
      this.sk = await importSigningKey(creds.pem);
      this.keyId = creds.keyId;
      this.client = new KalshiClient(this.env.KALSHI_BASE, creds.keyId, this.sk);
      this.credentialsOk = true;
      return true;
    } catch (e) {
      this.credentialsOk = false;
      this.authError = (e as Error).message;
      await this.critical("auth-key", "Kalshi API key problem", `The stored Kalshi key could not be read: ${esc(this.authError)}`);
      return false;
    }
  }

  private async seriesFor(asset: string): Promise<string> {
    const raw = await getSetting(this.env, "series_map");
    if (raw) {
      try {
        const m = JSON.parse(raw) as Record<string, string>;
        if (m[asset]) return m[asset];
      } catch {
        /* ignore */
      }
    }
    return DEFAULT_SERIES[asset] ?? `KX${asset}15M`;
  }

  private trackedAssets(): string[] {
    const set = new Set<string>();
    for (const b of this.bots) for (const a of b.config.assets) set.add(a);
    for (const p of this.posCache.values()) set.add(p.asset);
    return [...set];
  }

  private currentMarket(asset: string, now = Date.now()): MarketInfo | null {
    let best: MarketInfo | null = null;
    for (const m of this.markets.values()) {
      if (m.asset !== asset || m.openTs > now || m.closeTs <= now) continue;
      if (!best || m.openTs > best.openTs) best = m;
    }
    return best;
  }

  // ---------------------------------------------------------------- market discovery

  private async discoverIfNeeded(): Promise<void> {
    const now = Date.now();
    const assets = this.trackedAssets();
    if (assets.length === 0) return;
    const missing = assets.some((a) => !this.currentMarket(a, now));
    const rolled = [...this.markets.values()].some((m) => m.closeTs <= now && now - this.lastDiscovery > 2_000 && assets.includes(m.asset) && !this.currentMarket(m.asset, now));
    const due = now - this.lastDiscovery > 300_000 || (missing && now - this.lastDiscovery > 30_000) || rolled;
    if (!due) return;
    this.lastDiscovery = now;
    const rows: KalshiMarket[] = [];
    const found = new Map<string, MarketInfo>();
    for (const asset of assets) {
      const series = await this.seriesFor(asset);
      let list: KalshiMarket[] = [];
      try {
        list = await this.client!.openMarketsInSeries(series);
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e;
        await log(this.env, "warn", "system", `Market discovery failed for ${asset} (${series}): ${(e as Error).message}`);
        continue;
      }
      list.sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
      for (const m of list.slice(0, 3)) {
        const openTs = Date.parse(m.open_time);
        const closeTs = Date.parse(m.close_time);
        if (!Number.isFinite(openTs) || !Number.isFinite(closeTs)) continue;
        found.set(m.ticker, { ticker: m.ticker, asset, series, title: m.yes_sub_title || m.title || m.ticker, openTs, closeTs, status: m.status });
        rows.push(m);
        // seed quote so the dashboard has something even before the first WebSocket tick
        if (!this.quotes.has(m.ticker) && m.yes_bid_dollars && m.yes_ask_dollars) {
          this.quotes.set(m.ticker, { ticker: m.ticker, yesBid: num(m.yes_bid_dollars), yesAsk: num(m.yes_ask_dollars), yesBidSize: 0, yesAskSize: 0, last: num(m.last_price_dollars), ts: now });
        }
      }
      if (!list.some((m) => Date.parse(m.open_time) <= now && Date.parse(m.close_time) > now)) {
        // nothing open right now: look for the next opening so the dashboard can show it
        try {
          const nextOpen = list.map((m) => Date.parse(m.open_time)).filter((t) => t > now).sort((a, b) => a - b)[0];
          if (nextOpen) this.nextOpen.set(asset, nextOpen);
        } catch {
          /* optional */
        }
      } else this.nextOpen.delete(asset);
    }
    // keep markets that still have open positions even if Kalshi no longer lists them as open
    for (const p of this.posCache.values()) {
      const old = this.markets.get(p.ticker);
      if (old && !found.has(p.ticker)) found.set(p.ticker, old);
    }
    this.markets = found;
    if (found.size) {
      const stmt = this.env.DB.prepare("INSERT INTO markets (ticker, asset, series, title, open_ts, close_ts, status, updated_ts) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET status=excluded.status, title=excluded.title, updated_ts=excluded.updated_ts");
      await this.env.DB.batch([...found.values()].map((m) => stmt.bind(m.ticker, m.asset, m.series, m.title, m.openTs, m.closeTs, m.status, now)));
    }
    this.syncSubscription();
  }

  // ---------------------------------------------------------------- WebSocket

  private closeSocket(): void {
    try {
      this.ws?.close(1000, "idle");
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.sid = null;
    this.subscribed.clear();
    this.dropTradeFeed();
  }

  /** The live trade feed is gone: money totals may be missing trades, so none are trusted until they are loaded again. */
  private dropTradeFeed(): void {
    this.tradeSid = null;
    this.tradeSubscribed.clear();
    this.flow.markAllNotReady();
  }

  private async openSocket(): Promise<void> {
    if (!this.sk) return;
    try {
      const headers = await authHeaders(this.sk, this.keyId, "GET", "/trade-api/ws/v2");
      const res = await fetch(this.env.KALSHI_WS, { headers: { ...headers, Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) {
        if (res.status === 401 || res.status === 403) throw new KalshiAuthError(`Kalshi WebSocket rejected the credentials (${res.status})`);
        throw new Error(`Kalshi WebSocket refused the connection (${res.status})`);
      }
      ws.accept();
      ws.addEventListener("message", (ev) => {
        this.onMessage(typeof ev.data === "string" ? ev.data : "").catch((e) => console.error("onMessage", e));
      });
      const onDown = (why: string) => {
        if (this.ws === ws) {
          this.ws = null;
          this.sid = null;
          this.subscribed.clear();
          this.dropTradeFeed();
          this.downSince = this.downSince ?? Date.now();
          this.ctx.waitUntil(log(this.env, "warn", "system", `Kalshi WebSocket closed: ${why}`));
          this.ctx.storage.setAlarm(Date.now() + 2_000).catch(() => {});
        }
      };
      ws.addEventListener("close", (ev) => onDown(`code ${ev.code}`));
      ws.addEventListener("error", () => onDown("error"));
      this.ws = ws;
      this.restFallback = false;
      if (this.downSince) {
        await this.env.DB.prepare("INSERT INTO data_gaps (start_ts, end_ts, reason) VALUES (?,?,?)").bind(this.downSince, Date.now(), "live feed was down").run();
        this.downSince = null;
      }
      this.syncSubscription();
    } catch (e) {
      this.downSince = this.downSince ?? Date.now();
      this.restFallback = true; // conservative REST polling keeps positions managed while the socket is down
      if (e instanceof KalshiAuthError) throw e;
      await log(this.env, "warn", "system", `WebSocket connect failed, using REST fallback: ${(e as Error).message}`);
    }
  }

  private syncSubscription(): void {
    if (!this.ws) return;
    // price channel (always)
    const want = [...this.markets.keys()].filter((t) => !this.subscribed.has(t));
    if (want.length > 0) {
      try {
        if (this.sid === null && this.subscribed.size === 0) {
          this.ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["ticker"], market_tickers: want } }));
          for (const t of want) this.subscribed.add(t);
        } else if (this.sid !== null) {
          this.ws.send(JSON.stringify({ id: Date.now() % 1_000_000, cmd: "update_subscription", params: { sids: [this.sid], market_tickers: want, action: "add_markets" } }));
          for (const t of want) this.subscribed.add(t);
        } // else: waiting for the subscribed reply
      } catch (e) {
        console.error("subscribe send failed", e);
      }
    }
    // trade channel: only the contract each enabled bot trades (order-flow decisions, and the money record the AI reads)
    {
      const traded = this.tradedTickers(Date.now());
      const wantT = [...traded].filter((t) => !this.tradeSubscribed.has(t));
      if (wantT.length > 0) {
        try {
          if (this.tradeSid === null && this.tradeSubscribed.size === 0) {
            this.ws.send(JSON.stringify({ id: 2, cmd: "subscribe", params: { channels: ["trade"], market_tickers: wantT } }));
            for (const t of wantT) this.tradeSubscribed.add(t);
          } else if (this.tradeSid !== null) {
            this.ws.send(JSON.stringify({ id: Date.now() % 1_000_000, cmd: "update_subscription", params: { sids: [this.tradeSid], market_tickers: wantT, action: "add_markets" } }));
            for (const t of wantT) this.tradeSubscribed.add(t);
          }
        } catch (e) {
          console.error("trade subscribe send failed", e);
        }
      }
    }
  }

  /** The current contract of every asset an enabled bot trades. */
  private tradedTickers(now: number): Set<string> {
    const out = new Set<string>();
    for (const bot of this.bots) {
      if (!bot.enabled) continue;
      const m = this.currentMarket(bot.config.tradeAsset, now);
      if (m) out.add(m.ticker);
    }
    return out;
  }

  /** Load the trades placed before we subscribed (once per contract), so the running totals are complete before any decision uses them. */
  private async ensureFlowReady(): Promise<void> {
    if (!this.client || !this.ws || this.tradeSid === null) return;
    const now = Date.now();
    for (const bot of this.bots) {
      if (!bot.enabled) continue;
      const m = this.currentMarket(bot.config.tradeAsset, now);
      if (!m || this.flow.isReady(m.ticker) || !this.tradeSubscribed.has(m.ticker) || this.flowLoading.has(m.ticker)) continue;
      this.flowLoading.add(m.ticker);
      try {
        const { trades, truncated } = await this.client.trades(m.ticker, 30);
        for (const t of trades) {
          this.flow.add(m.ticker, { id: t.trade_id, side: t.taker_outcome_side === "no" ? "no" : "yes", ts: Date.parse(t.created_time), contracts: num(t.count_fp), yesPrice: num(t.yes_price_dollars), noPrice: num(t.no_price_dollars) });
        }
        if (truncated) {
          this.flowIncomplete.add(m.ticker); // the contract had more trades than we could load: its totals are low, so it is not saved for the AI
          await log(this.env, "warn", "system", `Order flow: ${m.ticker} had more trades than could be loaded; totals for long time frames may be low`, bot.id);
        }
        this.flowMeta.set(m.ticker, { asset: m.asset, openTs: m.openTs, closeTs: m.closeTs });
        this.flow.markReady(m.ticker);
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e; // anything else: stay "not ready", so no trade is taken on partial totals
      } finally {
        this.flowLoading.delete(m.ticker);
      }
    }
  }

  /** When a contract has ended, save its money totals (per minute) for the AI, then forget its trades. Only complete records are saved. */
  private async saveFlowSummaries(): Promise<void> {
    const now = Date.now();
    for (const [ticker, meta] of [...this.flowMeta]) {
      if (now < meta.closeTs + 3_000) continue;
      this.flowMeta.delete(ticker);
      const complete = this.flow.isReady(ticker) && !this.flowIncomplete.has(ticker);
      if (complete) {
        const minutes = this.flow.byMinute(ticker, meta.openTs, meta.closeTs);
        const yes = Math.round(minutes.reduce((s, m) => s + m[0], 0) * 100) / 100;
        const no = Math.round(minutes.reduce((s, m) => s + m[1], 0) * 100) / 100;
        try {
          await this.env.DB.prepare("INSERT OR REPLACE INTO contract_flow (ticker, asset, open_ts, close_ts, yes_dollars, no_dollars, minutes, saved_ts) VALUES (?,?,?,?,?,?,?,?)")
            .bind(ticker, meta.asset, meta.openTs, meta.closeTs, yes, no, JSON.stringify(minutes), now)
            .run();
        } catch (e) {
          console.error("saveFlowSummaries failed", e);
        }
      }
      this.flowIncomplete.delete(ticker);
      this.flow.forget(ticker);
    }
    this.flow.prune(now);
  }

  private async onMessage(raw: string): Promise<void> {
    if (!raw) return;
    let m: { type?: string; msg?: Record<string, unknown> };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "subscribed") {
      const sid = num(m.msg?.sid, NaN);
      if (Number.isFinite(sid) && m.msg?.channel === "ticker") {
        this.sid = sid;
        this.syncSubscription();
      } else if (Number.isFinite(sid) && m.msg?.channel === "trade") {
        this.tradeSid = sid;
        this.syncSubscription();
      }
      return;
    }
    if (m.type === "trade" && m.msg) {
      // one public trade: add its money to the side that started it
      const t = m.msg;
      const tk = String(t.market_ticker ?? "");
      if (!tk || !this.markets.has(tk)) return;
      this.flow.add(tk, { id: t.trade_id !== undefined ? String(t.trade_id) : undefined, side: t.taker_outcome_side === "no" ? "no" : "yes", ts: t.ts_ms !== undefined ? num(t.ts_ms) : Date.now(), contracts: num(t.count_fp), yesPrice: num(t.yes_price_dollars), noPrice: num(t.no_price_dollars) });
      return;
    }
    if (m.type === "error") {
      await log(this.env, "error", "system", `Kalshi WebSocket error message: ${JSON.stringify(m.msg).slice(0, 300)}`);
      this.closeSocket(); // reconnect with a clean subscription on the next tick
      this.downSince = this.downSince ?? Date.now();
      return;
    }
    if (m.type !== "ticker" || !m.msg) return;
    const t = m.msg;
    const ticker = String(t.market_ticker ?? "");
    if (!ticker || !this.markets.has(ticker)) return;
    const prev = this.quotes.get(ticker);
    const bid = t.yes_bid_dollars !== undefined ? num(t.yes_bid_dollars) : prev?.yesBid ?? 0;
    const ask = t.yes_ask_dollars !== undefined ? num(t.yes_ask_dollars) : prev?.yesAsk ?? 0;
    await this.onQuote({
      ticker,
      yesBid: bid,
      yesAsk: ask,
      yesBidSize: t.yes_bid_size_fp !== undefined ? num(t.yes_bid_size_fp) : prev?.yesBidSize ?? 0,
      yesAskSize: t.yes_ask_size_fp !== undefined ? num(t.yes_ask_size_fp) : prev?.yesAskSize ?? 0,
      last: t.price_dollars !== undefined ? num(t.price_dollars) : prev?.last ?? 0,
      ts: Date.now(),
    });
  }

  /** Conservative fallback while the socket is down: poll the series (positions stay managed, new entries are blocked because size is unknown). */
  private async restPoll(): Promise<void> {
    const now = Date.now();
    for (const asset of this.trackedAssets()) {
      try {
        const list = await this.client!.openMarketsInSeries(await this.seriesFor(asset));
        for (const m of list) {
          if (!this.markets.has(m.ticker)) continue;
          await this.onQuote({ ticker: m.ticker, yesBid: num(m.yes_bid_dollars), yesAsk: num(m.yes_ask_dollars), yesBidSize: 0, yesAskSize: 0, last: num(m.last_price_dollars), ts: now });
        }
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e;
      }
    }
  }

  // ---------------------------------------------------------------- per-update processing

  private async onQuote(q: Quote): Promise<void> {
    this.quotes.set(q.ticker, q);
    if (q.yesBid <= 0 || q.yesAsk <= 0) return;
    this.recordObservation(q);
    this.updateExtremes(q);
    try {
      await this.checkExits(q);
      await this.checkEntries(q);
    } catch (e) {
      await this.handleError("onQuote", e);
    }
  }

  private recordObservation(q: Quote): void {
    const key = `${q.yesBid}|${q.yesAsk}`;
    if (this.lastObsKey.get(q.ticker) === key) return;
    const last = this.lastObs.get(q.ticker) ?? 0;
    if (q.ts - last < OBS_MIN_INTERVAL_MS) return; // batch + throttle D1 writes
    this.lastObs.set(q.ticker, q.ts);
    this.lastObsKey.set(q.ticker, key);
    this.obsBuf.push([q.ticker, q.ts, q.yesBid, q.yesAsk, q.last, q.yesBidSize > 0 ? q.yesBidSize : null, q.yesAskSize > 0 ? q.yesAskSize : null]);
  }

  /** Track favorable-direction probability extremes while a position is open (from live updates only). */
  private updateExtremes(q: Quote): void {
    const yes = yesProb(q);
    for (const p of this.posCache.values()) {
      if (p.ticker !== q.ticker) continue;
      const fav = favorableProb(p.outcome, yes);
      this.lastFav.set(p.id, fav);
      p.prob_before_close = fav;
      if (p.fav_max === null || fav > p.fav_max) {
        p.fav_max = fav;
        this.dirtyPos.add(p.id);
      }
      if (p.fav_min === null || fav < p.fav_min) {
        p.fav_min = fav;
        this.dirtyPos.add(p.id);
      }
    }
  }

  private async flush(): Promise<void> {
    const stmts: D1PreparedStatement[] = [];
    if (this.obsBuf.length) {
      const ins = this.env.DB.prepare("INSERT INTO observations (ticker, ts, yes_bid, yes_ask, last, yes_bid_size, yes_ask_size) VALUES (?,?,?,?,?,?,?)");
      for (const o of this.obsBuf) stmts.push(ins.bind(...o));
      this.obsBuf = [];
    }
    if (this.dirtyPos.size) {
      const up = this.env.DB.prepare("UPDATE positions SET fav_max = ?, fav_min = ?, prob_before_close = ? WHERE id = ?");
      for (const id of this.dirtyPos) {
        const p = this.posCache.get(id);
        if (p) stmts.push(up.bind(p.fav_max, p.fav_min, p.prob_before_close, id));
      }
      this.dirtyPos.clear();
    }
    const upNote = this.env.DB.prepare("INSERT INTO contract_notes (bot_id, ticker, samples, counts, texts, checks, updated_ts) VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id, ticker) DO UPDATE SET samples=excluded.samples, counts=excluded.counts, texts=excluded.texts, checks=excluded.checks, updated_ts=excluded.updated_ts");
    for (const n of this.notes.values()) {
      if (!n.dirty) continue;
      n.dirty = false;
      stmts.push(upNote.bind(n.botId, n.ticker, n.samples, JSON.stringify(n.counts), JSON.stringify(n.texts), n.checks ? JSON.stringify(n.checks) : null, Date.now()));
    }
    if (stmts.length) await this.env.DB.batch(stmts);
  }

  // ---------------------------------------------------------------- entries

  private viewsFor(bot: Bot, now: number): AssetView[] {
    return bot.config.assets.map((asset) => {
      const market = this.currentMarket(asset, now);
      // money on each side over this bot's time frame; null until the trades placed before we subscribed are loaded
      const since = market ? (bot.config.flowWindowMin > 0 ? Math.max(now - bot.config.flowWindowMin * 60_000, market.openTs) : market.openTs) : 0;
      const flow = bot.config.flowOn && market && this.flow.isReady(market.ticker) ? this.flow.totals(market.ticker, since, now) : null;
      return { asset, market, quote: market ? this.quotes.get(market.ticker) ?? null : null, flow };
    });
  }

  /** Quiet markets send no ticker messages. While the socket is healthy, confirm their price over REST so "no news" is not mistaken for "stale". */
  private async refreshQuietQuotes(): Promise<void> {
    const now = Date.now();
    for (const asset of this.trackedAssets()) {
      const m = this.currentMarket(asset, now);
      const q = m ? this.quotes.get(m.ticker) : undefined;
      if (!m || !q || now - q.ts < 20_000) continue;
      try {
        const km = await this.client!.market(m.ticker);
        const bid = num(km.yes_bid_dollars);
        const ask = num(km.yes_ask_dollars);
        if (!(bid > 0 && ask > 0)) continue;
        // sizes are only kept when the price is unchanged; otherwise entries wait for the next live update
        const same = Math.abs(bid - q.yesBid) < 1e-9 && Math.abs(ask - q.yesAsk) < 1e-9;
        await this.onQuote({ ...q, yesBid: bid, yesAsk: ask, last: num(km.last_price_dollars, q.last), yesBidSize: same ? q.yesBidSize : 0, yesAskSize: same ? q.yesAskSize : 0, ts: now });
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e;
      }
    }
  }

  /** Evaluate every enabled bot against the latest prices (used on the alarm clock). */
  private async evaluateAllEntries(): Promise<void> {
    const now = Date.now();
    for (const bot of this.bots) {
      if (!bot.enabled) continue;
      const d = evaluateEntry(bot.config, this.viewsFor(bot, now), now, this.edgeLookup);
      this.noteReason(bot, d, now);
      if (d.ok && d.trade) await this.attemptEntry(bot, d, now);
    }
  }

  private async checkEntries(q: Quote): Promise<void> {
    const m = this.markets.get(q.ticker);
    if (!m) return;
    const now = Date.now();
    for (const bot of this.bots) {
      if (!bot.enabled || !bot.config.assets.includes(m.asset)) continue;
      const d = evaluateEntry(bot.config, this.viewsFor(bot, now), now, this.edgeLookup);
      this.noteReason(bot, d, now);
      if (d.ok && d.trade) await this.attemptEntry(bot, d, now);
    }
  }

  /** Count why this bot isn't trading the current contract (about one sample a second, only after its Time Delay), for the chart note. */
  private sampleNote(bot: Bot, d: EntryDecision, now: number): void {
    const m = this.currentMarket(bot.config.tradeAsset, now);
    if (!m) return;
    const key = `${bot.id}|${m.ticker}`;
    if (this.entered.has(key)) return; // once it has entered, the checklist stays frozen as it was at the entry
    const n = this.notes.get(key) ?? { botId: bot.id, ticker: m.ticker, samples: 0, counts: {}, texts: {}, checks: null, last: 0, dirty: false };
    if (!d.ok && d.code !== "risk" && now - n.last < 1000) return; // about one sample a second (an entry decision, and a risk-limit block right after it, are always recorded)
    n.last = now;
    // the checklist: every requirement as it is right now (the risk line is only known once the engine has tested the limits)
    const prevRisk = n.checks?.find((c) => c.key === "risk") ?? null;
    n.checks = checklistFor(bot.config, this.viewsFor(bot, now), now, this.edgeLookup).map((c) => (c.key !== "risk" ? c : d.code === "risk" ? { key: "risk", ok: false, text: d.reason.slice(0, 200) } : d.ok && prevRisk ? prevRisk : c));
    n.dirty = true;
    this.notes.set(key, n);
    if (now - m.openTs < bot.config.timeDelaySec * 1000) return; // the "how often" counts only start after the Time Delay
    n.samples++;
    n.counts[d.code] = (n.counts[d.code] ?? 0) + 1;
    n.texts[d.code] = d.reason.slice(0, 200);
    this.notes.set(key, n);
    if (this.notes.size > 200) for (const k of this.notes.keys()) if (!this.notes.get(k)!.dirty && k !== key) this.notes.delete(k);
  }

  /** Save the probability minimum/maximum this bot is using on the current contract (for the chart's entry-minimum line). */
  private snapshotSettings(bot: Bot, now: number): void {
    const m = this.currentMarket(bot.config.tradeAsset, now);
    if (!m) return;
    const key = `${bot.id}|${m.ticker}`;
    const val = `${bot.config.probThreshold}|${bot.config.probMax}|${bot.config.timeDelaySec}`;
    if (this.settingsSeen.get(key) === val) return;
    this.settingsSeen.set(key, val);
    if (this.settingsSeen.size > 500) this.settingsSeen.delete(this.settingsSeen.keys().next().value as string);
    this.ctx.waitUntil(
      this.env.DB.prepare("INSERT INTO contract_settings (bot_id, ticker, prob_min, prob_max, delay_sec, updated_ts) VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id, ticker) DO UPDATE SET prob_min=excluded.prob_min, prob_max=excluded.prob_max, delay_sec=excluded.delay_sec, updated_ts=excluded.updated_ts")
        .bind(bot.id, m.ticker, bot.config.probThreshold, bot.config.probMax, bot.config.timeDelaySec, now)
        .run()
        .catch((e) => console.error("snapshotSettings failed", e)),
    );
  }

  private noteReason(bot: Bot, d: EntryDecision, now: number): void {
    this.snapshotSettings(bot, now);
    this.sampleNote(bot, d, now);
    const prev = this.lastReason.get(bot.id);
    const changed = !prev || prev.reason !== d.reason;
    this.lastReason.set(bot.id, { reason: d.reason, ts: prev && !changed ? prev.ts : now, up: d.upCount, down: d.downCount });
    if (changed && (!prev || now - prev.ts > 30_000 || d.ok)) {
      this.ctx.waitUntil(log(this.env, "info", "signal", `${d.ok ? "ENTER" : "Skip"}: ${d.reason}`, bot.id));
    }
  }

  private async attemptEntry(bot: Bot, d: EntryDecision, now: number): Promise<void> {
    const t = d.trade!;
    const lockKey = `entry:${bot.id}:${t.ticker}`;
    if (this.inflight.has(lockKey)) return;
    const att = this.entryAttempts.get(lockKey) ?? { n: 0, last: 0 };
    if (att.n >= 3 || now - att.last < 3_000) return;
    this.inflight.add(lockKey);
    const orderId = crypto.randomUUID();
    let submitted = false;
    try {
      // Authoritative checks right before sending: the bot must STILL be on, and every risk limit must pass.
      if (!(await isBotEnabled(this.env, bot.id))) {
        bot.enabled = false;
        return;
      }
      if (!this.client) return;
      const stats = await this.riskStats(bot);
      const cost = t.count * t.costPerContract;
      const blocked = checkRisk(bot.config, await getAccountLimits(this.env), stats, cost);
      if (blocked) {
        this.noteReason(bot, { ...d, ok: false, code: "risk", reason: `Risk limit: ${blocked}` }, now);
        return;
      }
      att.n++;
      att.last = now;
      this.entryAttempts.set(lockKey, att);

      try {
        await this.env.DB.prepare("INSERT INTO orders (id, bot_id, ticker, kind, outcome, book_side, price, count_req, status, created_ts, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(orderId, bot.id, t.ticker, "entry", t.outcome, t.orderSide, t.orderPrice, t.count, "submitted", now, now)
          .run();
      } catch {
        return; // unique index: this bot already has a live entry on this contract (duplicate protection)
      }
      submitted = true;
      let res;
      try {
        res = await this.client.createOrder({ ticker: t.ticker, clientOrderId: orderId, side: t.orderSide, count: t.count, price: t.orderPrice, reduceOnly: false });
      } catch (e) {
        await this.orderFailed(bot, orderId, t.ticker, e, "entry");
        return;
      }
      const fill = res.fillCount;
      const status = fill <= 0 ? "canceled" : res.remainingCount > 0.004 ? "partially_filled" : "filled";
      await this.env.DB.prepare("UPDATE orders SET kalshi_order_id=?, status=?, fill_count=?, avg_fill_price=?, fee=?, updated_ts=? WHERE id=?")
        .bind(res.orderId, status, fill, res.avgFillPrice, r2(res.avgFee * fill), Date.now(), orderId)
        .run();
      if (fill <= 0) {
        await log(this.env, "info", "order", `Entry ${t.asset} ${t.outcome.toUpperCase()} x${t.count} @ ${t.orderPrice} got no fill (IOC canceled)`, bot.id);
        return;
      }
      const yesPrice = res.avgFillPrice ?? t.orderPrice;
      const ourPrice = t.outcome === "yes" ? yesPrice : 1 - yesPrice;
      const fee = res.avgFee * fill;
      const pos: PositionRow = {
        id: crypto.randomUUID(),
        bot_id: bot.id,
        ticker: t.ticker,
        asset: t.asset,
        outcome: t.outcome,
        entry_qty: fill,
        open_qty: fill,
        avg_entry: ourPrice,
        entry_cost: fill * ourPrice,
        entry_fee: fee,
        exit_proceeds: 0,
        exit_fee: 0,
        status: "open",
        opened_ts: Date.now(),
        closed_ts: null,
        close_reason: null,
        market_close_ts: t.market.closeTs,
        entry_prob: t.prob,
        exit_prob: null,
        fav_max: t.prob,
        fav_min: t.prob,
        prob_before_close: t.prob,
        agree_count: t.direction === "up" ? d.upCount : d.downCount,
        duration_min: bot.config.durationMin,
        realized_pnl: null,
        result: null,
      };
      await this.env.DB.batch([
        this.env.DB.prepare("INSERT INTO positions (id, bot_id, ticker, asset, outcome, entry_qty, open_qty, avg_entry, entry_cost, entry_fee, exit_proceeds, exit_fee, status, opened_ts, market_close_ts, entry_prob, fav_max, fav_min, prob_before_close, agree_count, duration_min) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(
          pos.id, pos.bot_id, pos.ticker, pos.asset, pos.outcome, pos.entry_qty, pos.open_qty, pos.avg_entry, pos.entry_cost, pos.entry_fee, 0, 0, "open", pos.opened_ts, pos.market_close_ts, pos.entry_prob, pos.fav_max, pos.fav_min, pos.prob_before_close, pos.agree_count, pos.duration_min,
        ),
        this.env.DB.prepare("UPDATE orders SET position_id = ? WHERE id = ?").bind(pos.id, orderId),
      ]);
      this.posCache.set(pos.id, pos);
      this.entered.add(`${bot.id}|${t.ticker}`);
      // freeze the checklist as it was at the entry: the risk limits passed too
      const frozen = this.notes.get(`${bot.id}|${t.ticker}`);
      if (frozen?.checks) {
        frozen.checks = frozen.checks.map((c) => (c.key === "risk" ? { key: "risk", ok: true, text: "Risk limits passed" } : c));
        frozen.dirty = true;
      }
      this.balance = null; // balance changed
      await log(this.env, "info", "order", `ENTERED ${t.asset} ${t.outcome.toUpperCase()} x${fill}${status === "partially_filled" ? ` (partial, wanted ${t.count})` : ""} @ ${ourPrice.toFixed(3)} fee $${fee.toFixed(3)} — ${d.reason}`, bot.id, { orderId: res.orderId });
      if (bot.config.notify === "immediate") {
        await sendEmail(this.env, `Purple Bot entered ${t.asset} ${t.outcome.toUpperCase()}`, emailShell("Trade entered", `<p><b>${esc(bot.name)}</b> bought ${fill} ${t.outcome.toUpperCase()} contract(s) on ${esc(t.ticker)} at $${ourPrice.toFixed(3)} (fee $${fee.toFixed(3)}).</p><p>Why: ${esc(d.reason)}</p>`));
      }
    } finally {
      this.inflight.delete(lockKey);
      if (submitted) await this.flush().catch(() => {});
    }
  }

  private async orderFailed(bot: Bot | null, orderId: string, ticker: string, e: unknown, kind: "entry" | "exit"): Promise<void> {
    const definite = e instanceof KalshiHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
    const msg = (e as Error).message;
    await this.env.DB.prepare("UPDATE orders SET status=?, error=?, updated_ts=? WHERE id=?").bind(definite ? "rejected" : "submitted", msg.slice(0, 500), Date.now(), orderId).run();
    if (!definite) {
      // We cannot know whether Kalshi accepted it. Keep the row 'submitted' (blocks duplicates) and force a reconcile.
      this.reconciled = false;
      this.reconcileProblem = "An order result was unclear after a network error; checking your Kalshi account";
    }
    await log(this.env, "error", "order", `${kind} order FAILED on ${ticker}: ${msg}`, bot?.id ?? null);
    if (e instanceof KalshiAuthError) this.authError = msg;
    await this.critical(`order-${kind}-${ticker}`, kind === "entry" ? "Order failed" : "Closing order failed", `${kind === "entry" ? "An entry" : "A closing"} order on ${esc(ticker)} failed: ${esc(msg)}${definite ? "" : "<br><b>The result is unclear</b>: the bot will not place new orders until it has checked your Kalshi account."}`);
  }

  private async riskStats(bot: Bot): Promise<RiskStats> {
    const now = Date.now();
    const day = dayStartMs(now);
    const q = async (sql: string, ...b: unknown[]) => (await this.env.DB.prepare(sql).bind(...b).first<Record<string, number>>()) ?? {};
    const [openBot, openAll, trades, invBot, invAll, pnlBot, pnlAll, pending] = await Promise.all([
      q("SELECT COUNT(*) c FROM positions WHERE status='open' AND bot_id=?", bot.id),
      q("SELECT COUNT(*) c FROM positions WHERE status='open'"),
      q("SELECT COUNT(*) c FROM orders WHERE kind='entry' AND bot_id=? AND fill_count>0 AND created_ts>=?", bot.id, now - 3_600_000),
      q("SELECT COALESCE(SUM(entry_cost+entry_fee),0) c FROM positions WHERE bot_id=? AND opened_ts>=?", bot.id, day),
      q("SELECT COALESCE(SUM(entry_cost+entry_fee),0) c FROM positions WHERE opened_ts>=?", day),
      q("SELECT COALESCE(SUM(realized_pnl),0) c FROM positions WHERE bot_id=? AND closed_ts>=? AND realized_pnl IS NOT NULL", bot.id, day),
      q("SELECT COALESCE(SUM(realized_pnl),0) c FROM positions WHERE closed_ts>=? AND realized_pnl IS NOT NULL", day),
      q("SELECT COUNT(*) c FROM orders WHERE status='submitted'"),
    ]);
    const bal = await this.getBalance();
    return {
      botOpenPositions: openBot.c ?? 0,
      accountOpenPositions: openAll.c ?? 0,
      botTradesLastHour: trades.c ?? 0,
      botInvestedToday: invBot.c ?? 0,
      accountInvestedToday: invAll.c ?? 0,
      botNetPnlToday: pnlBot.c ?? 0,
      accountNetPnlToday: pnlAll.c ?? 0,
      pendingOrders: (pending.c ?? 0) + [...this.inflight].filter((k) => k.startsWith("exit:")).length,
      balance: bal,
      reconciled: this.reconciled,
    };
  }

  private async getBalance(): Promise<number | null> {
    if (this.balance && Date.now() - this.balance.ts < BALANCE_MAX_AGE_MS) return this.balance.value;
    if (!this.client) return null;
    try {
      const b = await this.client.balance();
      this.balance = { value: b.balance, portfolio: b.portfolioValue, ts: Date.now() };
      return b.balance;
    } catch (e) {
      if (e instanceof KalshiAuthError) await this.handleError("balance", e);
      return null;
    }
  }

  private async refreshBalanceIfStale(): Promise<void> {
    if (!this.balance || Date.now() - this.balance.ts > 60_000) await this.getBalance();
  }

  // ---------------------------------------------------------------- exits

  private async checkExits(q: Quote): Promise<void> {
    for (const p of [...this.posCache.values()]) {
      if (p.ticker !== q.ticker) continue;
      const requested = this.closeRequests.get(p.id);
      if (requested) {
        await this.closePosition(p, requested, q);
        continue;
      }
      const bot = this.bots.find((b) => b.id === p.bot_id);
      if (!bot) continue;
      const open: OpenPos = { outcome: p.outcome, openQty: p.open_qty, avgEntry: p.avg_entry ?? 0, entryFee: p.entry_fee, exitFee: p.exit_fee, exitProceeds: p.exit_proceeds };
      const reason = evaluateExit(bot.config, open, q);
      if (reason) await this.closePosition(p, reason, q);
    }
  }

  private async processCloseRequests(): Promise<void> {
    for (const [id, reason] of [...this.closeRequests]) {
      const p = this.posCache.get(id);
      if (!p) {
        this.closeRequests.delete(id);
        continue;
      }
      const q = this.quotes.get(p.ticker);
      if (q && Date.now() < p.market_close_ts) await this.closePosition(p, reason, q);
    }
  }

  private async closePosition(p: PositionRow, reason: string, q: Quote): Promise<void> {
    const lockKey = `exit:${p.id}`;
    if (this.inflight.has(lockKey)) return;
    const now = Date.now();
    if (now - (this.lastExitAttempt.get(p.id) ?? 0) < 3_000) return;
    if (now >= p.market_close_ts) return; // contract over: settlement path handles it
    if (!this.client || q.yesBid <= 0 || q.yesAsk <= 0) return;
    this.lastExitAttempt.set(p.id, now);
    this.inflight.add(lockKey);
    const orderId = crypto.randomUUID();
    try {
      // YES position: sell YES (ask) at the YES bid. NO position: buy YES (bid) at the YES ask. Always reduce-only IOC.
      const side = p.outcome === "yes" ? "ask" : "bid";
      const price = p.outcome === "yes" ? q.yesBid : q.yesAsk;
      const qty = r2(p.open_qty);
      if (qty < 0.01) return;
      await this.env.DB.prepare("INSERT INTO orders (id, bot_id, position_id, ticker, kind, outcome, book_side, price, count_req, status, created_ts, updated_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(orderId, p.bot_id, p.id, p.ticker, "exit", p.outcome, side, price, qty, "submitted", now, now)
        .run();
      let res;
      try {
        res = await this.client.createOrder({ ticker: p.ticker, clientOrderId: orderId, side, count: qty, price, reduceOnly: true });
      } catch (e) {
        await this.orderFailed(this.bots.find((b) => b.id === p.bot_id) ?? null, orderId, p.ticker, e, "exit");
        return;
      }
      const fill = res.fillCount;
      const status = fill <= 0 ? "canceled" : res.remainingCount > 0.004 ? "partially_filled" : "filled";
      await this.env.DB.prepare("UPDATE orders SET kalshi_order_id=?, status=?, fill_count=?, avg_fill_price=?, fee=?, updated_ts=? WHERE id=?")
        .bind(res.orderId, status, fill, res.avgFillPrice, r2(res.avgFee * fill), Date.now(), orderId)
        .run();
      if (fill <= 0) {
        await log(this.env, "warn", "order", `Close (${reason}) of ${p.asset} ${p.outcome.toUpperCase()} got no fill; still monitoring`, p.bot_id);
        await this.alertCloseIncomplete(p, reason, "no contracts were filled");
        return;
      }
      const yesPrice = res.avgFillPrice ?? price;
      const ourPrice = p.outcome === "yes" ? yesPrice : 1 - yesPrice;
      p.exit_proceeds += fill * ourPrice;
      p.exit_fee += res.avgFee * fill;
      p.open_qty = r2(Math.max(0, p.open_qty - fill));
      this.balance = null;
      if (p.open_qty < 0.01) {
        await this.finalize(p, reason, q);
      } else {
        await this.env.DB.prepare("UPDATE positions SET open_qty=?, exit_proceeds=?, exit_fee=? WHERE id=?").bind(p.open_qty, p.exit_proceeds, p.exit_fee, p.id).run();
        await log(this.env, "warn", "order", `Partial close (${reason}): ${fill} filled, ${p.open_qty} still open on ${p.asset}`, p.bot_id);
        await this.alertCloseIncomplete(p, reason, `only ${fill} of ${qty} contracts filled`);
      }
    } finally {
      this.inflight.delete(lockKey);
    }
  }

  private async alertCloseIncomplete(p: PositionRow, reason: string, why: string): Promise<void> {
    await this.critical(`close-${p.id}`, "Closing order incomplete", `Trying to close ${esc(p.asset)} ${p.outcome.toUpperCase()} (${esc(reason)}): ${esc(why)}. ${p.open_qty} contract(s) are still open. The bot keeps retrying and monitoring.`, 600_000);
  }

  private async finalize(p: PositionRow, reason: string, q: Quote | undefined): Promise<void> {
    const fav = q ? favorableProb(p.outcome, yesProb(q)) : this.lastFav.get(p.id) ?? p.prob_before_close;
    const pnl = r2(p.exit_proceeds - p.entry_cost - p.entry_fee - p.exit_fee);
    const result = pnl > 0.004 ? "win" : pnl < -0.004 ? "loss" : "flat";
    p.status = reason === "settled" ? "settled" : "closed";
    p.closed_ts = Date.now();
    p.close_reason = reason;
    p.realized_pnl = pnl;
    p.result = result;
    p.exit_prob = fav ?? null;
    await this.env.DB.prepare("UPDATE positions SET status=?, open_qty=0, closed_ts=?, close_reason=?, exit_proceeds=?, exit_fee=?, exit_prob=?, fav_max=?, fav_min=?, prob_before_close=?, realized_pnl=?, result=? WHERE id=?")
      .bind(p.status, p.closed_ts, reason, p.exit_proceeds, p.exit_fee, p.exit_prob, p.fav_max, p.fav_min, p.prob_before_close, pnl, result, p.id)
      .run();
    this.posCache.delete(p.id);
    this.dirtyPos.delete(p.id);
    this.closeRequests.delete(p.id);
    await log(this.env, "info", "order", `CLOSED ${p.asset} ${p.outcome.toUpperCase()} (${reason}): ${result.toUpperCase()} $${pnl.toFixed(2)} after fees`, p.bot_id);
    const bot = this.bots.find((b) => b.id === p.bot_id);
    if (bot?.config.notify === "immediate") {
      await sendEmail(this.env, `Purple Bot closed ${p.asset}: ${result} $${pnl.toFixed(2)}`, emailShell("Trade closed", `<p><b>${esc(bot.name)}</b> closed ${esc(p.asset)} ${p.outcome.toUpperCase()} (${esc(reason)}).</p><p>Result: <b>${result.toUpperCase()}</b> $${pnl.toFixed(2)} after fees.</p>`));
    }
    const every = bot?.config.notifyEveryTrades ?? 0;
    if (bot && every > 0) {
      const total = (await this.env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE bot_id=? AND status IN ('closed','settled')").bind(bot.id).first<{ n: number }>())?.n ?? 0;
      if (total > 0 && total % every === 0) {
        const rows = (await this.env.DB.prepare("SELECT realized_pnl, result FROM positions WHERE bot_id=? AND status IN ('closed','settled') ORDER BY closed_ts DESC LIMIT ?").bind(bot.id, every).all<{ realized_pnl: number | null; result: string | null }>()).results ?? [];
        const wins = rows.filter((r) => r.result === "win").length;
        const losses = rows.filter((r) => r.result === "loss").length;
        const net = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
        const bal = this.balance != null ? ` Account balance: $${this.balance.value.toFixed(2)}.` : "";
        await sendEmail(this.env, `Purple Bot: ${every} more trades finished (${esc(bot.name)})`, emailShell("Trade batch finished", `<p><b>${esc(bot.name)}</b> finished ${every} trades: <b>${wins}</b> won, <b>${losses}</b> lost, net <b>$${net.toFixed(2)}</b> after fees.</p><p>Current trade amount: $${bot.config.tradeAmount.toFixed(2)}.${bal} Total finished trades for this bot: ${total}.</p>`));
      }
    }
  }

  // ---------------------------------------------------------------- settlement + reconciliation

  private async checkSettlements(): Promise<void> {
    const now = Date.now();
    for (const p of [...this.posCache.values()]) {
      if (now < p.market_close_ts + 15_000) continue;
      if (now - (this.settleChecked.get(p.id) ?? 0) < 30_000) continue;
      this.settleChecked.set(p.id, now);
      if (!this.client) return;
      try {
        const m = await this.client.market(p.ticker);
        const result = (m.result ?? "").toLowerCase();
        if (result !== "yes" && result !== "no") {
          if (now - p.market_close_ts > 1_800_000) await this.critical(`unsettled-${p.id}`, "Contract not settled yet", `${esc(p.ticker)} closed over 30 minutes ago and Kalshi has not reported a result. The position is still tracked.`, 3_600_000);
          continue;
        }
        await this.env.DB.prepare("UPDATE markets SET result=?, status=? WHERE ticker=?").bind(result, m.status, p.ticker).run();
        const won = result === p.outcome;
        p.exit_proceeds += p.open_qty * (won ? 1 : 0);
        p.open_qty = 0;
        // Settlement "probability" is the realized outcome itself: 100% if our side won, 0% if not.
        const q: Quote | undefined = undefined;
        await this.finalize(p, "settled", q);
        await this.env.DB.prepare("UPDATE positions SET exit_prob=? WHERE id=?").bind(won ? 1 : 0, p.id).run();
        this.balance = null;
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e;
        await log(this.env, "warn", "system", `Settlement check failed for ${p.ticker}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Save the final result (yes/no) of every contract that has closed, not only the ones we held to settlement. Without this,
   * trades we exited early (stop loss / take profit) never learn how their contract finally settled, which breaks the
   * "would holding have won?" analysis, the reliability-by-hour numbers and backtests (they skip unsettled contracts).
   */
  private async readHistoryRunning(): Promise<boolean> {
    try {
      const raw = await getSetting(this.env, "history_job");
      return !!raw && (JSON.parse(raw) as { status?: string }).status === "running";
    } catch {
      return false;
    }
  }

  /**
   * Load past contracts from Kalshi's own 1-minute price history into the edge history, a few per tick, in the order the owner chose
   * (gold first). Contracts the bot recorded itself, or an earlier load already counted, are skipped so nothing is counted twice.
   */
  private async historyJobTick(): Promise<void> {
    if (!this.historyRunning || !this.client) return;
    const raw = await getSetting(this.env, "history_job");
    if (!raw) return;
    const job = JSON.parse(raw) as { status: string; assets: string[]; days: number; idx: number; queue: Array<{ ticker: string; closeTs: number; result: "yes" | "no" }>; cursor: string | null; listed: boolean; counted: number; skipped: number; failed: number; startedAt: number; message: string };
    if (job.status !== "running") return;
    const save = () => setSetting(this.env, "history_job", JSON.stringify(job));
    try {
      const asset = job.assets[job.idx];
      if (!asset) {
        job.status = "done";
        job.message = `Done: ${job.counted} past contracts counted`;
        await save();
        return;
      }
      const series = await this.seriesFor(asset);
      if (job.queue.length === 0 && !job.listed) {
        // one page of this asset's settled contracts
        const page = await this.client.settledMarkets(series, Math.floor((Date.now() - job.days * 86_400_000) / 1000), job.cursor ?? undefined);
        for (const m of page.markets) {
          const result = (m.result ?? "").toLowerCase();
          const closeTs = Date.parse(m.close_time);
          if ((result === "yes" || result === "no") && Number.isFinite(closeTs)) job.queue.push({ ticker: m.ticker, closeTs, result });
        }
        job.cursor = page.cursor ?? null;
        if (!page.cursor) job.listed = true;
        job.message = `Loading ${asset}: ${job.queue.length} contracts listed`;
      } else {
        const batch = job.queue.splice(0, 20);
        const marks = batch.map(() => "?").join(",");
        const known = new Set<string>();
        if (batch.length) {
          const t = batch.map((b) => b.ticker);
          for (const r of (await this.env.DB.prepare(`SELECT ticker FROM markets WHERE ticker IN (${marks})`).bind(...t).all<{ ticker: string }>()).results ?? []) known.add(r.ticker); // the bot recorded these itself
          for (const r of (await this.env.DB.prepare(`SELECT ticker FROM calibration_done WHERE ticker IN (${marks})`).bind(...t).all<{ ticker: string }>()).results ?? []) known.add(r.ticker);
        }
        for (let i = 0; i < batch.length; i++) {
          const b = batch[i];
          if (known.has(b.ticker)) {
            job.skipped++;
            continue;
          }
          try {
            const candles = await this.client.candlesticks(series, b.ticker, Math.floor(b.closeTs / 1000) - 16 * 60, Math.floor(b.closeTs / 1000));
            const samples = samplesFromCandles(candles, b.closeTs);
            const up = this.env.DB.prepare("INSERT INTO calibration (asset, minute_left, bucket, n, yes_wins) VALUES (?,?,?,1,?) ON CONFLICT(asset, minute_left, bucket) DO UPDATE SET n = n + 1, yes_wins = yes_wins + excluded.yes_wins");
            const stmts = samples.map((x) => up.bind(asset, x.minuteLeft, x.bucket, b.result === "yes" ? 1 : 0));
            stmts.push(this.env.DB.prepare("INSERT OR IGNORE INTO calibration_done (ticker, asset, counted_ts) VALUES (?,?,?)").bind(b.ticker, asset, Date.now()));
            await this.env.DB.batch(stmts);
            job.counted++;
          } catch (e) {
            if (e instanceof KalshiAuthError) throw e;
            if (e instanceof KalshiHttpError && e.status === 429) {
              job.queue.unshift(...batch.slice(i)); // Kalshi asked us to slow down: try these again next tick
              break;
            }
            job.failed++;
          }
        }
        job.message = `Loading ${asset}: ${job.counted} counted, ${job.queue.length} left in this batch of contracts`;
      }
      if (job.queue.length === 0 && job.listed) {
        job.idx++;
        job.listed = false;
        job.cursor = null;
        if (job.idx >= job.assets.length) {
          job.status = "done";
          job.message = `Done: ${job.counted} past contracts counted (${job.skipped} already known, ${job.failed} failed)`;
        }
      }
      await save();
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message.slice(0, 300);
      await save();
    }
  }

  /** Count settled contracts into the history table the edge rule learns from: a few per tick, each exactly once, newest first. */
  private async calibrateSettled(): Promise<void> {
    const rows = (await this.env.DB.prepare("SELECT ticker, asset, close_ts, result FROM markets WHERE calibrated = 0 AND result IN ('yes','no') ORDER BY close_ts DESC LIMIT 6").all<{ ticker: string; asset: string; close_ts: number; result: string }>()).results ?? [];
    for (const r of rows) {
      const obs = (await this.env.DB.prepare("SELECT ts, yes_bid, yes_ask FROM observations WHERE ticker = ? AND ts < ? ORDER BY ts").bind(r.ticker, r.close_ts).all<{ ts: number; yes_bid: number; yes_ask: number }>()).results ?? [];
      const samples = samplesFromObs(obs.map((o) => ({ ts: o.ts, bid: o.yes_bid, ask: o.yes_ask })), r.close_ts);
      const up = this.env.DB.prepare("INSERT INTO calibration (asset, minute_left, bucket, n, yes_wins) VALUES (?,?,?,1,?) ON CONFLICT(asset, minute_left, bucket) DO UPDATE SET n = n + 1, yes_wins = yes_wins + excluded.yes_wins");
      const stmts = samples.map((x) => up.bind(r.asset, x.minuteLeft, x.bucket, r.result === "yes" ? 1 : 0));
      stmts.push(this.env.DB.prepare("UPDATE markets SET calibrated = 1 WHERE ticker = ?").bind(r.ticker));
      await this.env.DB.batch(stmts);
    }
  }

  /** Load the history table for every asset an enabled edge bot trades (cheap: at most 15 x 40 rows per asset, once a minute). */
  private async refreshEdgeTables(): Promise<void> {
    const now = Date.now();
    const assets = new Set(this.bots.filter((b) => b.enabled && b.config.minEdge > 0).map((b) => b.config.tradeAsset));
    for (const asset of assets) {
      const c = this.edgeCache.get(asset);
      if (c && now - c.at < 60_000) continue;
      const rows = (await this.env.DB.prepare("SELECT minute_left, bucket, n, yes_wins FROM calibration WHERE asset = ?").bind(asset).all<{ minute_left: number; bucket: number; n: number; yes_wins: number }>()).results ?? [];
      this.edgeCache.set(asset, { at: now, cells: new Map(rows.map((r) => [r.minute_left * 100 + r.bucket, { n: r.n, yesWins: r.yes_wins }])) });
    }
  }

  private async backfillResults(): Promise<void> {
    if (!this.client) return;
    const now = Date.now();
    const rows = (await this.env.DB.prepare("SELECT ticker FROM markets WHERE result IS NULL AND close_ts < ? AND close_ts > ? ORDER BY close_ts DESC LIMIT 16").bind(now - 45_000, now - 7 * 86_400_000).all<{ ticker: string }>()).results ?? [];
    let looked = 0;
    for (const r of rows) {
      if (looked >= 4) break; // a few lookups per tick keeps Kalshi traffic tiny
      if (now - (this.resultTried.get(r.ticker) ?? 0) < 120_000) continue; // not decided yet: try again in two minutes
      this.resultTried.set(r.ticker, now);
      looked++;
      try {
        const m = await this.client.market(r.ticker);
        const result = (m.result ?? "").toLowerCase();
        if (result === "yes" || result === "no") await this.env.DB.prepare("UPDATE markets SET result=?, status=? WHERE ticker=?").bind(result, m.status, r.ticker).run();
      } catch (e) {
        if (e instanceof KalshiAuthError) throw e;
      }
    }
    if (this.resultTried.size > 2000) this.resultTried.clear();
  }

  /** Compare our records with Kalshi's real positions. New orders stay blocked until they agree. */
  private async reconcile(): Promise<void> {
    if (!this.client) return;
    this.lastReconcile = Date.now();
    try {
      const acct = await this.client.positions();
      const byTicker = new Map(acct.map((a) => [a.ticker, a.position]));
      const local = new Map<string, number>();
      for (const p of this.posCache.values()) local.set(p.ticker, (local.get(p.ticker) ?? 0) + (p.outcome === "yes" ? p.open_qty : -p.open_qty));
      const problems: string[] = [];
      const now = Date.now();
      for (const [ticker, qty] of local) {
        const real = byTicker.get(ticker) ?? 0;
        const closeTs = [...this.posCache.values()].find((p) => p.ticker === ticker)?.market_close_ts ?? 0;
        if (Math.abs(real - qty) < 0.005 || now >= closeTs) continue;
        if (Math.abs(real) < Math.abs(qty)) {
          // Kalshi shows less than we think (closed by hand?): trust Kalshi and shrink our record.
          for (const p of [...this.posCache.values()].filter((x) => x.ticker === ticker)) {
            await this.env.DB.prepare("UPDATE positions SET status='closed', open_qty=0, closed_ts=?, close_reason='external' WHERE id=?").bind(now, p.id).run();
            this.posCache.delete(p.id);
          }
          await log(this.env, "warn", "system", `Reconcile: ${ticker} was smaller on Kalshi (${real}) than recorded (${qty}); record closed as external`);
        } else {
          problems.push(`${ticker}: Kalshi holds ${real} but the bot recorded ${qty}`);
        }
      }
      for (const [ticker, real] of byTicker) {
        const ours = this.markets.get(ticker);
        if (ours && now < ours.closeTs && Math.abs(real) > 0.005 && !local.has(ticker)) problems.push(`${ticker}: Kalshi holds ${real} that the bot did not record`);
      }
      if ([...this.inflight].some((k) => k.startsWith("entry:") || k.startsWith("exit:"))) return; // order mid-flight: check again next tick
      const unclear = await this.env.DB.prepare("SELECT COUNT(*) c FROM orders WHERE status='submitted' AND created_ts < ?").bind(now - 20_000).first<{ c: number }>();
      if ((unclear?.c ?? 0) > 0 && problems.length === 0) {
        // Positions agree, so unresolved 'submitted' rows did not create exposure: resolve them as canceled.
        await this.env.DB.prepare("UPDATE orders SET status='canceled', error=COALESCE(error,'')||' (resolved by reconcile: no position change)' WHERE status='submitted' AND created_ts < ?").bind(now - 20_000).run();
      }
      this.reconcileProblem = problems.length ? problems.join("; ") : null;
      this.reconciled = problems.length === 0;
      if (problems.length) await this.critical("reconcile", "Account does not match bot records", `New orders are blocked until this is fixed:<br>${problems.map(esc).join("<br>")}<br>Close the extra position on Kalshi (or use Stop and Close All), then press Reconcile.`, 1_800_000);
    } catch (e) {
      this.reconciled = false;
      await this.handleError("reconcile", e);
    }
  }

  // ---------------------------------------------------------------- alerts + errors

  private async critical(key: string, subject: string, bodyHtml: string, minGapMs = 300_000): Promise<void> {
    const now = Date.now();
    if (now - (this.lastAlert.get(key) ?? 0) < minGapMs) return;
    this.lastAlert.set(key, now);
    await sendEmail(this.env, `[Purple Bot] ${subject}`, emailShell(subject, `<p>${bodyHtml}</p>`)); // critical alerts always go out immediately
  }

  private async handleError(where: string, e: unknown): Promise<void> {
    const msg = (e as Error)?.message ?? String(e);
    await log(this.env, "error", "error", `${where}: ${msg}`);
    if (e instanceof KalshiAuthError) {
      this.authError = msg;
      this.credentialsOk = false;
      this.client = null;
      this.closeSocket();
      await this.critical("auth", "Kalshi authentication error", `Kalshi rejected the API credentials: ${esc(msg)}. Trading is paused until the key is replaced.`, 1_800_000);
    } else {
      await this.critical(`err-${where}`, "System error", `${esc(where)}: ${esc(msg)}`, 900_000);
    }
  }

  // ---------------------------------------------------------------- daily overview

  /** Once a new US-Eastern day starts, review the day that just ended (no trade-by-trade recap; see analysis.ts). */
  private async dailyJobs(): Promise<void> {
    const now = Date.now();
    const today = etDateString(now);
    const last = await getSetting(this.env, "last_overview_date");
    if (!last) {
      await setSetting(this.env, "last_overview_date", today); // first run: start counting from today
      return;
    }
    if (last === today) return;
    await setSetting(this.env, "last_overview_date", today); // set first: a crash can never cause a retry loop
    const end = dayStartMs(now);
    const start = dayStartMs(end - 3_600_000);
    const active = await this.env.DB.prepare("SELECT (SELECT COUNT(*) FROM positions WHERE opened_ts >= ?1 AND opened_ts < ?2) + (SELECT COUNT(*) FROM contract_notes WHERE updated_ts >= ?1 AND updated_ts < ?2) c").bind(start, end).first<{ c: number }>();
    if ((active?.c ?? 0) === 0) return; // nothing happened that day
    const o = await runOverview(this.env, start, end, etDateString(start));
    if (this.bots.some((b) => b.config.notify === "daily")) await sendEmail(this.env, `Purple Bot daily overview: ${etDateString(start)}`, overviewEmail(o));
  }

  private unrealizedOf(p: PositionRow): number | null {
    const q = this.quotes.get(p.ticker);
    if (!q || q.yesBid <= 0) return null;
    return r2(unrealizedPnl({ outcome: p.outcome, openQty: p.open_qty, avgEntry: p.avg_entry ?? 0, entryFee: p.entry_fee, exitFee: p.exit_fee, exitProceeds: p.exit_proceeds }, q));
  }

  // ---------------------------------------------------------------- dashboard snapshot

  private async liveState(): Promise<LiveState> {
    const now = Date.now();
    const assets = new Set<string>(this.trackedAssets());
    const list: LiveState["assets"] = [];
    for (const asset of [...CRYPTO_ASSETS, ...METAL_ASSETS]) {
      if (!assets.has(asset)) continue;
      const m = this.currentMarket(asset, now);
      const q = m ? this.quotes.get(m.ticker) : undefined;
      const yes = q && q.yesBid > 0 && q.yesAsk > 0 ? yesProb(q) : null;
      list.push({
        asset,
        series: await this.seriesFor(asset),
        ticker: m?.ticker ?? null,
        title: m?.title ?? null,
        openTs: m?.openTs ?? null,
        closeTs: m?.closeTs ?? null,
        nextOpenTs: this.nextOpen.get(asset) ?? null,
        yes,
        no: yes === null ? null : 1 - yes,
        bid: q?.yesBid ?? null,
        ask: q?.yesAsk ?? null,
        quoteAgeMs: q ? now - q.ts : null,
      });
    }
    return {
      now,
      connected: !!this.ws,
      restFallback: this.restFallback,
      reconciled: this.reconciled,
      reconcileProblem: this.reconcileProblem,
      credentialsOk: this.credentialsOk,
      authError: this.authError,
      balance: this.balance?.value ?? null,
      portfolioValue: this.balance?.portfolio ?? null,
      assets: list,
      bots: this.bots.map((b) => {
        const r = this.lastReason.get(b.id);
        return { id: b.id, enabled: b.enabled, reason: r?.reason ?? (b.enabled ? "Waiting for data" : "Off"), up: r?.up ?? 0, down: r?.down ?? 0 };
      }),
      positions: [...this.posCache.values()].map((p) => ({ ...p, unrealized: this.unrealizedOf(p), favNow: this.lastFav.get(p.id) ?? null })),
    };
  }
}

const fmtP = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
void directionOf;
void sleep;
