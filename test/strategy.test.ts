import { describe, it, expect } from "vitest";
import { evaluateEntry, evaluateExit, unrealizedPnl, checkRisk, dayStartMs, type AssetView } from "../src/strategy";
import { defaultBotConfig, validateBotConfig, type MarketInfo, type Quote } from "../src/types";

const OPEN = 1_000_000_000_000;
const mk = (asset: string): MarketInfo => ({ ticker: `KX${asset}15M-T`, asset, series: `KX${asset}15M`, title: "", openTs: OPEN, closeTs: OPEN + 15 * 60_000, status: "open" });
const q = (t: string, bid: number, ask: number, ts: number, size = 100): Quote => ({ ticker: t, yesBid: bid, yesAsk: ask, yesBidSize: size, yesAskSize: size, last: (bid + ask) / 2, ts });
const view = (asset: string, bid: number, ask: number, now: number): AssetView => ({ asset, market: mk(asset), quote: q(mk(asset).ticker, bid, ask, now) });
const ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ADA", "BCH"];

describe("crypto entry", () => {
  const cfg = defaultBotConfig("crypto");
  const now = OPEN + 6 * 60_000; // 6 min in, delay = 5 min

  it("enters when 7 of 9 agree, probability >= 80%, delay passed", () => {
    const views = ASSETS.map((a, i) => (i < 7 ? view(a, i === 0 ? 0.83 : 0.6, i === 0 ? 0.85 : 0.62, now) : view(a, 0.4, 0.42, now)));
    const d = evaluateEntry(cfg, views, now);
    expect(d.ok).toBe(true);
    expect(d.trade!.outcome).toBe("yes");
    expect(d.trade!.asset).toBe("BTC");
    expect(d.trade!.orderSide).toBe("bid");
    expect(d.trade!.orderPrice).toBe(0.85);
    expect(d.trade!.count).toBe(5); // floor(5 / 0.85)
  });

  it("trades NO using NO probability: ask at the YES bid, cost = 1 - yesBid", () => {
    const views = ASSETS.map((a, i) => (i < 8 ? view(a, i === 0 ? 0.15 : 0.35, i === 0 ? 0.17 : 0.37, now) : view(a, 0.6, 0.62, now)));
    const d = evaluateEntry(cfg, views, now);
    expect(d.ok).toBe(true);
    expect(d.trade!.outcome).toBe("no");
    expect(d.trade!.orderSide).toBe("ask");
    expect(d.trade!.orderPrice).toBe(0.15);
    expect(d.trade!.costPerContract).toBeCloseTo(0.85, 10);
    expect(d.trade!.prob).toBeCloseTo(0.84, 10);
  });

  it("trades only the chosen asset, even when another asset has the higher probability", () => {
    // BTC (the chosen asset) at 70% is below the threshold; SOL at 95% must NOT be traded instead.
    const views = ASSETS.map((a, i) => (a === "BTC" ? view(a, 0.69, 0.71, now) : a === "SOL" ? view(a, 0.94, 0.96, now) : view(a, 0.6, 0.62, now)));
    const d = evaluateEntry(cfg, views, now);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/BTC/);
    // and with a different chosen asset it trades that one
    const d2 = evaluateEntry({ ...cfg, tradeAsset: "SOL" }, views, now);
    expect(d2.ok).toBe(true);
    expect(d2.trade!.asset).toBe("SOL");
  });

  it("does not enter above the maximum probability, or when the price paid is above it", () => {
    const capped = { ...cfg, probMax: 0.9 };
    // BTC at 93% is inside the market's lean but above the 90% maximum
    const high = ASSETS.map((a) => view(a, a === "BTC" ? 0.92 : 0.6, a === "BTC" ? 0.94 : 0.62, now));
    const d = evaluateEntry(capped, high, now);
    expect(d.ok).toBe(false);
    expect(d.code).toBe("above_max");
    expect(d.reason).toMatch(/maximum/);
    // probability 89% (inside) but the ask is 92c: the price paid is above the cap
    const edge = ASSETS.map((a) => view(a, a === "BTC" ? 0.86 : 0.6, a === "BTC" ? 0.92 : 0.62, now));
    expect(evaluateEntry({ ...cfg, probMax: 0.9, maxSpread: 0.1 }, edge, now).code).toBe("above_max");
    // inside the range it still trades; no limit (default) is unchanged
    const ok = ASSETS.map((a) => view(a, a === "BTC" ? 0.84 : 0.6, a === "BTC" ? 0.86 : 0.62, now));
    expect(evaluateEntry(capped, ok, now).ok).toBe(true);
    expect(evaluateEntry(cfg, high, now).ok).toBe(true);
  });

  it("waits for the Time Delay and gives the reason", () => {
    const early = OPEN + 2 * 60_000;
    const views = ASSETS.map((a) => view(a, 0.83, 0.85, early));
    const d = evaluateEntry(cfg, views, early);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/Time Delay/);
  });

  it("skips when only 6 of 9 agree", () => {
    const views = ASSETS.map((a, i) => (i < 6 ? view(a, 0.83, 0.85, now) : view(a, 0.3, 0.32, now)));
    const d = evaluateEntry(cfg, views, now);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/Only 6 of 9/);
    expect(d.code).toBe("agreement");
  });

  it("skips when probability is under the threshold", () => {
    const views = ASSETS.map((a) => view(a, 0.7, 0.72, now));
    expect(evaluateEntry(cfg, views, now).ok).toBe(false);
  });

  it("treats missing or stale data as not agreeing (never green)", () => {
    const views = ASSETS.map((a) => view(a, 0.83, 0.85, now - 120_000));
    const d = evaluateEntry(cfg, views, now);
    expect(d.ok).toBe(false);
  });

  it("refuses wide spreads and not-enough-time", () => {
    const wide = ASSETS.map((a) => view(a, 0.78, 0.9, now));
    expect(evaluateEntry(cfg, wide, now).ok).toBe(false);
    const late = OPEN + 14 * 60_000;
    expect(evaluateEntry(cfg, ASSETS.map((a) => view(a, 0.83, 0.85, late)), late).reason).toMatch(/left in/);
  });
});

