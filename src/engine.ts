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
import { askAI, emailShell, esc, sendEmail } from "./notify";
import { computePerformance } from "./stats";
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
  private obsBuf: Array<[string, number, number, number, number]> = [];
  private lastObs = new Map<string, number>();
  private lastObsKey = new Map<string, string>();

  private inflight = new Set<string>();
  private closeRequests = new Map<string, string>();
  private lastExitAttempt = new Map<string, number>();
  private entryAttempts = new Map<string, { n: number; last: number }>();
  private lastReason = new Map<string, { reason: string; ts: number; up: number; down: number }>();
  private lastAlert = new Map<string, number>();
  private settleChecked = new Map<string, number>();
  private notes = new Map<string, { botId: string; ticker: string; samples: number; counts: Record<string, number>; texts: Record<string, string>; last: number; dirty: boolean }>();

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
      wanted = this.bots.some((b) => b.enabled) || this.posCache.size > 0 || now < this.watchUntil;
      if (!wanted) {
        this.closeSocket();
        return; // no alarm rescheduled -> Cloudflare can evict us
      }
      if (!(await this.ensureClient())) return; // no credentials: stay idle, no alarm
      await this.discoverIfNeeded();
      if (!this.ws) await this.openSocket();
      if (!this.ws || this.restFallback) await this.restPoll();
      else await this.refreshQuietQuotes();
      if (!this.reconciled || now - this.lastReconcile > 300_000) await this.reconcile();
      await this.refreshBalanceIfStale();
      // Check entries on the clock too, not only when a price message arrives: the Time Delay can
      // pass, or a quiet market can sit still, with no new message to trigger a check.
      await this.evaluateAllEntries();
      await this.flush();
      await this.checkSettlements();
      await this.processCloseRequests();
      await this.hourlyJobs();
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
    const want = [...this.markets.keys()].filter((t) => !this.subscribed.has(t));
    if (want.length === 0) return;
    try {
      if (this.sid === null && this.subscribed.size === 0) {
        this.ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["ticker"], market_tickers: want } }));
      } else if (this.sid !== null) {
        this.ws.send(JSON.stringify({ id: Date.now() % 1_000_000, cmd: "update_subscription", params: { sids: [this.sid], market_tickers: want, action: "add_markets" } }));
      } else {
        return; // waiting for the subscribed reply
      }
      for (const t of want) this.subscribed.add(t);
    } catch (e) {
      console.error("subscribe send failed", e);
    }
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
      }
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
    this.obsBuf.push([q.ticker, q.ts, q.yesBid, q.yesAsk, q.last]);
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
      const ins = this.env.DB.prepare("INSERT INTO observations (ticker, ts, yes_bid, yes_ask, last) VALUES (?,?,?,?,?)");
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
    const upNote = this.env.DB.prepare("INSERT INTO contract_notes (bot_id, ticker, samples, counts, texts, updated_ts) VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id, ticker) DO UPDATE SET samples=excluded.samples, counts=excluded.counts, texts=excluded.texts, updated_ts=excluded.updated_ts");
    for (const n of this.notes.values()) {
      if (!n.dirty) continue;
      n.dirty = false;
      stmts.push(upNote.bind(n.botId, n.ticker, n.samples, JSON.stringify(n.counts), JSON.stringify(n.texts), Date.now()));
    }
    if (stmts.length) await this.env.DB.batch(stmts);
  }

  // ---------------------------------------------------------------- entries

  private viewsFor(bot: Bot, now: number): AssetView[] {
    return bot.config.assets.map((asset) => {
      const market = this.currentMarket(asset, now);
      return { asset, market, quote: market ? this.quotes.get(market.ticker) ?? null : null };
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
      const d = evaluateEntry(bot.config, this.viewsFor(bot, now), now);
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
      const d = evaluateEntry(bot.config, this.viewsFor(bot, now), now);
      this.noteReason(bot, d, now);
      if (d.ok && d.trade) await this.attemptEntry(bot, d, now);
    }
  }

  /** Count why this bot isn't trading the current contract (about one sample a second, only after its Time Delay), for the chart note. */
  private sampleNote(bot: Bot, d: EntryDecision, now: number): void {
    const m = this.currentMarket(bot.config.tradeAsset, now);
    if (!m || now - m.openTs < bot.config.timeDelaySec * 1000) return;
    const key = `${bot.id}|${m.ticker}`;
    const n = this.notes.get(key) ?? { botId: bot.id, ticker: m.ticker, samples: 0, counts: {}, texts: {}, last: 0, dirty: false };
    if (now - n.last < 1000) return;
    n.last = now;
    n.samples++;
    n.counts[d.code] = (n.counts[d.code] ?? 0) + 1;
    n.texts[d.code] = d.reason.slice(0, 200);
    n.dirty = true;
    this.notes.set(key, n);
    if (this.notes.size > 200) for (const k of this.notes.keys()) if (!this.notes.get(k)!.dirty && k !== key) this.notes.delete(k);
  }

  private noteReason(bot: Bot, d: EntryDecision, now: number): void {
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

  // ---------------------------------------------------------------- hourly analysis + summaries

  private async hourlyJobs(): Promise<void> {
    const now = Date.now();
    const lastAnalysis = Number((await getSetting(this.env, "last_analysis_ts")) ?? 0);
    if (now - lastAnalysis >= 3_600_000) {
      const openAssets = this.trackedAssets().filter((a) => this.currentMarket(a, now));
      const recent = await this.env.DB.prepare("SELECT COUNT(*) c FROM positions WHERE opened_ts >= ? OR closed_ts >= ?").bind(now - 3_600_000, now - 3_600_000).first<{ c: number }>();
      // All relevant markets closed -> skip (and keep waiting so it resumes when they reopen).
      if (openAssets.length > 0 && (this.bots.some((b) => b.enabled) || (recent?.c ?? 0) > 0)) {
        await setSetting(this.env, "last_analysis_ts", String(now)); // set first: a crash can never cause a retry loop
        await this.runHourlyAnalysis(openAssets, now);
      }
    }
    const today = new Date(dayStartMs(now) + 6 * 3_600_000).toISOString().slice(0, 10);
    const lastDaily = await getSetting(this.env, "last_daily_date");
    if (lastDaily && lastDaily !== today && this.bots.some((b) => b.config.notify === "daily")) {
      await setSetting(this.env, "last_daily_date", today);
      await this.sendDailySummary(now);
    } else if (!lastDaily) {
      await setSetting(this.env, "last_daily_date", today);
    } else if (lastDaily !== today) {
      await setSetting(this.env, "last_daily_date", today);
    }
  }

  private async runHourlyAnalysis(openAssets: string[], now: number): Promise<void> {
    const rows = (await this.env.DB.prepare("SELECT * FROM positions WHERE status != 'open' ORDER BY closed_ts DESC LIMIT 500").all<PositionRow>()).results ?? [];
    const relevant = rows.filter((r) => openAssets.includes(r.asset));
    const hour = relevant.filter((r) => (r.closed_ts ?? 0) >= now - 3_600_000);
    const day = relevant.filter((r) => (r.closed_ts ?? 0) >= dayStartMs(now));
    const perf = { lastHour: computePerformance(hour), today: computePerformance(day), recentAll: computePerformance(relevant) };
    const unreal = [...this.posCache.values()].map((p) => ({ asset: p.asset, outcome: p.outcome, qty: p.open_qty, unrealized: this.unrealizedOf(p) }));
    const ranges = (
      await this.env.DB.prepare("SELECT ticker, COUNT(*) n, MIN((yes_bid+yes_ask)/2) lo, MAX((yes_bid+yes_ask)/2) hi FROM observations WHERE ts >= ? GROUP BY ticker").bind(now - 3_600_000).all<{ ticker: string; n: number; lo: number; hi: number }>()
    ).results;
    const trades = relevant.slice(0, 15).map((r) => ({ asset: r.asset, side: r.outcome, entryProb: r.entry_prob, favMax: r.fav_max, favMin: r.fav_min, exitProb: r.exit_prob, pnl: r.realized_pnl, result: r.result, how: r.close_reason, agree: r.agree_count }));
    const stats = { openAssets, perf, openPositions: unreal, probabilityRangesLastHour: ranges, recentTrades: trades, bots: this.bots.map((b) => ({ name: b.name, enabled: b.enabled, config: b.config })), balance: this.balance?.value ?? null };
    const prompt =
      "You are the advisory analyst for an automated Kalshi trading bot. You are ADVISORY ONLY: you cannot change settings, start or stop bots, or place orders, and you must not claim you did. " +
      "Using ONLY the measured data below, write a concise hourly review: results, what drove wins and losses, patterns by asset / probability range / entry probability / YES vs NO / directional agreement, probability peaks and troughs, and any suggested setting adjustments. " +
      "Label every statement as either MEASURED (directly in the data) or ESTIMATE/HYPOTHESIS (your inference, including any estimated impact of a change). Do not invent numbers or trades; if a sample is small, say so. Data gaps are real gaps, never fill them in.\n\nDATA:\n" +
      JSON.stringify(stats).slice(0, 14_000);
    const text = (await askAI(this.env, prompt)) ?? "AI analysis was unavailable this hour (the AI call failed). The measured numbers below are still accurate.";
    await this.env.DB.prepare("INSERT INTO analyses (ts, stats, text) VALUES (?,?,?)").bind(now, JSON.stringify(stats).slice(0, 60_000), text).run();
    await log(this.env, "info", "system", "Hourly AI analysis saved");
    if (this.bots.some((b) => b.config.notify === "hourly")) {
      const h = perf.lastHour;
      const acct = this.balance ? `Account balance $${this.balance.value.toFixed(2)}, portfolio value $${this.balance.portfolio.toFixed(2)}.` : "";
      const grp = (g: { key: string; trades: number; wins: number; losses: number; pnl: number }[]) => g.map((x) => `${esc(x.key)}: ${x.trades} trades, ${x.wins}W/${x.losses}L, $${x.pnl.toFixed(2)}`).join("<br>") || "none";
      const p = perf.recentAll;
      const html = emailShell(
        "Hourly report",
        `<p><b>Last hour (open markets only):</b> ${h.trades} trades, ${h.wins} wins, ${h.losses} losses${h.winRate !== null ? `, win rate ${(h.winRate * 100).toFixed(0)}%` : ""}, realized P/L $${h.pnl.toFixed(2)}. Today: $${perf.today.pnl.toFixed(2)}. Open positions' unrealized P/L: $${unreal.reduce((a, u) => a + (u.unrealized ?? 0), 0).toFixed(2)}. ${acct}</p>` +
          `<p><b>By asset</b><br>${grp(p.byAsset)}</p>` +
          `<p><b>Probability metrics (recent trades)</b><br>Avg entry prob winners ${fmtP(p.avgEntryProbWinners)}, losers ${fmtP(p.avgEntryProbLosers)}; highest opposing prob in losers ${fmtP(p.highestOpposingProbInLosers)}; lowest favorable prob in winners ${fmtP(p.lowestFavorableProbInWinners)}.</p>` +
          `<h3>AI analysis (advisory)</h3><div style="white-space:pre-wrap">${esc(text)}</div>`,
      );
      await sendEmail(this.env, "Purple Bot hourly report", html);
    }
  }

  private async sendDailySummary(now: number): Promise<void> {
    const start = dayStartMs(now - 12 * 3_600_000);
    const rows = (await this.env.DB.prepare("SELECT * FROM positions WHERE status != 'open' AND closed_ts >= ? AND closed_ts < ?").bind(start, dayStartMs(now)).all<PositionRow>()).results ?? [];
    const p = computePerformance(rows);
    await sendEmail(
      this.env,
      "Purple Bot daily summary",
      emailShell("Daily summary", `<p>${p.trades} trades, ${p.wins} wins, ${p.losses} losses${p.winRate !== null ? `, win rate ${(p.winRate * 100).toFixed(0)}%` : ""}. Realized P/L after fees: <b>$${p.pnl.toFixed(2)}</b>.</p><p>${p.byAsset.map((g) => `${esc(g.key)}: ${g.trades} trades, $${g.pnl.toFixed(2)}`).join("<br>")}</p>`),
    );
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
