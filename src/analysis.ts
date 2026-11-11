/**
 * End-of-day overview. The owner can already see every trade, chart and total, so this deliberately does NOT
 * recap trades. It measures the things that are hard to see by eye (what blocked trades, whether stop loss /
 * take profit helped in hindsight, which hours were reliable) and asks the AI to point out what matters.
 * Everything here is measured from this bot's own records; the AI is advisory only.
 */
import type { Env } from "./types";
import { askAI, emailShell, esc } from "./notify";
import { computePerformance, type Performance } from "./stats";
import type { BotRow, PositionRow } from "./db";
import { getSetting, log, rowToBot, setSetting } from "./db";
import { simulate, type Obs, type SimMarket, type SimReport } from "./backtest";
import { KALSHI_RULES_PROMPT } from "./kalshi-rules";

const ET = "America/New_York";

export function etDateString(ms: number): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return p; // YYYY-MM-DD
}

export function etHourOf(ms: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
}

export interface HindsightRow {
  close_reason: string;
  outcome: "yes" | "no";
  entry_qty: number;
  entry_cost: number;
  entry_fee: number;
  realized_pnl: number | null;
  result: string | null; // the contract's final result: 'yes' | 'no'
}

export interface Hindsight {
  trades: number;
  resolved: number; // contracts with a known final result
  wouldHaveWon: number; // the side finished in our favor even though we exited early
  realized: number; // what we actually made/lost on those trades
  ifHeld: number; // what holding to settlement would have made (ignores the risk the exit removed)
}