describe("metals entry", () => {
  const cfg = defaultBotConfig("metals");
  const now = OPEN + 6 * 60_000;
  it("needs gold AND silver to agree", () => {
    expect(evaluateEntry(cfg, [view("GOLD", 0.83, 0.85, now), view("SILVER", 0.3, 0.32, now)], now).reason).toMatch(/disagree/);
    expect(evaluateEntry(cfg, [view("GOLD", 0.83, 0.85, now), view("SILVER", 0.3, 0.32, now)], now).code).toBe("disagree");
    expect(evaluateEntry(cfg, [view("GOLD", 0.83, 0.85, now)], now).ok).toBe(false);
    const ok = evaluateEntry(cfg, [view("GOLD", 0.83, 0.85, now), view("SILVER", 0.6, 0.62, now)], now);
    expect(ok.ok).toBe(true);
    expect(ok.trade!.asset).toBe("GOLD");
  });
  it("trades the chosen metal; the other one only confirms", () => {
    const d = evaluateEntry({ ...cfg, tradeAsset: "SILVER" }, [view("GOLD", 0.9, 0.92, now), view("SILVER", 0.83, 0.85, now)], now);
    expect(d.ok).toBe(true);
    expect(d.trade!.asset).toBe("SILVER");
  });
  it("other metals cannot stand in for gold or silver", () => {
    const d = evaluateEntry({ ...cfg, assets: ["GOLD", "SILVER", "PLATINUM"] }, [view("PLATINUM", 0.9, 0.92, now), view("GOLD", 0.83, 0.85, now)], now);
    expect(d.ok).toBe(false);
  });
});

describe("exits", () => {
  const cfg = defaultBotConfig("crypto");
  it("take profit at +$1.00 and stop loss at -$2.50 using entry fees", () => {
    const pos = { outcome: "yes" as const, openQty: 5, avgEntry: 0.8, entryFee: 0.1 };
    // sell YES at 0.97 => gain 0.85 - fee 0.10 = 0.75 (not yet)
    expect(evaluateExit(cfg, pos, { yesBid: 0.97, yesAsk: 0.98 })).toBeNull();
    // 0.99 => 0.95 - 0.10 = 0.85; still under 1.00
    expect(evaluateExit(cfg, { ...pos, openQty: 8 }, { yesBid: 0.95, yesAsk: 0.96 })).toBe("take_profit"); // (0.15*8)-0.1 = 1.10
    expect(evaluateExit(cfg, pos, { yesBid: 0.3, yesAsk: 0.32 })).toBe("stop_loss"); // -2.5-0.1
  });
  it("NO positions value themselves at 1 - yesAsk", () => {
    const pos = { outcome: "no" as const, openQty: 5, avgEntry: 0.8, entryFee: 0 };
    expect(unrealizedPnl(pos, { yesBid: 0.1, yesAsk: 0.12 })).toBeCloseTo((0.88 - 0.8) * 5, 10);
  });
  it("can be turned off independently", () => {
    const pos = { outcome: "yes" as const, openQty: 5, avgEntry: 0.8, entryFee: 0 };
    expect(evaluateExit({ ...cfg, stopLossOn: false }, pos, { yesBid: 0.1, yesAsk: 0.12 })).toBeNull();
    expect(evaluateExit({ ...cfg, takeProfitOn: false }, { ...pos, openQty: 20 }, { yesBid: 0.99, yesAsk: 1 })).toBeNull();
  });
});

