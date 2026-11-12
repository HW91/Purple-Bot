/**
 * The "edge" idea: compare the market's price with how often contracts at that price really won.
 *
 * Every settled contract is replayed from the prices the bot recorded: for each minute before the close we take the last recorded
 * YES mid price and note whether the contract finally settled YES. Counted per asset, per minute-before-close and per 2.5% price
 * level, that gives a win rate for "a contract priced like this, this many minutes before the close".
 *
 * The edge of buying a side = (win rate, using the safe end of the confidence range) - price paid - fee. The bot only buys when
 * that is at least the owner's minimum edge AND enough contracts back the number.
 */

export const BUCKETS = 40; // 2.5% wide
export const MINUTES = 15;

export interface Cell {
  n: number;
  yesWins: number;
}
/** Looks up how many contracts (and how many settled YES) were seen at this asset / minute-before-close / price level. */
export type EdgeLookup = (asset: string, minuteLeft: number, bucket: number) => Cell | null;

export const bucketOf = (yesMid: number): number => Math.max(0, Math.min(BUCKETS - 1, Math.floor(yesMid * BUCKETS)));
export const minuteLeftOf = (closeTs: number, ts: number): number => Math.max(0, Math.min(MINUTES - 1, Math.floor((closeTs - ts) / 60_000)));

/** Kalshi's trade-fee formula as shown in its own fee example: 0.07 x price x (1 - price), per contract. */
export const feePerContract = (price: number): number => 0.07 * price * (1 - price);

/** Wilson score range for a win rate (z = 1.64, about a 95% one-sided bound). */
export function wilson(wins: number, n: number, z = 1.64): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/** One sample per minute of a contract: the last recorded price inside that minute. */
export function samplesFromObs(obs: Array<{ ts: number; bid: number; ask: number }>, closeTs: number): Array<{ minuteLeft: number; bucket: number }> {
  const byMinute = new Map<number, number>();
  for (const o of obs) {
    if (!(o.bid > 0 && o.ask > 0 && o.ask >= o.bid) || o.ts >= closeTs) continue;
    byMinute.set(minuteLeftOf(closeTs, o.ts), bucketOf((o.bid + o.ask) / 2)); // observations come in time order, so the last one in a minute wins
  }
  return [...byMinute].map(([minuteLeft, bucket]) => ({ minuteLeft, bucket }));
}

/** Contracts seen at this price level, pooling the minute before and after so the numbers fill in faster. */
export function pooled(lookup: EdgeLookup, asset: string, minuteLeft: number, bucket: number): Cell {
  let n = 0;
  let yesWins = 0;
  for (let m = minuteLeft - 1; m <= minuteLeft + 1; m++) {
    if (m < 0 || m >= MINUTES) continue;
    const c = lookup(asset, m, bucket);
    if (c) {
      n += c.n;
      yesWins += c.yesWins;
    }
  }
  return { n, yesWins };
}

export interface SideEdge {
  side: "yes" | "no";
  price: number; // what one contract of this side costs now
  winRateLow: number; // the cautious end of the win rate range for this side
  winRate: number; // the plain win rate for this side
  fee: number;
  edge: number; // winRateLow - price - fee
}

/** The edge of buying YES at the ask and of buying NO (at 1 - the YES bid), using the cautious end of each win-rate range. */
export function sideEdges(cell: Cell, yesBid: number, yesAsk: number): { yes: SideEdge; no: SideEdge } {
  const w = wilson(cell.yesWins, cell.n);
  const pYes = cell.n ? cell.yesWins / cell.n : 0;
  const noPrice = 1 - yesBid;
  return {
    yes: { side: "yes", price: yesAsk, winRateLow: w.lo, winRate: pYes, fee: feePerContract(yesAsk), edge: w.lo - yesAsk - feePerContract(yesAsk) },
    no: { side: "no", price: noPrice, winRateLow: 1 - w.hi, winRate: 1 - pYes, fee: feePerContract(noPrice), edge: 1 - w.hi - noPrice - feePerContract(noPrice) },
  };
}

/** Is the price "even" with how often YES really won? Even = the price sits inside the win-rate range, so the gap could just be luck. */
export function priceVerdict(cell: Cell, price: number, minContracts = 30): "too_few" | "even" | "yes_underpriced" | "yes_overpriced" {
  if (cell.n < minContracts) return "too_few";
  const w = wilson(cell.yesWins, cell.n);
  if (price < w.lo) return "yes_underpriced";
  if (price > w.hi) return "yes_overpriced";
  return "even";
}
