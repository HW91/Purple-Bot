/**
 * Trading volume behind a contract: how many trades, contracts and dollars were placed on YES and on NO, in total and by minute.
 *
 * Every Kalshi trade has a YES buyer and a NO buyer, so "a bet on YES" here means the side that STARTED the trade (the taker),
 * which Kalshi reports as `taker_outcome_side`. Dollars = contracts x the price that side paid (the YES price for a YES trade,
 * the NO price for a NO trade). Block trades (large negotiated trades) are included in the totals and also counted separately.
 *
 * Fields come from Kalshi's Get Trades endpoint (docs.kalshi.com/api-reference/market/get-trades).
 */

export interface RawTrade {
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_outcome_side: "yes" | "no";
  created_time: string; // RFC 3339
  is_block_trade: boolean;
}

export interface Side {
  trades: number;
  contracts: number;
  dollars: number;
}

export interface MinuteRow {
  minute: number; // 0 = first minute after the contract opened
  startTs: number;
  yes: Side;
  no: Side;
  block: { trades: number; dollars: number };
  /** YES dollars / (YES + NO dollars), 0..1. null when nothing traded that minute. */
  yesShare: number | null;
  /** Average YES probability the bot recorded that minute, 0..1. null when nothing was recorded. */
  marketProb: number | null;
  /** (yesShare - marketProb) x 100, in percentage points. null unless both exist. */
  gap: number | null;
}

export interface VolumeSummary {
  yes: Side & { avgPrice: number | null };
  no: Side & { avgPrice: number | null };
  total: Side & { avgPrice: number | null };
  block: Side; // included in the numbers above
  outside: number; // trades before the contract opened or after it closed (counted in the totals, not in any minute)
  yesShare: number | null; // YES dollars / total dollars for the whole contract
  marketProb: number | null; // average YES probability recorded over the contract
  gap: number | null; // (yesShare - marketProb) x 100, in points
}

export interface Volume {
  tradesCount: number;
  truncated: boolean; // true if there were more trades than we fetched
  summary: VolumeSummary;
  minutes: MinuteRow[];
}

const zero = (): Side => ({ trades: 0, contracts: 0, dollars: 0 });
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (s: unknown) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function aggregateTrades(trades: RawTrade[], openTs: number, closeTs: number, truncated = false): Volume {
  const minutesCount = Math.max(1, Math.ceil((closeTs - openTs) / 60_000));
  const minutes = Array.from({ length: minutesCount }, (_, minute) => ({ minute, startTs: openTs + minute * 60_000, yes: zero(), no: zero(), block: { trades: 0, dollars: 0 } }));
  const yes = zero();
  const no = zero();
  const block = zero();
  let outside = 0;

  for (const t of trades) {
    const side = t.taker_outcome_side === "no" ? "no" : "yes";
    const contracts = num(t.count_fp);
    const dollars = contracts * num(side === "yes" ? t.yes_price_dollars : t.no_price_dollars);
    const tot = side === "yes" ? yes : no;
    tot.trades++;
    tot.contracts += contracts;
    tot.dollars += dollars;
    if (t.is_block_trade) {
      block.trades++;
      block.contracts += contracts;
      block.dollars += dollars;
    }
    const ts = Date.parse(t.created_time);
    if (!Number.isFinite(ts) || ts < openTs || ts >= closeTs) {
      outside++;
      continue;
    }
    const row = minutes[Math.min(minutesCount - 1, Math.floor((ts - openTs) / 60_000))];
    const cell = side === "yes" ? row.yes : row.no;
    cell.trades++;
    cell.contracts += contracts;
    cell.dollars += dollars;
    if (t.is_block_trade) {
      row.block.trades++;
      row.block.dollars += dollars;
    }
  }

  const fin = (s: Side) => ({ trades: s.trades, contracts: r2(s.contracts), dollars: r2(s.dollars) });
  const withAvg = (s: Side) => ({ ...fin(s), avgPrice: s.contracts > 0 ? Math.round((s.dollars / s.contracts) * 1000) / 1000 : null });
  const total = { trades: yes.trades + no.trades, contracts: yes.contracts + no.contracts, dollars: yes.dollars + no.dollars };
  const share = (y: number, n: number) => (y + n > 0 ? Math.round((y / (y + n)) * 10_000) / 10_000 : null);
  return {
    tradesCount: trades.length,
    truncated,
    summary: { yes: withAvg(yes), no: withAvg(no), total: withAvg(total), block: fin(block), outside, yesShare: share(yes.dollars, no.dollars), marketProb: null, gap: null },
    minutes: minutes.map((m) => ({ ...m, yes: fin(m.yes), no: fin(m.no), block: { trades: m.block.trades, dollars: r2(m.block.dollars) }, yesShare: share(m.yes.dollars, m.no.dollars), marketProb: null, gap: null })),
  };
}

/**
 * Add the market's own YES probability (average of what the bot recorded) next to the money split, and the gap between them.
 * With equal contract counts bought on each side, the YES share of dollars would equal the YES price, so a positive gap means
 * more YES buying than the price implies and a negative gap means more NO buying.
 */
export function attachMarketProb(v: Volume, perMinute: Array<{ minute: number; prob: number }>, overall: number | null): Volume {
  const gap = (share: number | null, prob: number | null) => (share !== null && prob !== null ? Math.round((share - prob) * 1000) / 10 : null);
  const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const byMinute = new Map(perMinute.map((p) => [p.minute, round4(p.prob)]));
  const minutes = v.minutes.map((m) => {
    const marketProb = byMinute.get(m.minute) ?? null;
    return { ...m, marketProb, gap: gap(m.yesShare, marketProb) };
  });
  const marketProb = overall === null ? null : round4(overall);
  return { ...v, minutes, summary: { ...v.summary, marketProb, gap: gap(v.summary.yesShare, marketProb) } };
}