describe("risk", () => {
  const cfg = defaultBotConfig("crypto");
  const acct = { dailyLossLimit: 40, dailyInvestLimit: 100, maxPositions: 3 };
  const ok = { botOpenPositions: 0, accountOpenPositions: 0, botTradesLastHour: 0, botInvestedToday: 0, accountInvestedToday: 0, botNetPnlToday: 0, accountNetPnlToday: 0, pendingOrders: 0, balance: 50, reconciled: true };
  it("passes a clean state", () => expect(checkRisk(cfg, acct, ok, 4.25)).toBeNull());
  it("blocks before reconcile / unknown balance / pending orders", () => {
    expect(checkRisk(cfg, acct, { ...ok, reconciled: false }, 4)).toMatch(/reconciled/);
    expect(checkRisk(cfg, acct, { ...ok, balance: null }, 4)).toMatch(/balance unknown/);
    expect(checkRisk(cfg, acct, { ...ok, pendingOrders: 1 }, 4)).toMatch(/confirmed/);
  });
  it("enforces every limit, bot and account", () => {
    expect(checkRisk(cfg, acct, { ...ok, botOpenPositions: 1 }, 4)).toMatch(/open position/);
    expect(checkRisk(cfg, acct, { ...ok, accountOpenPositions: 3 }, 4)).toMatch(/Account already/);
    expect(checkRisk(cfg, acct, { ...ok, botTradesLastHour: 4 }, 4)).toMatch(/trades this hour/);
    expect(checkRisk(cfg, acct, { ...ok, botNetPnlToday: -20 }, 4)).toMatch(/daily loss/);
    expect(checkRisk(cfg, acct, { ...ok, accountNetPnlToday: -40 }, 4)).toMatch(/Account daily loss/);
    expect(checkRisk(cfg, acct, { ...ok, botInvestedToday: 48 }, 4)).toMatch(/investment/);
    expect(checkRisk(cfg, acct, { ...ok, accountInvestedToday: 98 }, 4)).toMatch(/Account daily investment/);
    expect(checkRisk(cfg, acct, { ...ok, balance: 3 }, 4)).toMatch(/Balance/);
  });
});

describe("config validation + day boundary", () => {
  it("rejects unsafe values", () => {
    expect(validateBotConfig({ strategy: "metals", assets: ["GOLD", "PLATINUM"], tradeAsset: "GOLD" }).agreeCount).toBe(2);
    expect(() => validateBotConfig({ strategy: "metals", assets: ["GOLD", "SILVER"], tradeAsset: "PLATINUM" })).toThrow(/must also be one of/);
    expect(() => validateBotConfig({ strategy: "crypto", timeDelaySec: 15 * 60 })).toThrow(/Time Delay/);
    expect(() => validateBotConfig({ strategy: "crypto", agreeCount: 12 })).toThrow(/agreement/);
    expect(() => validateBotConfig({ strategy: "crypto", tradeAmount: 0 })).toThrow(/Trade amount/);
    expect(() => validateBotConfig({ strategy: "crypto", tradeAmount: 0.5 })).toThrow(/at least/);
    expect(() => validateBotConfig({ strategy: "crypto", probThreshold: 0.8, probMax: 0.8 })).toThrow(/Maximum probability/);
    expect(validateBotConfig({ strategy: "crypto", probMax: 0.9 }).probMax).toBe(0.9);
    expect(validateBotConfig({ strategy: "crypto" }).probMax).toBe(1);
    expect(validateBotConfig({ strategy: "crypto", tradeAmount: 1 }).tradeAmount).toBe(1);
    expect(() => validateBotConfig({ strategy: "crypto", assets: ["BTC", "FOO"] })).toThrow(/not valid/);
  });
  it("accepts defaults from the plan", () => {
    const c = validateBotConfig({ strategy: "crypto" });
    expect(c).toMatchObject({ tradeAmount: 5, maxPositions: 1, maxTradesPerHour: 4, dailyLossLimit: 20, dailyInvestLimit: 50, probThreshold: 0.8, agreeCount: 7, timeDelaySec: 300, stopLossOn: true, stopLoss: 2.5, takeProfitOn: true, takeProfit: 1 });
  });
  it("finds midnight Eastern", () => {
    const t = Date.UTC(2026, 5, 15, 17, 30, 0); // 13:30 EDT
    expect(dayStartMs(t)).toBe(Date.UTC(2026, 5, 15, 4, 0, 0));
  });
});
