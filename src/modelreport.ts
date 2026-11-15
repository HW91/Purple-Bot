/**
 * The estimate report: for every settled contract that has saved estimates, take the saved row nearest 3 minutes before the close, look at the side
 * Kalshi's price favors, and compare Kalshi's price, my estimate for that side, and how often that side really won.
 */
import type { Env } from "./types";

export interface ModelReportRow {
  asset: string;
  bucket: string; // Kalshi's price for the favored side
  n: number;
  kalshi: number; // average Kalshi price for the favored side
  model: number; // average estimate for that same side
  actual: number; // share of those contracts where that side won
}

export interface ModelReport {
  days: number;
  minutesLeft: number;
  contractsLogged: number;
  rows: ModelReportRow[];
  howToRead: string;
}

const BUCKETS: Array<[string, number, number]> = [
  ["under 90%", 0, 0.9],
  ["90% to 97.5%", 0.9, 0.975],
  ["97.5% to 98.5%", 0.975, 0.985],
  ["98.5% and above", 0.985, 1.01],
];

export async function loadModelReport(env: Env, days = 14): Promise<ModelReport> {
  const since = Date.now() - days * 86_400_000;
  const rows = (
    await env.DB.prepare(
      "SELECT l.ticker, l.asset, l.secs_left, l.p_yes, l.k_yes, m.result FROM model_log l JOIN markets m ON m.ticker = l.ticker WHERE l.ts >= ? AND m.result IN ('yes','no') AND l.k_yes IS NOT NULL AND l.secs_left BETWEEN 120 AND 240",
    )
      .bind(since)
      .all<{ ticker: string; asset: string; secs_left: number; p_yes: number; k_yes: number; result: string }>()
  ).results ?? [];
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.ticker);
    if (!cur || Math.abs(r.secs_left - 180) < Math.abs(cur.secs_left - 180)) best.set(r.ticker, r);
  }
  const agg = new Map<string, { asset: string; bucket: string; n: number; k: number; p: number; won: number }>();
  for (const r of best.values()) {
    const side: "yes" | "no" = r.k_yes >= 0.5 ? "yes" : "no";
    const kFav = side === "yes" ? r.k_yes : 1 - r.k_yes;
    const pFav = side === "yes" ? r.p_yes : 1 - r.p_yes;
    const b = BUCKETS.find((x) => kFav >= x[1] && kFav < x[2]);
    if (!b) continue;
    const key = `${r.asset}|${b[0]}`;
    const a = agg.get(key) ?? { asset: r.asset, bucket: b[0], n: 0, k: 0, p: 0, won: 0 };
    a.n++;
    a.k += kFav;
    a.p += pFav;
    a.won += r.result === side ? 1 : 0;
    agg.set(key, a);
  }
  const out: ModelReportRow[] = [...agg.values()]
    .sort((x, y) => x.asset.localeCompare(y.asset) || BUCKETS.findIndex((b) => b[0] === x.bucket) - BUCKETS.findIndex((b) => b[0] === y.bucket))
    .map((a) => ({ asset: a.asset, bucket: a.bucket, n: a.n, kalshi: a.k / a.n, model: a.p / a.n, actual: a.won / a.n }));
  return {
    days,
    minutesLeft: 3,
    contractsLogged: best.size,
    rows: out,
    howToRead:
      "Each row groups settled crypto contracts by Kalshi's price for the side it favored, taken about 3 minutes before the close. kalshi = the average Kalshi price for that side, model = the bot's own average estimate for that same side, actual = how often that side really won. The estimate is useful only if actual sits closer to model than to kalshi, over a large number of contracts (n).",
  };
}
