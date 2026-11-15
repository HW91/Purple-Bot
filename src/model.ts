/**
 * The bot's own estimate of the chance a 15-minute crypto contract finishes above its target, from the live price (Kalshi's CF Benchmarks feed),
 * how much the price has been moving, and the time left. Pure functions so they can be unit tested.
 *
 * The contract settles on the simple average of the index over its last 60 seconds, so the estimate is the chance that AVERAGE ends at or above the
 * target, not the chance of the last price. Price moves are treated as a random walk with no drift: over u seconds the price moves by about
 * sigma * sqrt(u), where sigma is measured from the recent ticks. The average of a random walk over a window of length w that starts u seconds from now
 * has variance sigma^2 * (u + w/3); once the window has begun, only the part still to come is uncertain.
 */

export const SETTLE_WINDOW_SEC = 60;

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * Movement per square-root-second, as a fraction of the price, from ticks [ms, price] (oldest first). It takes the larger of the last 10 minutes and the last
 * 2 minutes, so a sudden burst of movement is not averaged away. null when there are too few ticks to say.
 */
export function realizedSigma(ticks: Array<[number, number]>, now: number): number | null {
  const one = (windowMs: number, minTicks: number): number | null => {
    const from = now - windowMs;
    let sumSq = 0;
    let sumDt = 0;
    let n = 0;
    for (let i = 1; i < ticks.length; i++) {
      const [t0, p0] = ticks[i - 1];
      const [t1, p1] = ticks[i];
      if (t1 < from || !(p0 > 0) || !(p1 > 0) || t1 <= t0) continue;
      const dt = (t1 - t0) / 1000;
      if (dt > 30) continue; // a gap in the feed says nothing about movement
      sumSq += Math.log(p1 / p0) ** 2;
      sumDt += dt;
      n++;
    }
    return n >= minTicks && sumDt > 0 ? Math.sqrt(sumSq / sumDt) : null;
  };
  const long = one(600_000, 120);
  const short = one(120_000, 30);
  if (long === null) return null;
  return Math.max(long, short ?? 0);
}

export interface ProbInput {
  price: number; // the live index value now
  target: number;
  secsLeft: number; // seconds until the contract closes
  sigmaRel: number; // from realizedSigma
  /** Average of the final-minute ticks so far (Kalshi sends it during the last minute); falls back to the live price. */
  avgSoFar?: number | null;
}

/** Chance the final-minute average finishes at or above the target (the YES side). */
export function probAbove(i: ProbInput): number {
  const { price, target, secsLeft, sigmaRel } = i;
  if (!(price > 0) || !(target > 0)) return NaN;
  if (secsLeft <= 0) return price >= target ? 1 : 0;
  const sigma = sigmaRel * price; // dollars per square-root-second
  let mean: number;
  let variance: number;
  if (secsLeft > SETTLE_WINDOW_SEC) {
    mean = price;
    variance = sigma * sigma * (secsLeft - SETTLE_WINDOW_SEC + SETTLE_WINDOW_SEC / 3);
  } else {
    // inside the final minute: the first part of the window is already known, the rest is still to come
    const done = (SETTLE_WINDOW_SEC - secsLeft) / SETTLE_WINDOW_SEC;
    const known = i.avgSoFar && i.avgSoFar > 0 ? i.avgSoFar : price;
    mean = done * known + (1 - done) * price;
    variance = (1 - done) ** 2 * sigma * sigma * (secsLeft / 3);
  }
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-12)) return mean >= target ? 1 : 0;
  return normCdf((mean - target) / sd);
}
