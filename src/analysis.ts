/**
 * End-of-day overview. The owner can already see every trade, chart and total, so this deliberately does NOT
 * recap trades. It measures the things that are hard to see by eye (what blocked trades, whether stop loss /
 * take profit helped in hindsight, which hours were reliable) and asks the AI to point out what matters.
 * Everything here is measured from this bot's own records; the AI is advisory only.
 */
import type { Env } from "./types";
import { askAI, emailShell, esc } from "./notify";
import { computePerformance, type Performance } from "./stats";
import type { PositionRow } from "./db";
import { log } from "./db";
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
  blockedBy: { contractsWatched: number; contractsTraded: number; share: Array<{ code: string; pctOfTime: number; example: string }> };
  reliability: { day: Reliability; byHour: Array<Reliability & { hour: number }>; previous7DaysAverage: Reliability | null };
  bots: Array<{ name: string; enabled: boolean; tradeAsset: string; assets: string[]; probRange: string; delayMin: number; tradeAmount: number; stopLoss: string; takeProfit: string }>;
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

  const day = await reliability(env, start, end);
  const prev = await reliability(env, start - 7 * 86_400_000, start);
  const prevDays = 7;
  const bots = ((await env.DB.prepare("SELECT name, config, enabled FROM bots" + (botId ? " WHERE id = ?" : "")).bind(...(botId ? [botId] : [])).all<{ name: string; config: string; enabled: number }>()).results ?? []).map((b) => {
    const c = JSON.parse(b.config);
    return {
      name: b.name,
      enabled: b.enabled === 1,
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
  "(3) stopLossTakeProfitHindsight: for trades that were stopped out or took profit early, how many would have finished in our favor had they been held, and what holding would have made versus what they actually made (this is hindsight and ignores the risk the exit removed; say so); " +
  "(4) reliability: how often a side reached 80% and then lost, versus the previous 7-day daily average, and any hours that stand out; " +
  "(5) at most three specific setting changes worth testing, each with the measured evidence and the sample size behind it. " +
  "Label each point MEASURED (directly in the data) or HYPOTHESIS (your inference). If a sample is too small to conclude anything, write 'not enough data' instead of guessing. Never invent numbers or trades. No disclaimers. Use the Kalshi rules below only to understand how contracts are defined and settled.\n\n";

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
