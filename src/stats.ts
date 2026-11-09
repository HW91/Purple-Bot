/** Performance metrics from closed positions. Pure — measured numbers only, nothing interpolated. */
import type { PositionRow } from "./db";

export interface Group {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
}

export interface Performance {
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: number | null;
  pnl: number;
  avgEntryProbWinners: number | null;
  avgEntryProbLosers: number | null;
  /** highest probability the OTHER direction reached during losing trades (= 1 - lowest favorable probability) */
  highestOpposingProbInLosers: number | null;
  /** lowest favorable probability reached by winning trades */
  lowestFavorableProbInWinners: number | null;
  avgMaxFavorableProbWinners: number | null;
  avgMinFavorableProbLosers: number | null;
  avgProbMoveEntryToExit: number | null;
  byAsset: Group[];
  byBot: Group[];
  byProbRange: Group[];
  byDuration: Group[];
  byOutcome: Group[];
  byExitReason: Group[];
  missingProbData: number;
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function group(rows: PositionRow[], keyOf: (r: PositionRow) => string): Group[] {
  const m = new Map<string, Group>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? { key: k, trades: 0, wins: 0, losses: 0, winRate: null, pnl: 0 };
    g.trades++;
    if (r.result === "win") g.wins++;
    if (r.result === "loss") g.losses++;
    g.pnl += r.realized_pnl ?? 0;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, winRate: g.wins + g.losses ? g.wins / (g.wins + g.losses) : null, pnl: Math.round(g.pnl * 100) / 100 })).sort((a, b) => b.trades - a.trades);
}

export function probRange(p: number | null): string {
  if (!isNum(p)) return "unknown";
  if (p < 0.8) return "<80%";
  if (p < 0.85) return "80-85%";
  if (p < 0.9) return "85-90%";
  if (p < 0.95) return "90-95%";
  return "95%+";
}

export function computePerformance(all: PositionRow[]): Performance {
  const rows = all.filter((r) => r.status !== "open" && r.realized_pnl !== null);
  const winners = rows.filter((r) => r.result === "win");
  const losers = rows.filter((r) => r.result === "loss");
  const moves = rows.filter((r) => isNum(r.exit_prob) && isNum(r.entry_prob)).map((r) => r.exit_prob! - r.entry_prob!);
  return {
    trades: rows.length,
    wins: winners.length,
    losses: losers.length,
    flat: rows.length - winners.length - losers.length,
    winRate: winners.length + losers.length ? winners.length / (winners.length + losers.length) : null,
    pnl: Math.round(rows.reduce((a, r) => a + (r.realized_pnl ?? 0), 0) * 100) / 100,
    avgEntryProbWinners: avg(winners.map((r) => r.entry_prob).filter(isNum)),
    avgEntryProbLosers: avg(losers.map((r) => r.entry_prob).filter(isNum)),
    highestOpposingProbInLosers: losers.some((r) => isNum(r.fav_min)) ? Math.max(...losers.filter((r) => isNum(r.fav_min)).map((r) => 1 - r.fav_min!)) : null,
    lowestFavorableProbInWinners: winners.some((r) => isNum(r.fav_min)) ? Math.min(...winners.filter((r) => isNum(r.fav_min)).map((r) => r.fav_min!)) : null,
    avgMaxFavorableProbWinners: avg(winners.map((r) => r.fav_max).filter(isNum)),
    avgMinFavorableProbLosers: avg(losers.map((r) => r.fav_min).filter(isNum)),
    avgProbMoveEntryToExit: avg(moves),
    byAsset: group(rows, (r) => r.asset),
    byBot: group(rows, (r) => r.bot_id),
    byProbRange: group(rows, (r) => probRange(r.entry_prob)),
    byDuration: group(rows, (r) => `${r.duration_min ?? "?"} min`),
    byOutcome: group(rows, (r) => (r.outcome === "yes" ? "YES (up)" : "NO (down)")),
    byExitReason: group(rows, (r) => r.close_reason ?? "unknown"),
    missingProbData: rows.filter((r) => !isNum(r.fav_max) || !isNum(r.fav_min)).length,
  };
}
