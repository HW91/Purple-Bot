import { describe, it, expect } from "vitest";
import { simulate, type Obs, type SimMarket } from "../src/backtest";
import { defaultBotConfig } from "../src/types";

const OPEN = Date.UTC(2026, 5, 15, 14, 0, 0);
const CLOSE = OPEN + 15 * 60_000;
const mkt = (asset: string, result: "yes" | "no" | null): SimMarket => ({ ticker: `T-${asset}`, asset, openTs: OPEN, closeTs: CLOSE, result });

function series(bid: number, ask: number): Obs[] {
  const out: Obs[] = [];
  for (let t = OPEN; t < CLOSE; t += 10_000) out.push({ ts: t, bid, ask });
  return out;
}

describe("backtest", () => {
  const cfg = { ...defaultBotConfig("metals"), tradeAmount: 5 };
  const opt = { feePerContract: 0.02, slippage: 0.01 };

  it("enters after the Time Delay and settles a winner", () => {
    const markets = [mkt("GOLD", "yes"), mkt("SILVER", "yes")];
    const obs = new Map([["T-GOLD", series(0.83, 0.85)], ["T-SILVER", series(0.6, 0.62)]]);
    const r = simulate({ ...cfg, takeProfitOn: false, stopLossOn: false }, markets, obs, opt);
    expect(r.total).toBe(1);
    expect(r.trades[0].entryTs).toBe(OPEN + 300_000); // 5-minute delay
    expect(r.trades[0].result).toBe("win");
    expect(r.trades[0].exit).toBe("settled");
    expect(r.netPnl).toBeGreaterThan(0);
  });

  it("every live setting works in a run: order flow (saved money per minute), no-trade windows, maximum probability", () => {
    const base = { ...cfg, takeProfitOn: false, stopLossOn: false };
    const markets = [mkt("GOLD", "yes"), mkt("SILVER", "yes")];
    const obs = new Map([["T-GOLD", series(0.83, 0.85)], ["T-SILVER", series(0.6, 0.62)]]);
    // money rule on: with no saved money record the bot never trades; with a record where YES has 3x NO it does
    const withRule = { ...base, flowOn: true, flowWindowMin: 0, flowRatio: 2 };
    expect(simulate(withRule, markets, obs, opt).total).toBe(0);
    const yesHeavy = new Map<string, Array<[number, number]>>([["T-GOLD", Array.from({ length: 15 }, () => [300, 100] as [number, number])]]);
    expect(simulate(withRule, markets, obs, opt, yesHeavy).total).toBe(1);
    const noHeavy = new Map<string, Array<[number, number]>>([["T-GOLD", Array.from({ length: 15 }, () => [100, 300] as [number, number])]]);
    expect(simulate(withRule, markets, obs, opt, noHeavy).total).toBe(0);
    // a no-trade window around the entry time (10:00 to 11:00 Eastern is 14:00 to 15:00 UTC in June) blocks it
    expect(simulate({ ...base, noTradeWindows: [{ start: "09:30", end: "10:30" }] }, markets, obs, opt).total).toBe(0);
    // the price (about 85%) is above a 80% to 84% range
    expect(simulate({ ...base, probMax: 0.84 }, markets, obs, opt).total).toBe(0);
  });

  it("settled loser counts as a loss; unsettled markets are excluded, not guessed", () => {
    const obs = new Map([["T-GOLD", series(0.83, 0.85)], ["T-SILVER", series(0.6, 0.62)]]);
    const off = { ...cfg, takeProfitOn: false, stopLossOn: false };
    expect(simulate(off, [mkt("GOLD", "no"), mkt("SILVER", "no")], obs, opt).trades[0].result).toBe("loss");
    const u = simulate(off, [mkt("GOLD", null), mkt("SILVER", null)], obs, opt);
    expect(u.total).toBe(0);
    expect(u.skippedUnsettled).toBe(1);
  });

  it("does nothing when gold and silver disagree", () => {
    const obs = new Map([["T-GOLD", series(0.83, 0.85)], ["T-SILVER", series(0.3, 0.32)]]);
    expect(simulate(cfg, [mkt("GOLD", "yes"), mkt("SILVER", "no")], obs, opt).total).toBe(0);
  });

  it("stop loss exits early when the price collapses", () => {
    const gold = series(0.83, 0.85).map((o) => (o.ts >= OPEN + 420_000 ? { ...o, bid: 0.3, ask: 0.32 } : o));
    const silver = series(0.6, 0.62).map((o) => (o.ts >= OPEN + 420_000 ? { ...o, bid: 0.4, ask: 0.42 } : o));
    const r = simulate({ ...cfg, stopLossOn: true, stopLoss: 2.5 }, [mkt("GOLD", "no"), mkt("SILVER", "no")], new Map([["T-GOLD", gold], ["T-SILVER", silver]]), opt);
    expect(r.trades[0].exit).toBe("stop_loss");
    expect(r.maxDrawdown).toBeGreaterThan(0);
  });
});
