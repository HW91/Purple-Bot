/**
 * Backtesting on the probabilities this bot recorded itself (10-second resolution) plus Kalshi's final
 * settled result. It applies the bot's exact entry rules (probability, agreement, gold+silver, Time Delay,
 * remaining time), stop loss and take profit.
 *
 * IMPORTANT: fills are ESTIMATED, not replayed from a real order book. Entries pay 1 cent worse than the
 * quoted ask, exits get 1 cent worse than the quoted bid, and fees use the average real fee per contract
 * from this account's own live orders (or a flat $0.02 assumption if there are none yet). It never submits
 * an order and never touches live bot settings.
 */
import type { BotConfig, MarketInfo, Quote } from "./types";
import { dayStartMs, evaluateEntry, evaluateExit, exitPrice, favorableProb, yesProb, type AssetView } from "./strategy";

export interface SimMarket {
  ticker: string;
  asset: string;
  openTs: number;
  closeTs: number;
  result: "yes" | "no" | null;
}
export interface Obs {
  ts: number;
  bid: number;
  ask: number;
}
export interface SimTrade {
  asset: string;
  ticker: string;
  outcome: "yes" | "no";
  entryTs: number;
  entryProb: number;
  count: number;
  entryPrice: number;
  exit: "stop_loss" | "take_profit" | "settled";
  exitTs: number;
  pnl: number;
  result: "win" | "loss" | "flat";
}
export interface SimReport {
  assumptions: string[];
  periods: number;
  trades: SimTrade[];
  skippedUnsettled: number;
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  maxDrawdown: number;
  byAsset: Record<string, { trades: number; pnl: number }>;
  byOutcome: Record<string, { trades: number; pnl: number }>;
}

export interface SimOptions {
  feePerContract: number;
  slippage: number;
}

/** Money on each side from the per-minute record, counting only COMPLETED minutes before `ts` (no peeking at the minute still in progress). */
function flowAt(rows: Array<[number, number]> | undefined, openTs: number, ts: number, windowMin: number): { yes: number; no: number } | null {
  if (!rows) return null;
  const k = Math.floor((ts - openTs) / 60_000);
  const first = windowMin > 0 ? Math.max(0, k - windowMin) : 0;
  let yes = 0;
  let no = 0;
  for (let i = first; i < k && i < rows.length; i++) {
    yes += rows[i][0];
    no += rows[i][1];
  }
  return { yes, no };
}

