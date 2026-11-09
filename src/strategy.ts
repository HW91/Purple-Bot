/**
 * Pure strategy + risk logic (no network, no database) so it can be unit tested.
 *
 * Definitions used (also shown in the README):
 *  - YES probability of a market = midpoint of the best YES bid and best YES ask. NO probability = 1 - YES.
 *  - An asset is "moving up" when its own 15-minute market leans YES (> 50%), "down" when it leans NO (< 50%).
 *    This uses the markets themselves, so it needs no separate paid price feed.
 *  - Entry is evaluated on every market update once the Time Delay has passed; the first update where every
 *    condition is true enters immediately. No indicators or extra filters.
 */
import type { AccountLimits, BotConfig, MarketInfo, Quote } from "./types";

export type Direction = "up" | "down";
export const QUOTE_MAX_AGE_MS = 30_000;

export const yesProb = (q: Pick<Quote, "yesBid" | "yesAsk">): number => (q.yesBid + q.yesAsk) / 2;
export const favorableProb = (outcome: "yes" | "no", yes: number): number => (outcome === "yes" ? yes : 1 - yes);
export const directionOf = (yes: number): Direction | null => (yes > 0.5 ? "up" : yes < 0.5 ? "down" : null);

export interface AssetView {
  asset: string;
  market: MarketInfo | null;
  quote: Quote | null;
}

