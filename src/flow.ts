/**
 * Order flow: how much money has been placed on YES and on NO in each contract.
 *
 * A trade counts for the side that STARTED it (Kalshi's `taker_outcome_side`). Dollars = contracts x the price that side
 * paid (the YES price for a YES trade, the NO price for a NO trade). Block trades are included. This is the same rule as
 * the volume table, so the numbers match.
 *
 * Trades are kept in one-second buckets per contract, so adding up "the last N minutes" is cheap and exact to the second.
 * Trades come from Kalshi's live trade channel; a contract only counts as `ready` after the trades already placed before
 * we subscribed were also loaded, so a half-empty total is never used for a decision.
 */

export interface FlowTrade {
  id?: string;
  side: "yes" | "no";
  ts: number; // ms
  contracts: number;
  yesPrice: number;
  noPrice: number;
}

export interface FlowTotals {
  yes: number; // dollars placed on YES (taker side)
  no: number;
}

const KEEP_MS = 20 * 60_000; // longer than any contract (15 min) so a whole-contract window always has its data
const MAX_IDS = 20_000;

export class FlowTracker {
  private buckets = new Map<string, Map<number, FlowTotals>>();
  private ids = new Map<string, Set<string>>();
  private readySet = new Set<string>();

  /** Add one trade. Returns false when it was already counted (same trade id) or is not usable. */
  add(ticker: string, t: FlowTrade): boolean {
    const contracts = Number(t.contracts);
    const price = t.side === "yes" ? Number(t.yesPrice) : Number(t.noPrice);
    if (!Number.isFinite(t.ts) || !(contracts > 0) || !Number.isFinite(price) || price < 0) return false;
    if (t.id) {
      let seen = this.ids.get(ticker);
      if (!seen) this.ids.set(ticker, (seen = new Set()));
      if (seen.has(t.id)) return false;
      if (seen.size >= MAX_IDS) seen.clear(); // a contract never gets near this; the cap just bounds memory
      seen.add(t.id);
    }
    let b = this.buckets.get(ticker);
    if (!b) this.buckets.set(ticker, (b = new Map()));
    const sec = Math.floor(t.ts / 1000);
    const cell = b.get(sec) ?? { yes: 0, no: 0 };
    cell[t.side] += contracts * price;
    b.set(sec, cell);
    return true;
  }

  /** Money on each side from `sinceMs` up to now. */
  totals(ticker: string, sinceMs: number, nowMs: number): FlowTotals {
    const out: FlowTotals = { yes: 0, no: 0 };
    const b = this.buckets.get(ticker);
    if (!b) return out;
    const from = Math.floor(sinceMs / 1000);
    const to = Math.floor(nowMs / 1000);
    for (const [sec, cell] of b) {
      if (sec < from || sec > to) continue;
      out.yes += cell.yes;
      out.no += cell.no;
    }
    return { yes: Math.round(out.yes * 100) / 100, no: Math.round(out.no * 100) / 100 };
  }

  /** Money on each side for every minute of a contract (minute 0 = the minute it opened). */
  byMinute(ticker: string, openTs: number, closeTs: number): Array<[number, number]> {
    const count = Math.max(1, Math.ceil((closeTs - openTs) / 60_000));
    const rows: Array<[number, number]> = Array.from({ length: count }, () => [0, 0]);
    const b = this.buckets.get(ticker);
    if (b) {
      for (const [sec, cell] of b) {
        const ms = sec * 1000;
        if (ms < openTs || ms >= closeTs) continue;
        const i = Math.min(count - 1, Math.floor((ms - openTs) / 60_000));
        rows[i][0] += cell.yes;
        rows[i][1] += cell.no;
      }
    }
    return rows.map(([y, n]) => [Math.round(y * 100) / 100, Math.round(n * 100) / 100]);
  }

  /** A finished contract has been saved: drop its trades. */
  forget(ticker: string): void {
    this.buckets.delete(ticker);
    this.ids.delete(ticker);
    this.readySet.delete(ticker);
  }

  isReady(ticker: string): boolean {
    return this.readySet.has(ticker);
  }
  markReady(ticker: string): void {
    this.readySet.add(ticker);
  }
  /** The live feed dropped: totals may now be missing trades, so nothing is trusted until they are loaded again. */
  markAllNotReady(): void {
    this.readySet.clear();
  }

  /** Drop old buckets and contracts that have long finished. */
  prune(nowMs: number): void {
    const cutoff = Math.floor((nowMs - KEEP_MS) / 1000);
    for (const [ticker, b] of this.buckets) {
      for (const sec of b.keys()) if (sec < cutoff) b.delete(sec);
      if (b.size === 0) {
        this.buckets.delete(ticker);
        this.ids.delete(ticker);
        this.readySet.delete(ticker);
      }
    }
  }
}

/** Does the money on our side beat the other side by the required ratio? */
export function flowPasses(mine: number, other: number, ratio: number): boolean {
  if (!(mine > 0)) return false; // no money on our side (or none at all) is no support
  if (!(other > 0)) return true; // money only on our side
  return mine / other >= ratio - 1e-9;
}

/** Whole dollars with thousands commas, for example 12345.6 -> "$12,346". */
export function dollars0(x: number): string {
  return "$" + Math.round(x).toLocaleString("en-US");
}

/** "2.4x" style text, or "all" when the other side has nothing. */
export function flowRatioText(mine: number, other: number): string {
  if (!(other > 0)) return mine > 0 ? "no money on the other side" : "no trades";
  return `${(mine / other).toFixed(2)}x`;
}