/** For trades closed early by stop loss / take profit: what holding to settlement would have paid (hindsight only). */
export function hindsightFor(rows: HindsightRow[]): Record<string, Hindsight> {
  const out: Record<string, Hindsight> = {};
  for (const r of rows) {
    const h = (out[r.close_reason] ??= { trades: 0, resolved: 0, wouldHaveWon: 0, realized: 0, ifHeld: 0 });
    h.trades++;
    if (r.result !== "yes" && r.result !== "no") continue;
    h.resolved++;
    const won = r.result === r.outcome;
    if (won) h.wouldHaveWon++;
    h.realized += r.realized_pnl ?? 0;
    h.ifHeld += (won ? r.entry_qty : 0) - r.entry_cost - r.entry_fee;
  }
  for (const h of Object.values(out)) {
    h.realized = Math.round(h.realized * 100) / 100;
    h.ifHeld = Math.round(h.ifHeld * 100) / 100;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Complete per-trade record, including what happened AFTER an early exit (stop loss / take profit) up to the contract's close
// ---------------------------------------------------------------------------------------------------------------

export interface TradeDetail {
  asset: string;
  side: "yes" | "no";
  entered: string; // US Eastern
  amount: number; // dollars put into the trade (contracts x entry price)
  qty: number;
  entryPrice: number | null; // per contract, our side
  exitPrice: number | null; // per contract, our side (null if held to settlement)
  how: string | null; // stop_loss | take_profit | settled | manual_close | emergency | external
  pnl: number | null; // actual, after fees
  entryProb: number | null;
  lowestProbWhileOpen: number | null; // our side's lowest probability while the trade was open
  highestProbWhileOpen: number | null;
  finalResult: "yes" | "no" | null; // how the contract finally settled (null = not settled yet)
  endedInOurFavor: boolean | null; // our side won at settlement
  ifHeldPnl: number | null; // what holding to settlement would have made after the entry fee (hindsight)
  afterExit: { minutesToClose: number; bestProb: number; worstProb: number; lastProb: number; points: number } | null; // our side's probability after the exit, until the contract closed
}

const etStamp = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

const r2 = (x: number) => Math.round(x * 100) / 100;

export function enrichTrade(p: PositionRow, finalResult: string | null, marketCloseTs: number | null, after: Array<{ ts: number; mid: number }>): TradeDetail {
  const settledResult = finalResult === "yes" || finalResult === "no" ? finalResult : null;
  const won = settledResult ? settledResult === p.outcome : null;
  const fav = (mid: number) => (p.outcome === "yes" ? mid : 1 - mid);
  const exitedEarly = p.close_reason !== null && p.close_reason !== "settled" && p.closed_ts !== null;
  const pts = exitedEarly && marketCloseTs !== null ? after.filter((o) => o.ts > p.closed_ts! && o.ts <= marketCloseTs) : [];
  const probs = pts.map((o) => fav(o.mid));
  const qty = p.entry_qty || 0;
  return {
    asset: p.asset,
    side: p.outcome,
    entered: etStamp(p.opened_ts),
    amount: r2(p.entry_cost),
    qty,
    entryPrice: p.avg_entry,
    exitPrice: exitedEarly && qty > 0 ? Math.round((p.exit_proceeds / qty) * 1000) / 1000 : null,
    how: p.close_reason,
    pnl: p.realized_pnl,
    entryProb: p.entry_prob,
    lowestProbWhileOpen: p.fav_min,
    highestProbWhileOpen: p.fav_max,
    finalResult: settledResult,
    endedInOurFavor: won,
    ifHeldPnl: won === null ? null : r2((won ? qty : 0) - p.entry_cost - p.entry_fee),
    afterExit: probs.length && marketCloseTs !== null && p.closed_ts !== null ? { minutesToClose: Math.max(0, Math.round((marketCloseTs - p.closed_ts) / 60000)), bestProb: r2(Math.max(...probs) * 100) / 100, worstProb: r2(Math.min(...probs) * 100) / 100, lastProb: r2(probs[probs.length - 1] * 100) / 100, points: probs.length } : null,
  };
}

/** Full detail for a list of closed trades (settlement result, and for early exits what the price did until the contract closed). */
export async function describeTrades(env: Env, rows: PositionRow[]): Promise<TradeDetail[]> {
  if (!rows.length) return [];
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += 80) chunks.push(tickers.slice(i, i + 80)); // D1 allows 100 bound values per query
  const info = new Map<string, { result: string | null; close_ts: number }>();
  for (const c of chunks) {
    const res = await env.DB.prepare(`SELECT ticker, result, close_ts FROM markets WHERE ticker IN (${c.map(() => "?").join(",")})`).bind(...c).all<{ ticker: string; result: string | null; close_ts: number }>();
    for (const m of res.results ?? []) info.set(m.ticker, { result: m.result, close_ts: m.close_ts });
  }
  const early = rows.filter((r) => r.close_reason !== null && r.close_reason !== "settled" && r.closed_ts !== null);
  const obs = new Map<string, Array<{ ts: number; mid: number }>>();
  if (early.length) {
    const since = Math.min(...early.map((r) => r.closed_ts!));
    const earlyTickers = [...new Set(early.map((r) => r.ticker))];
    for (let i = 0; i < earlyTickers.length; i += 80) {
      const c = earlyTickers.slice(i, i + 80);
      const res = await env.DB.prepare(`SELECT ticker, ts, (yes_bid + yes_ask) / 2 AS mid FROM observations WHERE ts > ? AND ticker IN (${c.map(() => "?").join(",")}) ORDER BY ts`)
        .bind(since, ...c)
        .all<{ ticker: string; ts: number; mid: number }>();
      for (const o of res.results ?? []) (obs.get(o.ticker) ?? obs.set(o.ticker, []).get(o.ticker)!).push({ ts: o.ts, mid: o.mid });
    }
  }
  return rows.map((p) => {
    const m = info.get(p.ticker);
    return enrichTrade(p, m?.result ?? null, m?.close_ts ?? null, obs.get(p.ticker) ?? []);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Money placed on each side of a contract (from the live trade feed, saved when each contract ended)
// ---------------------------------------------------------------------------------------------------------------

export interface FlowRow {
  ticker: string;
  asset: string;
  open_ts: number;
  close_ts: number;
  yes_dollars: number;
  no_dollars: number;
  minutes: string; // JSON [[yes, no], ...] per minute
}

export interface MoneyFlow {
  contractsRecorded: number;
  /** newest first */
  recentContracts: Array<{ asset: string; ended: string; yesDollars: number; noDollars: number; yesToNoRatio: number | null; finalResult: "yes" | "no" | null }>;
  /** For each trade: money on our side vs the other side over the 3 minutes up to and including the entry minute, and over the whole contract. ratio = our side / other side (null when the other side had none). */
  tradesWithMoney: Array<{ asset: string; side: "yes" | "no"; entered: string; result: string | null; ourSide3min: number; otherSide3min: number; ratio3min: number | null; ratioWholeContract: number | null }>;
  winsVsLosses: { wins: { trades: number; medianRatio3min: number | null }; losses: { trades: number; medianRatio3min: number | null } };
}

const ratioOf = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) / 100 : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
};

export function moneyFlowSummary(rows: FlowRow[], trades: Array<Pick<PositionRow, "ticker" | "outcome" | "opened_ts" | "result">>, results: Map<string, string | null>): MoneyFlow {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const sorted = [...rows].sort((a, b) => b.close_ts - a.close_ts);
  const recentContracts = sorted.slice(0, 12).map((r) => {
    const res = results.get(r.ticker);
    const finalResult: "yes" | "no" | null = res === "yes" ? "yes" : res === "no" ? "no" : null;
    return { asset: r.asset, ended: etStamp(r.close_ts), yesDollars: r2(r.yes_dollars), noDollars: r2(r.no_dollars), yesToNoRatio: ratioOf(r.yes_dollars, r.no_dollars), finalResult };
  });
  const tradesWithMoney: MoneyFlow["tradesWithMoney"] = [];
  const winRatios: number[] = [];
  const lossRatios: number[] = [];
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    const r = byTicker.get(t.ticker);
    if (!r) continue;
    let minutes: Array<[number, number]>;
    try {
      minutes = JSON.parse(r.minutes);
    } catch {
      continue;
    }
    const idx = t.outcome === "yes" ? 0 : 1;
    const entryMin = Math.min(minutes.length - 1, Math.max(0, Math.floor((t.opened_ts - r.open_ts) / 60_000)));
    let ours = 0;
    let other = 0;
    for (let m = Math.max(0, entryMin - 2); m <= entryMin; m++) {
      ours += minutes[m]?.[idx] ?? 0;
      other += minutes[m]?.[1 - idx] ?? 0;
    }
    const whole = t.outcome === "yes" ? ratioOf(r.yes_dollars, r.no_dollars) : ratioOf(r.no_dollars, r.yes_dollars);
    const ratio3 = ratioOf(ours, other);
    tradesWithMoney.push({ asset: r.asset, side: t.outcome, entered: etStamp(t.opened_ts), result: t.result, ourSide3min: Math.round(ours), otherSide3min: Math.round(other), ratio3min: ratio3, ratioWholeContract: whole });
    if (t.result === "win") {
      wins++;
      if (ratio3 !== null) winRatios.push(ratio3);
    } else if (t.result === "loss") {
      losses++;
      if (ratio3 !== null) lossRatios.push(ratio3);
    }
  }
  return {
    contractsRecorded: rows.length,
    recentContracts,
    tradesWithMoney: tradesWithMoney.slice(0, 30),
    winsVsLosses: { wins: { trades: wins, medianRatio3min: median(winRatios) }, losses: { trades: losses, medianRatio3min: median(lossRatios) } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Metals bots: trades NOT taken because the checked metals did not lean the same way, and how they would have ended
// ---------------------------------------------------------------------------------------------------------------

export interface MissedByDisagreement {
  note: string;
  periodDays: number;
  bots: Array<{
    bot: string;
    tradeAsset: string;
    checkedMetals: string[];
    contractsMissed: number;
    wouldHaveWon: number;
    wouldHaveLost: number;
    hypotheticalPnl: number;
    tradesActuallyTaken: number;
    missed: Array<{ entered: string; side: "yes" | "no"; result: string; pnl: number }>; // up to 15, newest first
  }>;
}

/**
 * A "missed" trade is a contract where the bot's own rules (every checked metal must agree) took no trade, but the same rules
 * with only the traded metal checked WOULD have. Both runs replay the recorded probabilities and Kalshi's settled results.
 */
export function summarizeMissed(botName: string, tradeAsset: string, checked: string[], actual: SimReport, withoutAgreement: SimReport): MissedByDisagreement["bots"][number] {
  const takenTickers = new Set(actual.trades.map((t) => t.ticker));
  const missed = withoutAgreement.trades.filter((t) => !takenTickers.has(t.ticker)).sort((a, b) => b.entryTs - a.entryTs);
  return {
    bot: botName,
    tradeAsset,
    checkedMetals: checked,
    contractsMissed: missed.length,
    wouldHaveWon: missed.filter((t) => t.result === "win").length,
    wouldHaveLost: missed.filter((t) => t.result === "loss").length,
    hypotheticalPnl: r2(missed.reduce((s, t) => s + t.pnl, 0)),
    tradesActuallyTaken: actual.trades.length,
    missed: missed.slice(0, 15).map((t) => ({ entered: etStamp(t.entryTs), side: t.outcome, result: t.result, pnl: t.pnl })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Hindsight: what would selling a few minutes before the contract closed have done, for trades held to settlement
// ---------------------------------------------------------------------------------------------------------------

export interface ExitEarlyOption {
  minutesBeforeClose: number;
  tradesCompared: number;
  actualPnl: number;
  pnlIfSoldEarly: number;
  difference: number; // pnlIfSoldEarly - actualPnl (positive = selling early would have made more)
  winnersGaveUp: number; // total difference on trades that actually won (negative)
  losersSaved: number; // total difference on trades that actually lost (positive)
  tradesBetterOff: number;
  tradesWorseOff: number;
}

export interface ExitEarlyHindsight {
  note: string;
  tradesHeldToSettlement: number;
  options: ExitEarlyOption[];
}

export interface HeldTrade {
  ticker: string;
  outcome: "yes" | "no";
  qty: number;
  avgEntry: number;
  entryFee: number;
  pnl: number; // actual, after fees
  openedTs: number;
  closeTs: number; // when the contract ended
}

/** Our side's price we could have sold at: the YES bid for a YES trade, 1 - YES ask for a NO trade. */
function sellPrice(outcome: "yes" | "no", o: Obs): number {
  return Math.max(0, outcome === "yes" ? o.bid : 1 - o.ask);
}

export function exitEarlyHindsight(trades: HeldTrade[], obs: Map<string, Obs[]>, feePerContract: number, slippage = 0.01, minutesList = [3, 2]): ExitEarlyHindsight {
  const options: ExitEarlyOption[] = minutesList.map((min) => {
    let compared = 0;
    let actual = 0;
    let early = 0;
    let gave = 0;
    let saved = 0;
    let better = 0;
    let worse = 0;
    for (const t of trades) {
      const at = t.closeTs - min * 60_000;
      if (t.openedTs >= at) continue; // it was entered after that moment: nothing to sell yet
      const list = obs.get(t.ticker) ?? [];
      let o: Obs | null = null;
      for (const x of list) if (x.ts <= at) o = x;
      if (!o || at - o.ts > 60_000) continue; // no recorded price close enough to that moment: never guess
      const price = Math.max(0, sellPrice(t.outcome, o) - slippage);
      const hypo = (price - t.avgEntry) * t.qty - t.entryFee - t.qty * feePerContract;
      const diff = hypo - t.pnl;
      compared++;
      actual += t.pnl;
      early += hypo;
      if (diff > 0.005) better++;
      else if (diff < -0.005) worse++;
      if (t.pnl > 0) gave += diff;
      else saved += diff;
    }
    return { minutesBeforeClose: min, tradesCompared: compared, actualPnl: r2(actual), pnlIfSoldEarly: r2(early), difference: r2(early - actual), winnersGaveUp: r2(gave), losersSaved: r2(saved), tradesBetterOff: better, tradesWorseOff: worse };
  });
  return {
    note: "Replay estimate for trades that were held to settlement: each is re-priced as if sold at the best bid recorded that many minutes before the contract closed (minus a 1 cent slippage allowance and an exit fee per contract). Trades with no recorded price close to that moment are left out. It is hindsight and does not say the sale would have filled.",
    tradesHeldToSettlement: trades.length,
    options,
  };
}

async function exitEarlyFor(env: Env, closed: PositionRow[]): Promise<ExitEarlyHindsight> {
  const held: HeldTrade[] = closed
    .filter((p) => p.close_reason === "settled" && p.realized_pnl !== null && p.entry_qty > 0 && p.avg_entry !== null)
    .slice(0, 200)
    .map((p) => ({ ticker: p.ticker, outcome: p.outcome, qty: p.entry_qty, avgEntry: p.avg_entry!, entryFee: p.entry_fee, pnl: p.realized_pnl!, openedTs: p.opened_ts, closeTs: p.market_close_ts }));
  const obs = new Map<string, Obs[]>();
  const tickers = [...new Set(held.map((h) => h.ticker))];
  for (let i = 0; i < tickers.length; i += 40) {
    const c = tickers.slice(i, i + 40);
    // only the last few minutes of each contract are needed
    const rows = (
      await env.DB.prepare(`SELECT o.ticker, o.ts, o.yes_bid, o.yes_ask FROM observations o JOIN markets m ON m.ticker = o.ticker WHERE o.ticker IN (${c.map(() => "?").join(",")}) AND o.ts >= m.close_ts - 300000 AND o.ts <= m.close_ts ORDER BY o.ts`)
        .bind(...c)
        .all<{ ticker: string; ts: number; yes_bid: number; yes_ask: number }>()
    ).results ?? [];
    for (const r of rows) (obs.get(r.ticker) ?? obs.set(r.ticker, []).get(r.ticker)!).push({ ts: r.ts, bid: r.yes_bid, ask: r.yes_ask });
  }
  const feeRow = await env.DB.prepare("SELECT SUM(fee) f, SUM(fill_count) n FROM orders WHERE fill_count > 0").first<{ f: number | null; n: number | null }>();
  return exitEarlyHindsight(held, obs, feeRow?.n ? (feeRow.f ?? 0) / feeRow.n : 0.02);
}

const MISSED_MAX_DAYS = 3;
const MISSED_CACHE_MS = 15 * 60_000;

export async function missedByDisagreement(env: Env, start: number, end: number, botId?: string | null): Promise<MissedByDisagreement | null> {
  const botRows = ((await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots WHERE strategy = 'metals'").all<BotRow>()).results ?? []).map(rowToBot).filter((b) => b.config.assets.length > 1 && (!botId || b.id === botId));
  if (!botRows.length) return null;
  const from = Math.max(start, end - MISSED_MAX_DAYS * 86_400_000);
  const cacheKey = `missed:${botId ?? "all"}:${botRows.map((b) => b.id).join(",")}:${Math.floor(from / 3_600_000)}:${Math.floor(end / 900_000)}`;
  try {
    const cached = await getSetting(env, "missed_cache");
    if (cached) {
      const c = JSON.parse(cached) as { key: string; at: number; data: MissedByDisagreement };
      if (c.key === cacheKey && Date.now() - c.at < MISSED_CACHE_MS) return c.data;
    }
  } catch {
    /* no usable cache: compute it */
  }
  const assets = [...new Set(botRows.flatMap((b) => b.config.assets))];
  const mk = (await env.DB.prepare(`SELECT ticker, asset, open_ts, close_ts, result FROM markets WHERE open_ts >= ? AND close_ts <= ? AND asset IN (${assets.map(() => "?").join(",")}) ORDER BY open_ts`).bind(from, end, ...assets).all<{ ticker: string; asset: string; open_ts: number; close_ts: number; result: string | null }>()).results ?? [];
  const markets: SimMarket[] = mk.map((x) => ({ ticker: x.ticker, asset: x.asset, openTs: x.open_ts, closeTs: x.close_ts, result: x.result === "yes" || x.result === "no" ? x.result : null }));
  const obs = new Map<string, Obs[]>();
  const obsRows = (await env.DB.prepare(`SELECT ticker, ts, yes_bid, yes_ask FROM observations WHERE ts >= ? AND ts <= ? AND ticker IN (SELECT ticker FROM markets WHERE open_ts >= ? AND close_ts <= ? AND asset IN (${assets.map(() => "?").join(",")})) ORDER BY ts`).bind(from, end, from, end, ...assets).all<{ ticker: string; ts: number; yes_bid: number; yes_ask: number }>()).results ?? [];
  for (const o of obsRows) (obs.get(o.ticker) ?? obs.set(o.ticker, []).get(o.ticker)!).push({ ts: o.ts, bid: o.yes_bid, ask: o.yes_ask });
  const feeRow = await env.DB.prepare("SELECT SUM(fee) f, SUM(fill_count) n FROM orders WHERE fill_count > 0").first<{ f: number | null; n: number | null }>();
  const opt = { feePerContract: feeRow?.n ? (feeRow.f ?? 0) / feeRow.n : 0.02, slippage: 0.01 };
  const bots = botRows.map((b) => {
    // the order-flow rule is not applied: money per side was not recorded for past contracts
    const base = { ...b.config, flowOn: false };
    const actual = simulate(base, markets, obs, opt);
    const without = simulate({ ...base, assets: [base.tradeAsset] }, markets, obs, opt);
    return summarizeMissed(b.name, b.config.tradeAsset, b.config.assets, actual, without);
  });
  const data: MissedByDisagreement = {
    note: "Estimated by replaying the recorded probabilities (about every 10 seconds) and Kalshi's final results with the bot's current settings, once with every checked metal required to agree and once with only the traded metal. Fills are estimated, and the money-on-each-side rule is not applied. Only contracts that have settled are counted.",
    periodDays: Math.round(((end - from) / 86_400_000) * 10) / 10,
    bots,
  };
  try {
    await setSetting(env, "missed_cache", JSON.stringify({ key: cacheKey, at: Date.now(), data }));
  } catch {
    /* caching is optional */
  }
  return data;
}

// ---------------------------------------------------------------------------------------------------------------
// Trade files: everything recorded about a trade, for the AI chat (the most recent trades only, to keep the prompt a sensible size)
// ---------------------------------------------------------------------------------------------------------------

export interface TradeFile {
  bot: string | null;
  asset: string;
  side: "yes" | "no";
  entered: string; // US Eastern
  result: string | null;
  pnl: number | null;
  /** The probability range and Time Delay the bot used on this contract (saved while it ran). Its other settings are the bot's current ones. */
  settingsOnThisContract: { minProbability: number; maxProbability: number; timeDelaySeconds: number | null } | null;
  /** Each requirement as it stood at the moment of entry. */
  checklistAtEntry: string[] | null;
  /** The best prices just before entry, and how many contracts were on offer on the buy side (null = not recorded). */
  atEntry: { yesBid: number; yesAsk: number; spread: number; contractsOnOffer: number | null } | null;
  /** The other checked assets' YES probability at the entry moment. */
  otherAssetsAtEntry: Array<{ asset: string; yesProbability: number }>;
  /** [seconds from entry (negative = before), YES bid, YES ask], from 5 minutes before entry until the contract closed. */
  pricesAround: Array<[number, number, number]>;
}

export function compactPrices(obs: Array<{ ts: number; bid: number; ask: number }>, entryTs: number): Array<[number, number, number]> {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return obs.map((o) => [Math.round((o.ts - entryTs) / 1000), r3(o.bid), r3(o.ask)]);
}

export function checklistStrings(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const lines = JSON.parse(raw) as Array<{ ok: boolean | null; text: string }>;
    return lines.map((c) => `${c.ok === true ? "OK" : c.ok === false ? "FAILED" : "NOT TESTED"}: ${c.text}`);
  } catch {
    return null;
  }
}

export async function buildTradeFiles(env: Env, rows: PositionRow[], max = 10): Promise<TradeFile[]> {
  const take = rows.slice(0, max);
  return Promise.all(
    take.map(async (p): Promise<TradeFile> => {
      const mk = await env.DB.prepare("SELECT open_ts, close_ts FROM markets WHERE ticker = ?").bind(p.ticker).first<{ open_ts: number; close_ts: number }>();
      const closeTs = mk?.close_ts ?? p.market_close_ts;
      const [obs, atEntryRow, cs, notes, bot] = await Promise.all([
        env.DB.prepare("SELECT ts, yes_bid, yes_ask FROM observations WHERE ticker = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 400").bind(p.ticker, p.opened_ts - 300_000, closeTs).all<{ ts: number; yes_bid: number; yes_ask: number }>(),
        env.DB.prepare("SELECT yes_bid, yes_ask, yes_bid_size, yes_ask_size FROM observations WHERE ticker = ? AND ts <= ? ORDER BY ts DESC LIMIT 1").bind(p.ticker, p.opened_ts).first<{ yes_bid: number; yes_ask: number; yes_bid_size: number | null; yes_ask_size: number | null }>(),
        env.DB.prepare("SELECT prob_min, prob_max, delay_sec FROM contract_settings WHERE bot_id = ? AND ticker = ?").bind(p.bot_id, p.ticker).first<{ prob_min: number; prob_max: number; delay_sec: number | null }>(),
        env.DB.prepare("SELECT checks FROM contract_notes WHERE bot_id = ? AND ticker = ?").bind(p.bot_id, p.ticker).first<{ checks: string | null }>(),
        env.DB.prepare("SELECT name, config FROM bots WHERE id = ?").bind(p.bot_id).first<{ name: string; config: string }>(),
      ]);
      let others: Array<{ asset: string; yesProbability: number }> = [];
      try {
        const assets = (bot ? (JSON.parse(bot.config) as { assets?: string[] }).assets : null) ?? [];
        const rest = assets.filter((a) => a !== p.asset);
        if (mk && rest.length) {
          const res = await env.DB.prepare(
            `SELECT m.asset, (SELECT (o.yes_bid + o.yes_ask) / 2 FROM observations o WHERE o.ticker = m.ticker AND o.ts <= ? ORDER BY o.ts DESC LIMIT 1) p FROM markets m WHERE m.open_ts = ? AND m.asset IN (${rest.map(() => "?").join(",")})`,
          )
            .bind(p.opened_ts, mk.open_ts, ...rest)
            .all<{ asset: string; p: number | null }>();
          others = (res.results ?? []).filter((r) => r.p !== null).map((r) => ({ asset: r.asset, yesProbability: Math.round((r.p as number) * 1000) / 1000 }));
        }
      } catch {
        /* the other assets are optional context */
      }
      const buySize = atEntryRow ? (p.outcome === "yes" ? atEntryRow.yes_ask_size : atEntryRow.yes_bid_size) : null;
      return {
        bot: bot?.name ?? null,
        asset: p.asset,
        side: p.outcome,
        entered: etStamp(p.opened_ts),
        result: p.result,
        pnl: p.realized_pnl,
        settingsOnThisContract: cs ? { minProbability: cs.prob_min, maxProbability: cs.prob_max, timeDelaySeconds: cs.delay_sec } : null,
        checklistAtEntry: checklistStrings(notes?.checks ?? null),
        atEntry: atEntryRow ? { yesBid: atEntryRow.yes_bid, yesAsk: atEntryRow.yes_ask, spread: Math.round((atEntryRow.yes_ask - atEntryRow.yes_bid) * 1000) / 1000, contractsOnOffer: buySize ?? null } : null,
        otherAssetsAtEntry: others,
        pricesAround: compactPrices((obs.results ?? []).map((o) => ({ ts: o.ts, bid: o.yes_bid, ask: o.yes_ask })), p.opened_ts),
      };
    }),
  );
}

interface Reliability {
  contracts: number;
  reached: number; // times a side reached 80%+ in the tradeable part of a contract
  reversed: number; // ...and then lost at settlement
}

async function reliability(env: Env, from: number, to: number): Promise<{ total: Reliability; byHour: Array<Reliability & { hour: number }> }> {
  const rows = (
    await env.DB.prepare(
      "SELECT m.open_ts, m.result, " +
        "MAX(CASE WHEN o.ts >= m.open_ts + 300000 AND o.ts <= m.close_ts - 120000 THEN (o.yes_bid + o.yes_ask) / 2 END) hi, " +
        "MIN(CASE WHEN o.ts >= m.open_ts + 300000 AND o.ts <= m.close_ts - 120000 THEN (o.yes_bid + o.yes_ask) / 2 END) lo, COUNT(*) n " +
        "FROM markets m JOIN observations o ON o.ticker = m.ticker WHERE m.open_ts >= ? AND m.open_ts < ? GROUP BY m.ticker HAVING n >= 3",
    )
      .bind(from, to)
      .all<{ open_ts: number; result: string | null; hi: number | null; lo: number | null }>()
  ).results;
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, contracts: 0, reached: 0, reversed: 0 }));
  const total: Reliability = { contracts: 0, reached: 0, reversed: 0 };
  for (const r of rows) {
    const yes = r.hi !== null && r.hi >= 0.8;
    const no = r.lo !== null && r.lo <= 0.2;
    const settled = r.result === "yes" || r.result === "no";
    const reached = (yes ? 1 : 0) + (no ? 1 : 0);
    const reversed = settled ? (yes && r.result === "no" ? 1 : 0) + (no && r.result === "yes" ? 1 : 0) : 0;
    const h = byHour[etHourOf(r.open_ts)];
    h.contracts++;
    h.reached += reached;
    h.reversed += reversed;
    total.contracts++;
    total.reached += reached;
    total.reversed += reversed;
  }
  return { total, byHour: byHour.filter((h) => h.contracts > 0) };
}

export interface DayStats {
  label: string;
  perf: Performance;
  byEntryHour: Array<{ hour: string; trades: number; wins: number; losses: number; pnl: number }>;
  stopLossTakeProfitHindsight: Record<string, Hindsight>;
  exitEarlyHindsight: ExitEarlyHindsight; // trades held to settlement: what selling 3 or 2 minutes before the close would have done (hindsight estimate)
  missedByDisagreement: MissedByDisagreement | null; // metals bots: contracts skipped because the checked metals disagreed, and how they would have ended (null = no metals bots)
  moneyFlow: MoneyFlow; // how much money was placed on YES and NO in each recorded contract, and at each trade's entry
  earlyExits: TradeDetail[]; // each trade closed early, with what the price did after the exit until the contract closed (up to 40)
  blockedBy: { contractsWatched: number; contractsTraded: number; share: Array<{ code: string; pctOfTime: number; example: string }> };
  reliability: { day: Reliability; byHour: Array<Reliability & { hour: number }>; previous7DaysAverage: Reliability | null };
  bots: Array<{ name: string; enabled: boolean; sideBought: string; tradeAsset: string; assets: string[]; probRange: string; delayMin: number; tradeAmount: number; stopLoss: string; takeProfit: string }>;
  openAtEnd: number;
}

const hourLabel = (n: number) => `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? "AM" : "PM"}`;

export async function buildDayStats(env: Env, start: number, end: number, label: string, botId?: string | null): Promise<DayStats> {
  const bf = (col: string) => (botId ? ` AND ${col} = ?` : "");
  const bb = (...a: unknown[]) => (botId ? [...a, botId] : a);
  const closed = (await env.DB.prepare("SELECT * FROM positions WHERE status != 'open' AND closed_ts >= ? AND closed_ts < ?" + bf("bot_id")).bind(...bb(start, end)).all<PositionRow>()).results ?? [];
  const perf = computePerformance(closed);

  const hours = new Map<number, { trades: number; wins: number; losses: number; pnl: number }>();
  for (const p of closed) {
    const h = hours.get(etHourOf(p.opened_ts)) ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
    h.trades++;
    if (p.result === "win") h.wins++;
    if (p.result === "loss") h.losses++;
    h.pnl += p.realized_pnl ?? 0;
    hours.set(etHourOf(p.opened_ts), h);
  }

  const early = (
    await env.DB.prepare(
      "SELECT p.close_reason, p.outcome, p.entry_qty, p.entry_cost, p.entry_fee, p.realized_pnl, m.result FROM positions p JOIN markets m ON m.ticker = p.ticker " +
        "WHERE p.status != 'open' AND p.closed_ts >= ? AND p.closed_ts < ? AND p.close_reason IN ('stop_loss','take_profit')" + bf("p.bot_id"),
    )
      .bind(...bb(start, end))
      .all<HindsightRow>()
  ).results;

  const notes = (await env.DB.prepare("SELECT bot_id, ticker, samples, counts, texts FROM contract_notes WHERE updated_ts >= ? AND updated_ts < ?" + bf("bot_id")).bind(...bb(start, end)).all<{ bot_id: string; ticker: string; samples: number; counts: string; texts: string }>()).results;
  const traded = new Set(closed.map((p) => `${p.bot_id}|${p.ticker}`));
  const totals: Record<string, number> = {};
  const examples: Record<string, string> = {};
  let samples = 0;
  let tradedContracts = 0;
  for (const n of notes) {
    if (traded.has(`${n.bot_id}|${n.ticker}`)) tradedContracts++;
    samples += n.samples;
    const c = JSON.parse(n.counts) as Record<string, number>;
    const t = JSON.parse(n.texts) as Record<string, string>;
    for (const [code, k] of Object.entries(c)) {
      totals[code] = (totals[code] ?? 0) + k;
      examples[code] = t[code] ?? examples[code] ?? code;
    }
  }
  const share = Object.entries(totals)
    .filter(([code]) => code !== "ok")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([code, k]) => ({ code, pctOfTime: samples ? Math.round((100 * k) / samples) : 0, example: examples[code] }));

  const flowRows = (await env.DB.prepare("SELECT ticker, asset, open_ts, close_ts, yes_dollars, no_dollars, minutes FROM contract_flow WHERE close_ts >= ? AND close_ts < ? ORDER BY close_ts DESC LIMIT 400").bind(start, end).all<FlowRow>()).results ?? [];
  const flowResults = new Map<string, string | null>();
  for (let i = 0; i < flowRows.length; i += 80) {
    const c = flowRows.slice(i, i + 80).map((r) => r.ticker);
    const res = await env.DB.prepare(`SELECT ticker, result FROM markets WHERE ticker IN (${c.map(() => "?").join(",")})`).bind(...c).all<{ ticker: string; result: string | null }>();
    for (const m of res.results ?? []) flowResults.set(m.ticker, m.result);
  }
  const moneyFlow = moneyFlowSummary(flowRows, closed, flowResults);

  const day = await reliability(env, start, end);
  const prev = await reliability(env, start - 7 * 86_400_000, start);
  const prevDays = 7;
  const bots = ((await env.DB.prepare("SELECT name, config, enabled FROM bots" + (botId ? " WHERE id = ?" : "")).bind(...(botId ? [botId] : [])).all<{ name: string; config: string; enabled: number }>()).results ?? []).map((b) => {
    const c = JSON.parse(b.config);
    return {
      name: b.name,
      enabled: b.enabled === 1,
      sideBought: c.betSide === "underdog" ? "the low-probability side (the probability range applies to that cheap side)" : "the favorite side",
      tradeAsset: c.tradeAsset,
      assets: c.assets,
      probRange: c.probMax !== undefined && c.probMax < 1 ? `${Math.round(c.probThreshold * 100)}%-${Math.round(c.probMax * 100)}%` : `${Math.round(c.probThreshold * 100)}%+`,
      delayMin: c.timeDelaySec / 60,
      tradeAmount: c.tradeAmount,
      stopLoss: c.stopLossOn ? `$${c.stopLoss}` : "off",
      takeProfit: c.takeProfitOn ? `$${c.takeProfit}` : "off",
    };
  });
  const open = await env.DB.prepare("SELECT COUNT(*) c FROM positions WHERE status='open'" + bf("bot_id")).bind(...bb()).first<{ c: number }>();

  return {
    label,
    perf,
    byEntryHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => ({ hour: hourLabel(h), ...v, pnl: Math.round(v.pnl * 100) / 100 })),
    stopLossTakeProfitHindsight: hindsightFor(early),
    exitEarlyHindsight: await exitEarlyFor(env, closed),
    missedByDisagreement: await missedByDisagreement(env, start, end, botId),
    moneyFlow,
    earlyExits: await describeTrades(env, closed.filter((p) => p.close_reason === "stop_loss" || p.close_reason === "take_profit").slice(0, 40)),
    blockedBy: { contractsWatched: notes.length, contractsTraded: tradedContracts, share },
    reliability: {
      day: day.total,
      byHour: day.byHour,
      previous7DaysAverage: prev.total.contracts ? { contracts: Math.round(prev.total.contracts / prevDays), reached: Math.round(prev.total.reached / prevDays), reversed: Math.round(prev.total.reversed / prevDays) } : null,
    },
    bots,
    openAtEnd: open?.c ?? 0,
  };
}

const PROMPT =
  "You are the end-of-day analyst for an automated Kalshi trading bot. You are ADVISORY ONLY: you cannot change settings, start or stop bots, or place orders, and you must never say you did. " +
  "The owner can already see every trade, every chart and the total profit/loss, so DO NOT recap trades or restate totals. " +
  "Using ONLY the measured data below, write a short overview (under 250 words, plain language, bullets) covering: " +
  "(1) anything in the data that is NOT obvious from looking at the trades: patterns by entry hour, asset, probability range, YES vs NO, or how trades ended; " +
  "(2) blockedBy: what kept the bots from trading, and what share of the tradeable time each blocker accounted for; " +
  "(3) stopLossTakeProfitHindsight: for trades that were stopped out or took profit early, how many would have finished in our favor had they been held, and what holding would have made versus what they actually made (this is hindsight and ignores the risk the exit removed; say so). earlyExits lists each such trade in full, including finalResult (how the 15-minute contract finally settled), ifHeldPnl, and afterExit (our side's best, worst and last probability after the exit until the contract closed): use it to say whether stopped-out trades recovered; " +
  "(4) reliability: how often a side reached 80% and then lost, versus the previous 7-day daily average, and any hours that stand out; " +
  "(4b) moneyFlow: how much money was placed on YES and on NO in each recorded contract, and whether the money on our side at entry (the ratio of our side to the other side over the 3 minutes up to the entry) looked different on winning trades than on losing ones; say how many trades each number rests on, and if contractsRecorded is 0 or the sample is small write 'not enough data'; " +
  "(4d) exitEarlyHindsight: for trades held to settlement, whether selling 3 or 2 minutes before the contract closed would have made more or less in total, how much the winners would have given up versus how much the losers would have saved, and how many trades each way; say it is hindsight and an estimate and give the sample size; " +
  "(4c) missedByDisagreement (only when it is not null): how many contracts a metals bot skipped because gold and silver did not lean the same way, how many of those would have won or lost, and the estimated profit or loss had they been taken; say it is an estimate; " +
  "(5) at most three specific setting changes worth testing, each with the measured evidence and the sample size behind it. " +
  "HOW TO WRITE: plain text only. No markdown: no asterisks, no bold, no headings, no code formatting. Never use field names or technical words from the data, and do not write the words measured or hypothesis or tag points. One point per line starting with a dash, each starting with its conclusion, then the numbers behind it. If you are guessing, say 'My guess:' before it. If a sample is too small to conclude anything, write 'not enough data' instead of guessing. Never invent numbers or trades. No disclaimers or reminders about being advisory. Use the Kalshi rules below only to understand how contracts are defined and settled.\n\n";

export interface Overview {
  text: string;
  ai: boolean;
  stats: DayStats;
}

export async function runOverview(env: Env, start: number, end: number, label: string): Promise<Overview> {
  const stats = await buildDayStats(env, start, end, label);
  const answer = await askAI(env, PROMPT + KALSHI_RULES_PROMPT + "\n\nDATA:\n" + JSON.stringify(stats).slice(0, 14_000));
  const text = `Overview for ${label}\n\n` + (answer ?? "The AI could not be reached, so there is no written overview for this period. The measured numbers are still saved with it.");
  await env.DB.prepare("INSERT INTO analyses (ts, stats, text) VALUES (?,?,?)").bind(Date.now(), JSON.stringify(stats).slice(0, 60_000), text).run();
  await log(env, answer ? "info" : "warn", "system", `Overview saved for ${label}${answer ? "" : " (AI unavailable)"}`);
  return { text, ai: !!answer, stats };
}

export function overviewEmail(o: Overview): string {
  const p = o.stats.perf;
  return emailShell(
    `Daily overview — ${o.stats.label}`,
    `<p>${p.trades} trades, ${p.wins} wins, ${p.losses} losses${p.winRate !== null ? `, win rate ${(p.winRate * 100).toFixed(0)}%` : ""}. Realized profit/loss after fees: <b>$${p.pnl.toFixed(2)}</b>.</p>` +
      `<div style="white-space:pre-wrap">${esc(o.text)}</div>`,
  );
}