/** `flow` = saved money per minute for each contract (ticker -> [[yes$, no$], ...]); only needed when the bot's order-flow rule is on. */
export function simulate(cfg: BotConfig, markets: SimMarket[], obs: Map<string, Obs[]>, opt: SimOptions, flow?: Map<string, Array<[number, number]>>): SimReport {
  const periods = new Map<number, SimMarket[]>();
  for (const m of markets) periods.set(m.openTs, [...(periods.get(m.openTs) ?? []), m]);
  const trades: SimTrade[] = [];
  let skipped = 0;
  const tradeTimes: number[] = [];
  const dayInvest = new Map<number, number>();
  const dayPnl = new Map<number, number>();

  for (const openTs of [...periods.keys()].sort((a, b) => a - b)) {
    const group = periods.get(openTs)!;
    const closeTs = Math.max(...group.map((m) => m.closeTs));
    const stamps = new Set<number>();
    for (const m of group) for (const o of obs.get(m.ticker) ?? []) if (o.ts >= openTs && o.ts < closeTs) stamps.add(o.ts);
    const timeline = [...stamps].sort((a, b) => a - b);
    const idx = new Map<string, number>();
    const quoteAt = (m: SimMarket, ts: number): Quote | null => {
      const list = obs.get(m.ticker) ?? [];
      let i = idx.get(m.ticker) ?? 0;
      while (i + 1 < list.length && list[i + 1].ts <= ts) i++;
      idx.set(m.ticker, i);
      const o = list[i];
      if (!o || o.ts > ts) return null;
      return { ticker: m.ticker, yesBid: o.bid, yesAsk: o.ask, yesBidSize: 1e6, yesAskSize: 1e6, last: (o.bid + o.ask) / 2, ts: o.ts };
    };
    const info = (m: SimMarket): MarketInfo => ({ ticker: m.ticker, asset: m.asset, series: "", title: "", openTs: m.openTs, closeTs: m.closeTs, status: "open" });

    let entered: { m: SimMarket; outcome: "yes" | "no"; count: number; price: number; ts: number; prob: number; fee: number } | null = null;
    let exitAt: { ts: number; why: "stop_loss" | "take_profit"; price: number } | null = null;

    for (const ts of timeline) {
      if (!entered) {
        const views: AssetView[] = cfg.assets.map((asset) => {
          const m = group.find((g) => g.asset === asset) ?? null;
          return { asset, market: m ? info(m) : null, quote: m ? quoteAt(m, ts) : null, flow: cfg.flowOn && m ? flowAt(flow?.get(m.ticker), m.openTs, ts, cfg.flowWindowMin) : null };
        });
        const d = evaluateEntry(cfg, views, ts);
        if (!d.ok || !d.trade) continue;
        const day = dayStartMs(ts);
        const t = d.trade;
        const price = Math.min(0.99, t.costPerContract + opt.slippage);
        const count = Math.floor(cfg.tradeAmount / price);
        if (count < 1) continue;
        const cost = count * price + count * opt.feePerContract;
        if ((dayInvest.get(day) ?? 0) + cost > cfg.dailyInvestLimit) continue;
        if (-(dayPnl.get(day) ?? 0) >= cfg.dailyLossLimit) continue;
        if (tradeTimes.filter((x) => x > ts - 3_600_000).length >= cfg.maxTradesPerHour) continue;
        const m = group.find((g) => g.ticker === t.ticker)!;
        entered = { m, outcome: t.outcome, count, price, ts, prob: t.prob, fee: count * opt.feePerContract };
        dayInvest.set(day, (dayInvest.get(day) ?? 0) + cost);
        tradeTimes.push(ts);
        continue;
      }
      if (ts <= entered.ts || exitAt) continue;
      const q = quoteAt(entered.m, ts);
      if (!q) continue;
      const exitP = exitPrice(entered.outcome, q) - opt.slippage;
      const why = evaluateExit(cfg, { outcome: entered.outcome, openQty: entered.count, avgEntry: entered.price, entryFee: entered.fee }, { yesBid: entered.outcome === "yes" ? q.yesBid - opt.slippage : q.yesBid, yesAsk: entered.outcome === "no" ? q.yesAsk + opt.slippage : q.yesAsk });
      if (why) exitAt = { ts, why, price: Math.max(0, exitP) };
    }

    if (entered) {
      let pnl: number;
      let exit: SimTrade["exit"];
      let exitTs: number;
      if (exitAt) {
        pnl = (exitAt.price - entered.price) * entered.count - entered.fee * 2;
        exit = exitAt.why;
        exitTs = exitAt.ts;
      } else if (entered.m.result) {
        const won = entered.m.result === entered.outcome;
        pnl = ((won ? 1 : 0) - entered.price) * entered.count - entered.fee;
        exit = "settled";
        exitTs = entered.m.closeTs;
      } else {
        skipped++;
        continue;
      }
      pnl = Math.round(pnl * 100) / 100;
      const day = dayStartMs(exitTs);
      dayPnl.set(day, (dayPnl.get(day) ?? 0) + pnl);
      trades.push({ asset: entered.m.asset, ticker: entered.m.ticker, outcome: entered.outcome, entryTs: entered.ts, entryProb: entered.prob, count: entered.count, entryPrice: entered.price, exit, exitTs, pnl, result: pnl > 0.004 ? "win" : pnl < -0.004 ? "loss" : "flat" });
    }
  }

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const byAsset: SimReport["byAsset"] = {};
  const byOutcome: SimReport["byOutcome"] = {};
  for (const t of trades) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    (byAsset[t.asset] ??= { trades: 0, pnl: 0 }).trades++;
    byAsset[t.asset].pnl = Math.round((byAsset[t.asset].pnl + t.pnl) * 100) / 100;
    const k = t.outcome === "yes" ? "YES (up)" : "NO (down)";
    (byOutcome[k] ??= { trades: 0, pnl: 0 }).trades++;
    byOutcome[k].pnl = Math.round((byOutcome[k].pnl + t.pnl) * 100) / 100;
  }
  const wins = trades.filter((t) => t.result === "win").length;
  const losses = trades.filter((t) => t.result === "loss").length;
  void favorableProb;
  void yesProb;
  return {
    assumptions: [
      "Built from probabilities this bot recorded (about every 10 seconds) and Kalshi's final settled results; it is not a replay of the real order book.",
      `Fills are estimated: entries pay ${(opt.slippage * 100).toFixed(0)} cent worse than the quoted price, early exits get ${(opt.slippage * 100).toFixed(0)} cent worse.`,
      `Fees assume $${opt.feePerContract.toFixed(3)} per contract per fill (from your real fills when available, otherwise a flat assumption).`,
      "Order-book depth is assumed to be sufficient (it was not recorded). Real fills may be worse or may not happen.",
      "Missing data stays missing: periods with gaps simply have fewer observations. Nothing is interpolated.",
      ...(cfg.flowOn ? ["Order flow uses the per-minute money totals saved for contracts the bot watched live, counting only completed minutes. A contract with no saved record never passes the money rule, so this run can only trade on recorded contracts."] : []),
      ...(cfg.noTradeWindows.length ? ["No-trade windows use US Eastern time."] : []),
      "One trade per contract at most, as live. Account-wide limits across several bots are not applied; each run uses this bot's own limits.",
    ],
    periods: periods.size,
    trades,
    skippedUnsettled: skipped,
    total: trades.length,
    wins,
    losses,
    winRate: wins + losses ? wins / (wins + losses) : null,
    netPnl: Math.round(cum * 100) / 100,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    byAsset,
    byOutcome,
  };
}