export interface EntryDecision {
  ok: boolean;
  reason: string; // always filled in: this is the "why entered / why skipped" text
  upCount: number;
  downCount: number;
  trade?: {
    asset: string;
    ticker: string;
    outcome: "yes" | "no";
    direction: Direction;
    prob: number; // favorable-direction probability
    /** price per contract of OUR outcome (YES price for YES trades, NO price for NO trades) */
    costPerContract: number;
    /** YES-leg limit price + side to send to Kalshi */
    orderSide: "bid" | "ask";
    orderPrice: number;
    count: number;
    market: MarketInfo;
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function evaluateEntry(cfg: BotConfig, views: AssetView[], now: number): EntryDecision {
  const fresh = views.filter((v) => v.market && v.quote && now - v.quote.ts <= QUOTE_MAX_AGE_MS && v.quote.yesBid > 0 && v.quote.yesAsk > 0 && v.quote.yesAsk >= v.quote.yesBid);
  let up = 0;
  let down = 0;
  const dirs = new Map<string, Direction | null>();
  for (const v of fresh) {
    const d = directionOf(yesProb(v.quote!));
    dirs.set(v.asset, d);
    if (d === "up") up++;
    else if (d === "down") down++;
  }
  const base = { upCount: up, downCount: down };
  const missing = cfg.assets.filter((a) => !fresh.some((v) => v.asset === a));

  let direction: Direction | null = null;
  if (cfg.strategy === "metals") {
    // Every checked metal must have a live price and lean the same way before the bot may trade.
    const noLean = cfg.assets.filter((a) => !dirs.get(a));
    if (noLean.length) return { ok: false, reason: `Every checked metal needs a live price and a clear lean (not ready: ${noLean.join(", ")})`, ...base };
    const first = dirs.get(cfg.assets[0])!;
    if (!cfg.assets.every((a) => dirs.get(a) === first)) {
      return { ok: false, reason: `Checked metals disagree on direction (${cfg.assets.map((a) => `${a} ${dirs.get(a)}`).join(", ")})`, ...base };
    }
    direction = first;
  } else {
    if (up >= cfg.agreeCount && up >= down) direction = "up";
    else if (down >= cfg.agreeCount) direction = "down";
    if (!direction) return { ok: false, reason: `Only ${Math.max(up, down)} of ${cfg.assets.length} assets agree (need ${cfg.agreeCount})${missing.length ? `; no live data for ${missing.join(", ")}` : ""}`, ...base };
  }
  const outcome: "yes" | "no" = direction === "up" ? "yes" : "no";

  // The bot trades ONE chosen asset. The other assets only confirm the direction above; they are never traded.
  const cands = fresh.filter((v) => v.asset === cfg.tradeAsset && dirs.get(v.asset) === direction && favorableProb(outcome, yesProb(v.quote!)) >= cfg.probThreshold);
  if (cands.length === 0) {
    const tv = fresh.find((v) => v.asset === cfg.tradeAsset);
    if (!tv) return { ok: false, reason: `No live data for ${cfg.tradeAsset}, the asset this bot trades`, ...base };
    const own = favorableProb(outcome, yesProb(tv.quote!));
    return {
      ok: false,
      reason:
        dirs.get(tv.asset) === direction
          ? `Direction is ${direction}, but ${cfg.tradeAsset} ${outcome.toUpperCase()} probability ${pct(own)} is below ${pct(cfg.probThreshold)}`
          : `Direction is ${direction}, but ${cfg.tradeAsset} itself is not leaning ${direction}`,
      ...base,
    };
  }

  let lastWhy = "";
  for (const v of cands) {
    const m = v.market!;
    const q = v.quote!;
    const elapsed = (now - m.openTs) / 1000;
    const remaining = (m.closeTs - now) / 1000;
    if (elapsed < cfg.timeDelaySec) {
      lastWhy = `Time Delay: ${Math.ceil(cfg.timeDelaySec - elapsed)}s left before ${v.asset} can be traded`;
      continue;
    }
    if (remaining < cfg.minRemainingSec) {
      lastWhy = `Only ${Math.max(0, Math.floor(remaining))}s left in ${v.asset} contract (need ${cfg.minRemainingSec}s)`;
      continue;
    }
    const spread = q.yesAsk - q.yesBid;
    if (spread > cfg.maxSpread + 1e-9) {
      lastWhy = `${v.asset} spread ${pct(spread)} is wider than the ${pct(cfg.maxSpread)} limit`;
      continue;
    }
    const costPerContract = outcome === "yes" ? q.yesAsk : 1 - q.yesBid;
    if (!(costPerContract > 0.01 && costPerContract < 0.99)) {
      lastWhy = `${v.asset} price ${costPerContract.toFixed(2)} is too extreme to trade`;
      continue;
    }
    const count = Math.floor(cfg.tradeAmount / costPerContract);
    if (count < 1) {
      lastWhy = `Trade amount $${cfg.tradeAmount} buys less than 1 contract at $${costPerContract.toFixed(2)}`;
      continue;
    }
    // Liquidity: for a YES buy we lift the YES ask; for a NO buy we hit the YES bid.
    const depth = outcome === "yes" ? q.yesAskSize : q.yesBidSize;
    if (depth < count) {
      lastWhy = `${v.asset} only has ${depth} contracts at the best price (need ${count})`;
      continue;
    }
    return {
      ok: true,
      reason: `${direction === "up" ? up : down} assets ${direction}; ${v.asset} ${outcome.toUpperCase()} probability ${pct(favorableProb(outcome, yesProb(q)))} >= ${pct(cfg.probThreshold)}; delay passed`,
      ...base,
      trade: {
        asset: v.asset,
        ticker: m.ticker,
        outcome,
        direction: direction!,
        prob: favorableProb(outcome, yesProb(q)),
        costPerContract,
        orderSide: outcome === "yes" ? "bid" : "ask",
        orderPrice: outcome === "yes" ? q.yesAsk : q.yesBid,
        count,
        market: m,
      },
    };
  }
  return { ok: false, reason: lastWhy || "No tradable candidate", ...base };
}

export interface OpenPos {
  outcome: "yes" | "no";
  openQty: number;
  avgEntry: number; // per contract, our outcome
  entryFee: number;
  exitFee?: number;
  exitProceeds?: number;
}

/** Price we could close at right now, per contract of OUR outcome. */
export function exitPrice(outcome: "yes" | "no", q: Pick<Quote, "yesBid" | "yesAsk">): number {
  return outcome === "yes" ? q.yesBid : 1 - q.yesAsk;
}

/** Mark-to-market profit/loss if closed right now, after fees already paid. */
export function unrealizedPnl(p: OpenPos, q: Pick<Quote, "yesBid" | "yesAsk">): number {
  const gain = (exitPrice(p.outcome, q) - p.avgEntry) * p.openQty;
  return gain - p.entryFee + (p.exitProceeds ?? 0) - (p.exitFee ?? 0);
}

export function evaluateExit(cfg: Pick<BotConfig, "stopLossOn" | "stopLoss" | "takeProfitOn" | "takeProfit">, p: OpenPos, q: Pick<Quote, "yesBid" | "yesAsk">): "stop_loss" | "take_profit" | null {
  const pnl = unrealizedPnl(p, q);
  if (cfg.stopLossOn && pnl <= -cfg.stopLoss) return "stop_loss";
  if (cfg.takeProfitOn && pnl >= cfg.takeProfit) return "take_profit";
  return null;
}

// ---------------- risk ----------------

export interface RiskStats {
  botOpenPositions: number;
  accountOpenPositions: number;
  botTradesLastHour: number;
  botInvestedToday: number;
  accountInvestedToday: number;
  botNetPnlToday: number; // realized, after fees (negative = loss)
  accountNetPnlToday: number;
  pendingOrders: number; // submitted but not yet answered
  balance: number | null; // null = unknown (blocks trading)
  reconciled: boolean;
}

export function checkRisk(cfg: BotConfig, acct: AccountLimits, s: RiskStats, cost: number): string | null {
  if (!s.reconciled) return "Account not reconciled with Kalshi yet";
  if (s.balance === null) return "Kalshi balance unknown";
  if (s.pendingOrders > 0) return "An order is still being confirmed";
  if (s.botOpenPositions >= cfg.maxPositions) return `Bot already has ${s.botOpenPositions} open position(s) (max ${cfg.maxPositions})`;
  if (s.accountOpenPositions >= acct.maxPositions) return `Account already has ${s.accountOpenPositions} open positions (max ${acct.maxPositions})`;
  if (s.botTradesLastHour >= cfg.maxTradesPerHour) return `Bot reached ${cfg.maxTradesPerHour} trades this hour`;
  if (-s.botNetPnlToday >= cfg.dailyLossLimit) return `Bot daily loss limit $${cfg.dailyLossLimit} reached`;
  if (-s.accountNetPnlToday >= acct.dailyLossLimit) return `Account daily loss limit $${acct.dailyLossLimit} reached`;
  if (s.botInvestedToday + cost > cfg.dailyInvestLimit + 1e-9) return `Bot daily investment limit $${cfg.dailyInvestLimit} would be exceeded`;
  if (s.accountInvestedToday + cost > acct.dailyInvestLimit + 1e-9) return `Account daily investment limit $${acct.dailyInvestLimit} would be exceeded`;
  if (s.balance < cost) return `Balance $${s.balance.toFixed(2)} is below the $${cost.toFixed(2)} cost`;
  return null;
}

/** Start of the current trading day in US Eastern time (Kalshi's home timezone), as unix ms. */
export function dayStartMs(now: number, tz = "America/New_York"): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(now));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const sinceMidnight = (g("hour") * 3600 + g("minute") * 60 + g("second")) * 1000 + (now % 1000);
  return now - sinceMidnight;
}
