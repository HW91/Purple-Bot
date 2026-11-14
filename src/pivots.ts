/**
 * Standard (classic floor) daily pivot points, worked out from Kalshi's own contract data: every 15-minute contract has a target price (the asset's
 * price when the contract opened) and, once settled, a final value (its price when it closed). The previous trading day's highest and lowest of those,
 * and the last final value, stand in for the day's high, low and close. Pure functions so they can be unit tested.
 */
export interface PivotLevel {
  name: string;
  value: number;
}

export interface DayPrices {
  day: string; // the day the prices come from (US Eastern, YYYY-MM-DD)
  high: number;
  low: number;
  close: number;
  samples: number; // how many contracts that day
}

export interface SettledContract {
  close_time: string;
  floor_strike?: number | null;
  expiration_value?: string | number | null;
}

const price = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The latest day before `today` that has at least `minContracts` settled contracts, as a high / low / close. */
export function dailyPrices(contracts: SettledContract[], today: string, etDate: (ms: number) => string, minContracts = 20): DayPrices | null {
  const byDay = new Map<string, SettledContract[]>();
  for (const c of contracts) {
    const t = Date.parse(c.close_time);
    if (!Number.isFinite(t)) continue;
    const day = etDate(t);
    if (day >= today) continue;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(c);
  }
  const days = [...byDay.keys()].sort().reverse();
  for (const day of days) {
    const list = byDay.get(day)!;
    if (list.length < minContracts) continue;
    const samples: number[] = [];
    for (const c of list) {
      const s = price(c.floor_strike);
      const e = price(c.expiration_value);
      if (s !== null) samples.push(s);
      if (e !== null) samples.push(e);
    }
    if (!samples.length) continue;
    const last = [...list].sort((a, b) => Date.parse(b.close_time) - Date.parse(a.close_time))[0];
    const close = price(last.expiration_value) ?? price(last.floor_strike);
    if (close === null) continue;
    return { day, high: Math.max(...samples), low: Math.min(...samples), close, samples: list.length };
  }
  return null;
}

/** Classic pivot, three resistance and three support levels. */
export function classicPivots(high: number, low: number, close: number): PivotLevel[] {
  const p = (high + low + close) / 3;
  return [
    { name: "S3", value: low - 2 * (high - p) },
    { name: "S2", value: p - (high - low) },
    { name: "S1", value: 2 * p - high },
    { name: "pivot", value: p },
    { name: "R1", value: 2 * p - low },
    { name: "R2", value: p + (high - low) },
    { name: "R3", value: high + 2 * (p - low) },
  ];
}

/** The closest level when `target` is within `bandPct` percent of it, otherwise null. */
export function pivotNear(target: number, levels: PivotLevel[], bandPct: number): { level: PivotLevel; distPct: number } | null {
  let best: { level: PivotLevel; distPct: number } | null = null;
  for (const level of levels) {
    if (!(level.value > 0)) continue;
    const distPct = (Math.abs(target - level.value) / level.value) * 100;
    if (distPct <= bandPct + 1e-9 && (!best || distPct < best.distPct)) best = { level, distPct };
  }
  return best;
}

export const levelText = (n: number): string => (n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(1) : n.toFixed(3));
