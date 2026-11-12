import { describe, it, expect } from "vitest";
import { checklistFor } from "../src/checklist";
import { bucketOf, minuteLeftOf, feePerContract, wilson, samplesFromObs, samplesFromCandles, priceVerdict, type EdgeLookup } from "../src/edge";
import { FlowTracker, flowPasses } from "../src/flow";
import { evaluateEntry, evaluateExit, unrealizedPnl, checkRisk, dayStartMs, type AssetView } from "../src/strategy";
import { defaultBotConfig, validateBotConfig, type MarketInfo, type Quote } from "../src/types";
import { hindsightFor, etDateString, enrichTrade, moneyFlowSummary, summarizeMissed, exitEarlyHindsight, compactPrices, checklistStrings } from "../src/analysis";
import type { PositionRow } from "../src/db";
import { cleanAiText } from "../src/notify";
import { aggregateTrades, attachMarketProb } from "../src/volume";
import { KALSHI_RULES_PROMPT } from "../src/kalshi-rules";

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

  it("buys what is available when fewer contracts are on offer than wanted, and skips only when none are", () => {
    const withSize = (size: number) => ASSETS.map((a) => ({ asset: a, market: mk(a), quote: q(mk(a).ticker, a === "BTC" ? 0.83 : 0.6, a === "BTC" ? 0.85 : 0.62, now, size) }));
    const few = evaluateEntry(cfg, withSize(3), now); // wants 5, only 3 on offer
    expect(few.ok).toBe(true);
    expect(few.trade!.count).toBe(3);
    const plenty = evaluateEntry(cfg, withSize(100), now);
    expect(plenty.trade!.count).toBe(5);
    const none = evaluateEntry(cfg, withSize(0), now);
    expect(none.ok).toBe(false);
    expect(none.code).toBe("liquidity");
  });

  it("checklist shows each requirement as it is right now, not stopping at the first failure", () => {
    const views = (bid: number, ask: number, size = 100) => ASSETS.map((a) => ({ asset: a, market: mk(a), quote: q(mk(a).ticker, a === "BTC" ? bid : 0.6, a === "BTC" ? ask : 0.62, now, size) }));
    const by = (l: ReturnType<typeof checklistFor>) => Object.fromEntries(l.map((c) => [c.key, c.ok]));
    // BTC at 94% is above the default maximum: only that line is red, everything else that can be checked is green
    const high = by(checklistFor({ ...cfg, probMax: 0.89 }, views(0.93, 0.95), now));
    expect(high.probMax).toBe(false);
    expect(high.probMin).toBe(true);
    expect(high.liquidity).toBe(true);
    expect(high.risk).toBeNull();
    // back inside the range: the same line turns green (current state, not history)
    const inRange = by(checklistFor({ ...cfg, probMax: 0.89 }, views(0.85, 0.87), now));
    expect(inRange.probMax).toBe(true);
    // a probability under the minimum is red now, and no contracts is red on its own line
    const low = by(checklistFor(cfg, views(0.7, 0.72, 0), now));
    expect(low.probMin).toBe(false);
    expect(low.liquidity).toBe(false);
  });

  it("low-probability bot: buys the cheap side inside its own range (3% to 7%), the opposite of the favorite", () => {
    const low = { ...cfg, betSide: "underdog" as const, probThreshold: 0.03, probMax: 0.07 };
    // BTC YES bid 0.94 / ask 0.96 (95%): the market favors YES, so the cheap side is NO at 5%
    const views = ASSETS.map((a, i) => (i < 7 ? view(a, i === 0 ? 0.94 : 0.9, i === 0 ? 0.96 : 0.92, now) : view(a, 0.4, 0.42, now)));
    const d = evaluateEntry(low, views, now);
    expect(d.ok).toBe(true);
    expect(d.trade!.outcome).toBe("no");
    expect(d.trade!.orderSide).toBe("ask");
    expect(d.trade!.orderPrice).toBe(0.94);
    expect(d.trade!.costPerContract).toBeCloseTo(0.06, 10);
    expect(d.trade!.prob).toBeCloseTo(0.05, 10);
    expect(d.trade!.count).toBe(Math.floor(5 / 0.06)); // $5 buys 83 contracts at 6 cents
    // a small trade amount buys one contract (at 6 cents, $0.10 buys 1), and an amount below one contract's price buys nothing
    expect(evaluateEntry({ ...low, tradeAmount: 0.1 }, views, now).trade?.count).toBe(1);
    expect(evaluateEntry({ ...low, tradeAmount: 0.05 }, views, now).code).toBe("size");
    // a favorite bot with its own range is unchanged and would not trade this (95% is above its 80% to 89% range)
    expect(evaluateEntry({ ...cfg, probMax: 0.89 }, views, now).ok).toBe(false);
    // outside the low range (the cheap side is at 12%): no trade
    const mid = ASSETS.map((a, i) => (i < 7 ? view(a, i === 0 ? 0.87 : 0.9, i === 0 ? 0.89 : 0.92, now) : view(a, 0.4, 0.42, now)));
    expect(evaluateEntry(low, mid, now).ok).toBe(false);
    // when the market favors NO, the cheap side is YES
    const down = ASSETS.map((a, i) => (i < 8 ? view(a, i === 0 ? 0.04 : 0.1, i === 0 ? 0.06 : 0.12, now) : view(a, 0.6, 0.62, now)));
    const dd = evaluateEntry({ ...low, agreeCount: 7 }, down, now);
    expect(dd.trade?.outcome).toBe("yes");
    expect(dd.trade?.orderSide).toBe("bid");
    // the checklist reads the same side
    expect(checklistFor(low, views, now).find((c) => c.key === "probMin")?.text).toMatch(/NO probability 5\.0%/);
    // the checklist is built from the bot's own settings: its range, side, amount, delay, spread and time left
    const lines = checklistFor({ ...low, tradeAmount: 0.1 }, views, now);
    expect(lines.find((c) => c.key === "side")).toMatchObject({ ok: null });
    expect(lines.find((c) => c.key === "side")?.text).toMatch(/low-probability side: NO \(the market leans YES\)/);
    expect(lines.find((c) => c.key === "probMax")?.text).toMatch(/within your 7\.0% maximum/);
    expect(lines.find((c) => c.key === "size")?.text).toBe("Trade amount $0.10 buys 1 contract");
    const waiting = checklistFor({ ...low, tradeAmount: 0.1, timeDelaySec: 120, minRemainingSec: 90, maxSpread: 0.03 }, [], now).map((c) => c.text);
    expect(waiting).toContain("Low-side probability at least 3.0%");
    expect(waiting).toContain("Low-side probability and price paid at most 7.0%");
    expect(waiting).toContain("Time Delay of 120s passed");
    expect(waiting).toContain("At least 90s left in the contract");
    expect(waiting).toContain("Spread within 3.0%");
    expect(waiting).toContain("Trade amount $0.10 buys at least 1 contract");
    // a favorite bot has no side line and keeps its own wording
    expect(checklistFor(cfg, views, now).some((c) => c.key === "side")).toBe(false);
    // validation: the low side needs a range under 50%; the favorite side keeps its own rules
    expect(validateBotConfig({ strategy: "crypto", betSide: "underdog" })).toMatchObject({ betSide: "underdog", probThreshold: 0.03, probMax: 0.07 });
    expect(() => validateBotConfig({ strategy: "crypto", betSide: "underdog", probThreshold: 0.6, probMax: 0.9 })).toThrow(/low-probability/);
    expect(() => validateBotConfig({ strategy: "crypto", betSide: "underdog", probThreshold: 0.07, probMax: 0.03 })).toThrow(/maximum/);
    expect(validateBotConfig({ strategy: "crypto" }).betSide).toBe("favorite");
    expect(() => validateBotConfig({ strategy: "crypto", probThreshold: 0.05, probMax: 0.1 })).toThrow(/between 50% and 100%/);
  });

  it("no-trade windows (Eastern): block new entries inside a window, including one that runs past midnight", () => {
    // `now` is 21:52 Eastern
    const views = ASSETS.map((a, i) => (i < 7 ? view(a, i === 0 ? 0.83 : 0.6, i === 0 ? 0.85 : 0.62, now) : view(a, 0.4, 0.42, now)));
    expect(evaluateEntry(cfg, views, now).ok).toBe(true); // no windows: trades
    const inside = evaluateEntry({ ...cfg, noTradeWindows: [{ start: "21:30", end: "22:30" }] }, views, now);
    expect(inside.ok).toBe(false);
    expect(inside.code).toBe("window");
    expect(inside.reason).toMatch(/9:30 PM to 10:30 PM Eastern/);
    expect(evaluateEntry({ ...cfg, noTradeWindows: [{ start: "22:00", end: "01:00" }] }, views, now).ok).toBe(true); // starts later tonight
    expect(evaluateEntry({ ...cfg, noTradeWindows: [{ start: "21:50", end: "02:00" }] }, views, now).code).toBe("window"); // runs past midnight
    expect(evaluateEntry({ ...cfg, noTradeWindows: [{ start: "02:00", end: "03:00" }, { start: "21:00", end: "22:00" }] }, views, now).code).toBe("window"); // any of several
    expect(evaluateEntry({ ...cfg, noTradeWindows: [{ start: "21:30", end: "21:52" }] }, views, now).ok).toBe(true); // the end minute itself is free
    // the checklist shows the window line only when windows exist
    expect(checklistFor(cfg, views, now).some((c) => c.key === "window")).toBe(false);
    expect(checklistFor({ ...cfg, noTradeWindows: [{ start: "21:30", end: "22:30" }] }, views, now).find((c) => c.key === "window")?.ok).toBe(false);
    // validation
    expect(() => validateBotConfig({ strategy: "crypto", noTradeWindows: [{ start: "25:00", end: "01:00" }] })).toThrow(/start and an end/);
    expect(() => validateBotConfig({ strategy: "crypto", noTradeWindows: [{ start: "10:00", end: "10:00" }] })).toThrow(/different/);
    expect(validateBotConfig({ strategy: "crypto", noTradeWindows: [{ start: "09:00", end: "10:30" }] }).noTradeWindows).toEqual([{ start: "09:00", end: "10:30" }]);
    expect(validateBotConfig({ strategy: "crypto" }).noTradeWindows).toEqual([]);
  });

  it("order flow: needs the money on our side to beat the other side by the ratio, and never passes without data", () => {
    const flowCfg = { ...cfg, flowOn: true, flowRatio: 2, flowWindowMin: 3 };
    const withFlow = (flow: { yes: number; no: number } | null) => ASSETS.map((a) => ({ asset: a, market: mk(a), quote: q(mk(a).ticker, a === "BTC" ? 0.83 : 0.6, a === "BTC" ? 0.85 : 0.62, now), flow }));
    expect(evaluateEntry(flowCfg, withFlow({ yes: 300, no: 100 }), now).ok).toBe(true); // 3x >= 2x
    expect(evaluateEntry(flowCfg, withFlow({ yes: 200, no: 100 }), now).ok).toBe(true); // exactly 2x
    const low = evaluateEntry(flowCfg, withFlow({ yes: 150, no: 100 }), now);
    expect(low.ok).toBe(false);
    expect(low.code).toBe("flow");
    expect(low.reason).toMatch(/\$150 on YES vs \$100 on NO.*need 2x/);
    expect(evaluateEntry(flowCfg, withFlow({ yes: 1500, no: 12345.6 }), now).reason).toMatch(/\$1,500 on YES vs \$12,346 on NO/); // thousands commas
    expect(evaluateEntry(flowCfg, withFlow({ yes: 50, no: 0 }), now).ok).toBe(true); // money only on our side
    expect(evaluateEntry(flowCfg, withFlow({ yes: 0, no: 0 }), now).ok).toBe(false); // no trades at all = no support
    expect(evaluateEntry(flowCfg, withFlow(null), now).code).toBe("flow"); // data not loaded = never a pass
    expect(evaluateEntry(cfg, withFlow(null), now).ok).toBe(true); // turned off: unchanged
    // a NO trade needs the NO money to lead
    const noViews = (flow: { yes: number; no: number }) => ASSETS.map((a) => ({ asset: a, market: mk(a), quote: q(mk(a).ticker, a === "BTC" ? 0.15 : 0.35, a === "BTC" ? 0.17 : 0.37, now), flow }));
    expect(evaluateEntry(flowCfg, noViews({ yes: 100, no: 250 }), now).trade?.outcome).toBe("no");
    expect(evaluateEntry(flowCfg, noViews({ yes: 250, no: 100 }), now).ok).toBe(false);
  });

  it("money per minute: byMinute splits a contract into minutes, and the AI summary compares winners with losers", () => {
    const f = new FlowTracker();
    const T0 = 1_000_000_000_000;
    f.add("X", { id: "1", side: "yes", ts: T0 + 5_000, contracts: 10, yesPrice: 0.8, noPrice: 0.2 }); // minute 0: $8 YES
    f.add("X", { id: "2", side: "no", ts: T0 + 65_000, contracts: 10, yesPrice: 0.8, noPrice: 0.2 }); // minute 1: $2 NO
    f.add("X", { id: "3", side: "yes", ts: T0 + 70_000, contracts: 5, yesPrice: 0.8, noPrice: 0.2 }); // minute 1: $4 YES
    expect(f.byMinute("X", T0, T0 + 3 * 60_000)).toEqual([[8, 0], [4, 2], [0, 0]]);
    f.forget("X");
    expect(f.totals("X", T0, T0 + 200_000)).toEqual({ yes: 0, no: 0 });
    const rows = [
      { ticker: "A", asset: "BTC", open_ts: T0, close_ts: T0 + 900_000, yes_dollars: 300, no_dollars: 100, minutes: JSON.stringify(Array.from({ length: 15 }, () => [20, 6.67])) },
      { ticker: "B", asset: "BTC", open_ts: T0, close_ts: T0 + 1_800_000, yes_dollars: 100, no_dollars: 400, minutes: JSON.stringify(Array.from({ length: 15 }, () => [6.67, 26.67])) },
    ];
    const trades = [
      { ticker: "A", outcome: "yes" as const, opened_ts: T0 + 6 * 60_000, result: "win" },
      { ticker: "B", outcome: "yes" as const, opened_ts: T0 + 6 * 60_000, result: "loss" },
      { ticker: "C", outcome: "no" as const, opened_ts: T0, result: "win" }, // no money record: left out
    ];
    const s = moneyFlowSummary(rows, trades, new Map([["A", "yes"], ["B", "no"]]));
    expect(s.contractsRecorded).toBe(2);
    expect(s.tradesWithMoney.length).toBe(2);
    expect(s.tradesWithMoney[0]).toMatchObject({ side: "yes", ratio3min: 3, ratioWholeContract: 3, result: "win" });
    expect(s.winsVsLosses).toEqual({ wins: { trades: 1, medianRatio3min: 3 }, losses: { trades: 1, medianRatio3min: 0.25 } });
    expect(s.recentContracts[0]).toMatchObject({ yesToNoRatio: 0.25, finalResult: "no" });
  });

  it("exit early hindsight: re-prices settled trades at the bid 3 and 2 minutes before the close", () => {
    const C = 1_000_000_000_000 + 900_000; // contract close
    const at = (min: number) => C - min * 60_000;
    // YES winner entered at 0.85 x2: the bid was 0.93 at 3 min and 0.96 at 2 min. YES loser entered 0.85 x2: the bid was 0.40 then 0.20.
    const obs = new Map([
      ["W", [{ ts: at(3) - 5_000, bid: 0.93, ask: 0.95 }, { ts: at(2) - 5_000, bid: 0.96, ask: 0.97 }]],
      ["L", [{ ts: at(3) - 5_000, bid: 0.4, ask: 0.42 }, { ts: at(2) - 5_000, bid: 0.2, ask: 0.22 }]],
    ]);
    const trades = [
      { ticker: "W", outcome: "yes" as const, qty: 2, avgEntry: 0.85, entryFee: 0.04, pnl: 0.26, openedTs: at(10), closeTs: C }, // 2 x 0.15 - 0.04
      { ticker: "L", outcome: "yes" as const, qty: 2, avgEntry: 0.85, entryFee: 0.04, pnl: -1.74, openedTs: at(10), closeTs: C }, // -1.70 - 0.04
      { ticker: "W", outcome: "yes" as const, qty: 2, avgEntry: 0.85, entryFee: 0.04, pnl: 0.26, openedTs: at(1), closeTs: C }, // entered after the exit moment: left out
    ];
    const h = exitEarlyHindsight(trades, obs, 0.02, 0.01, [3, 2]);
    const three = h.options[0];
    expect(three.tradesCompared).toBe(2);
    // winner sold at 0.93 - 0.01 = 0.92: (0.07 x 2) - 0.04 entry fee - 0.04 exit fee = 0.06, versus 0.26 actual (gave up 0.20)
    expect(three.winnersGaveUp).toBeCloseTo(-0.2, 2);
    // loser sold at 0.40 - 0.01 = 0.39: (-0.46 x 2) - 0.04 - 0.04 = -1.00, versus -1.74 actual (saved 0.74)
    expect(three.losersSaved).toBeCloseTo(0.74, 2);
    expect(three.difference).toBeCloseTo(0.54, 2);
    expect(three.tradesBetterOff).toBe(1);
    expect(three.tradesWorseOff).toBe(1);
    // a trade with no price recorded near that moment is left out, never guessed
    expect(exitEarlyHindsight([trades[0]], new Map(), 0.02).options[0].tradesCompared).toBe(0);
  });

  it("edge rule: buys the side whose cautious win rate beats price plus fee, and only with enough history", () => {
    const edgeCfg = { ...cfg, entryRule: "edge" as const, assets: ["BTC"], agreeCount: 1, tradeAsset: "BTC", minEdge: 0.03, edgeMinSamples: 100 };
    const v = [{ asset: "BTC", market: mk("BTC"), quote: q(mk("BTC").ticker, 0.83, 0.85, now) }]; // YES mid 84%
    const look = (n: number, yesWins: number): EdgeLookup => (asset, minuteLeft, bucket) => (asset === "BTC" && bucket === bucketOf(0.84) && minuteLeft === minuteLeftOf(mk("BTC").closeTs, now) ? { n, yesWins } : null);
    // 500 contracts priced like this, 495 settled YES (99%): buying YES at 85% has a large edge
    const yes = evaluateEntry(edgeCfg, v, now, look(500, 495));
    expect(yes.ok).toBe(true);
    expect(yes.trade).toMatchObject({ outcome: "yes", orderSide: "bid", orderPrice: 0.85 });
    // only 40 contracts: not trusted
    const few = evaluateEntry(edgeCfg, v, now, look(40, 40));
    expect(few.ok).toBe(false);
    expect(few.code).toBe("edge");
    expect(few.reason).toMatch(/Not enough history.*40 contracts \(need 100\)/);
    // history says 84% win rate, the same as the price: no edge once the fee and the cautious range are counted
    const none = evaluateEntry(edgeCfg, v, now, look(500, 420));
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/No edge/);
    // history says contracts like this almost always settle NO: the edge is on NO (buy NO at 1 - bid = 17 cents)
    const no = evaluateEntry(edgeCfg, v, now, look(500, 5));
    expect(no.trade).toMatchObject({ outcome: "no", orderSide: "ask", orderPrice: 0.83 });
    // no history table at all
    expect(evaluateEntry(edgeCfg, v, now).code).toBe("edge");
    // the checklist shows the history and the edge, built from the bot's own settings
    const lines = checklistFor(edgeCfg, v, now, look(500, 495));
    expect(lines.find((c) => c.key === "history")).toMatchObject({ ok: true });
    expect(lines.find((c) => c.key === "edge")).toMatchObject({ ok: true });
    expect(lines.find((c) => c.key === "edge")?.text).toMatch(/need 3\.0/);
    expect(checklistFor(edgeCfg, v, now, look(40, 40)).find((c) => c.key === "edge")?.ok).toBeNull();
    // the standard rule is untouched
    expect(evaluateEntry(cfg, ASSETS.map((a, i) => (i < 7 ? view(a, i === 0 ? 0.83 : 0.6, i === 0 ? 0.85 : 0.62, now) : view(a, 0.4, 0.42, now))), now).ok).toBe(true);
    // validation: the edge rule works with a single asset and checks its own numbers
    // choosing the edge rule starts from the recommended values: small trades, tight spread, hold to settlement
    expect(validateBotConfig({ strategy: "crypto", entryRule: "edge", assets: ["BTC"], tradeAsset: "BTC" })).toMatchObject({ entryRule: "edge", minEdge: 0.03, edgeMinSamples: 300, tradeAmount: 1, dailyLossLimit: 3, dailyInvestLimit: 20, maxSpread: 0.03, timeDelaySec: 60, minRemainingSec: 120, stopLossOn: false, takeProfitOn: false });
    expect(validateBotConfig({ strategy: "crypto", entryRule: "edge", assets: ["BTC"], tradeAsset: "BTC", tradeAmount: 2, takeProfitOn: true })).toMatchObject({ tradeAmount: 2, takeProfitOn: true }); // the owner's own values win
    expect(validateBotConfig({ strategy: "crypto" })).toMatchObject({ tradeAmount: 5, dailyLossLimit: 20, maxSpread: 0.06, timeDelaySec: 300, takeProfitOn: true }); // other bots keep their defaults
    expect(() => validateBotConfig({ strategy: "crypto", entryRule: "edge", assets: ["BTC"], minEdge: 0.9 })).toThrow(/Minimum edge/);
    expect(() => validateBotConfig({ strategy: "crypto", entryRule: "edge", assets: ["BTC"], edgeMinSamples: 5 })).toThrow(/at least 20/);
    expect(validateBotConfig({ strategy: "crypto" }).entryRule).toBe("range");
  });

  it("Kalshi minute candles become one sample per minute before the close", () => {
    const CLOSE = 1_000_000_000_000;
    const c = (k: number, bid: string, ask: string) => ({ end_period_ts: CLOSE / 1000 - k * 60, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });
    const samples = samplesFromCandles([c(14, "0.5000", "0.5200"), c(3, "0.8300", "0.8500"), c(0, "0.9700", "0.9900"), c(2, "", ""), c(1, "0.9000", "0.8000"), c(15, "0.5", "0.52")], CLOSE);
    expect(samples.sort((a, b) => a.minuteLeft - b.minuteLeft)).toEqual([{ minuteLeft: 0, bucket: 39 }, { minuteLeft: 3, bucket: bucketOf(0.84) }, { minuteLeft: 14, bucket: bucketOf(0.51) }]); // empty books, crossed books and the opening candle are left out
  });

  it("price verdict: even when the price sits inside the win-rate range, otherwise YES cheap or expensive, and too few below 30", () => {
    expect(priceVerdict({ n: 10, yesWins: 10 }, 0.5)).toBe("too_few");
    expect(priceVerdict({ n: 200, yesWins: 170 }, 0.85)).toBe("even"); // won 85%, priced 85%
    expect(priceVerdict({ n: 200, yesWins: 172 }, 0.84)).toBe("even"); // a small gap is within luck
    expect(priceVerdict({ n: 500, yesWins: 475 }, 0.85)).toBe("yes_underpriced"); // won 95% but priced 85%
    expect(priceVerdict({ n: 500, yesWins: 380 }, 0.85)).toBe("yes_overpriced"); // won 76% but priced 85%
  });

  it("edge maths: buckets, minutes, Wilson range, fee, and one sample per minute of a contract", () => {
    expect(bucketOf(0.84)).toBe(33);
    expect(bucketOf(1)).toBe(39);
    expect(bucketOf(0)).toBe(0);
    expect(minuteLeftOf(10 * 60_000, 3 * 60_000 + 1)).toBe(6);
    expect(minuteLeftOf(10 * 60_000, 9.9 * 60_000)).toBe(0);
    expect(feePerContract(0.5)).toBeCloseTo(0.0175, 10);
    expect(feePerContract(0.055)).toBeCloseTo(0.00363825, 8); // Kalshi's own fee example
    const w = wilson(95, 100);
    expect(w.lo).toBeLessThan(0.95);
    expect(w.hi).toBeGreaterThan(0.95);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
    expect(wilson(500, 1000).lo).toBeGreaterThan(wilson(5, 10).lo); // more contracts, tighter range
    // the last recorded price in each minute is the sample for that minute
    const CLOSE = 20 * 60_000;
    const samples = samplesFromObs([
      { ts: CLOSE - 125_000, bid: 0.5, ask: 0.52 }, // 2 min left
      { ts: CLOSE - 100_000, bid: 0.8, ask: 0.82 }, // still 1 min left bucket (1 min 40 s)
      { ts: CLOSE - 70_000, bid: 0.9, ask: 0.92 }, // 1 min left: the last one in this minute wins
      { ts: CLOSE - 5_000, bid: 0.97, ask: 0.99 }, // 0 min left
      { ts: CLOSE + 1_000, bid: 0.5, ask: 0.5 }, // after the close: ignored
    ], CLOSE);
    expect(samples.sort((a, b) => a.minuteLeft - b.minuteLeft)).toEqual([{ minuteLeft: 0, bucket: 39 }, { minuteLeft: 1, bucket: bucketOf(0.91) }, { minuteLeft: 2, bucket: bucketOf(0.51) }]);
  });

  it("trade files: prices are compacted to [seconds from entry, bid, ask] and the saved checklist is readable", () => {
    const T0 = 1_000_000_000_000;
    expect(compactPrices([{ ts: T0 - 20_000, bid: 0.8301, ask: 0.8499 }, { ts: T0 + 10_000, bid: 0.9, ask: 0.92 }], T0)).toEqual([[-20, 0.83, 0.85], [10, 0.9, 0.92]]);
    expect(checklistStrings(JSON.stringify([{ key: "a", ok: true, text: "Live prices available" }, { key: "b", ok: false, text: "Spread too wide" }, { key: "c", ok: null, text: "Risk limits" }]))).toEqual(["OK: Live prices available", "FAILED: Spread too wide", "NOT TESTED: Risk limits"]);
    expect(checklistStrings(null)).toBeNull();
    expect(checklistStrings("not json")).toBeNull();
  });

  it("missed by disagreement: counts contracts only the no-agreement rules would have traded, with how they ended", () => {
    const trade = (ticker: string, result: "win" | "loss", pnl: number, entryTs: number) => ({ asset: "GOLD", ticker, outcome: "yes" as const, entryTs, entryProb: 0.85, count: 2, entryPrice: 0.86, exit: "settled" as const, exitTs: entryTs + 60_000, pnl, result });
    const report = (trades: ReturnType<typeof trade>[]) => ({ assumptions: [], periods: 0, trades, skippedUnsettled: 0, total: trades.length, wins: 0, losses: 0, winRate: null, netPnl: 0, maxDrawdown: 0, byAsset: {}, byOutcome: {} });
    const actual = report([trade("A", "win", 0.3, 1000)]);
    const without = report([trade("A", "win", 0.3, 1000), trade("B", "win", 0.25, 2000), trade("C", "loss", -1.7, 3000), trade("D", "win", 0.2, 4000)]);
    const s = summarizeMissed("Gold Bot", "GOLD", ["GOLD", "SILVER"], actual, without);
    expect(s).toMatchObject({ contractsMissed: 3, wouldHaveWon: 2, wouldHaveLost: 1, hypotheticalPnl: -1.25, tradesActuallyTaken: 1 });
    expect(s.missed.map((m) => m.result)).toEqual(["win", "loss", "win"]); // newest first: D, C, B
  });

  it("order flow totals: add up by side and time frame, ignore repeats, and are not trusted until loaded", () => {
    const f = new FlowTracker();
    const T0 = 1_000_000_000_000;
    f.add("X", { id: "a", side: "yes", ts: T0, contracts: 10, yesPrice: 0.8, noPrice: 0.2 }); // $8 on YES (YES price)
    f.add("X", { id: "b", side: "no", ts: T0 + 60_000, contracts: 10, yesPrice: 0.8, noPrice: 0.2 }); // $2 on NO (NO price)
    f.add("X", { id: "b", side: "no", ts: T0 + 60_000, contracts: 10, yesPrice: 0.8, noPrice: 0.2 }); // same trade again: ignored
    expect(f.totals("X", T0, T0 + 120_000)).toEqual({ yes: 8, no: 2 });
    expect(f.totals("X", T0 + 30_000, T0 + 120_000)).toEqual({ yes: 0, no: 2 }); // shorter time frame
    expect(f.isReady("X")).toBe(false);
    f.markReady("X");
    expect(f.isReady("X")).toBe(true);
    f.markAllNotReady();
    expect(f.isReady("X")).toBe(false);
    expect(flowPasses(0, 5, 1.5)).toBe(false);
    expect(flowPasses(15, 10, 1.5)).toBe(true);
    expect(() => validateBotConfig({ strategy: "crypto", flowRatio: 0.9 })).toThrow(/ratio/i);
    expect(() => validateBotConfig({ strategy: "crypto", flowWindowMin: 99 })).toThrow(/time frame/i);
    expect(validateBotConfig({ strategy: "crypto" }).flowOn).toBe(false);
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
  const cfg = { ...defaultBotConfig("crypto"), stopLossOn: true, stopLoss: 2.5 }; // the defaults have no stop loss; this test turns one on
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

describe("AI text cleanup", () => {
  it("removes markdown, [MEASURED] tags and the advisory reminder, but keeps the words and numbers", () => {
    const raw = [
      "Based on the telemetry for the last 14 days, here is the breakdown:",
      "",
      "* **[MEASURED]** **Total Stopped-Out Trades:** There are **8 trades** that exited via stop loss.",
      "### **[MEASURED]** Post-Exit Probability (8 Trades Total)",
      "  * **11/09 14:51 (YES):** Reached a peak of 99.95% after stop out.",
      "A value of `resolved: 0` and *some emphasis* here.",
      "*Reminder: I am an advisory system and cannot modify your bot configuration.*",
    ].join("\n");
    const out = cleanAiText(raw);
    expect(out).not.toMatch(/\*|#|`|MEASURED|Reminder/);
    expect(out).toMatch(/- Total Stopped-Out Trades: There are 8 trades that exited via stop loss\./);
    expect(out).toMatch(/Post-Exit Probability \(8 Trades Total\)/);
    expect(out).toMatch(/- 11\/09 14:51 \(YES\): Reached a peak of 99\.95% after stop out\./);
    expect(out).toMatch(/A value of resolved: 0 and some emphasis here\./);
  });
  it("leaves ordinary text, math and lowercase 'measured' alone", () => {
    expect(cleanAiText("5 * 3 = 15 and the price was measured at 0.85.")).toBe("5 * 3 = 15 and the price was measured at 0.85.");
  });
});

describe("volume behind a contract", () => {
  const open = Date.UTC(2026, 5, 15, 14, 0, 0);
  const close = open + 15 * 60_000;
  const tr = (side: "yes" | "no", count: string, yes: string, minute: number, sec: number, block = false) => ({
    count_fp: count,
    yes_price_dollars: yes,
    no_price_dollars: (1 - Number(yes)).toFixed(4),
    taker_outcome_side: side,
    created_time: new Date(open + minute * 60_000 + sec * 1000).toISOString(),
    is_block_trade: block,
  });
  const trades = [tr("yes", "2.00", "0.8400", 0, 30), tr("no", "3.00", "0.8000", 0, 45), tr("yes", "1.50", "0.9000", 1, 10), tr("no", "100.00", "0.9000", 1, 40, true), tr("yes", "4.00", "0.8600", 2, 5)];

  it("counts bets, contracts and dollars per side: YES pays the yes price, NO pays the no price", () => {
    const v = aggregateTrades(trades, open, close);
    expect(v.summary.yes).toMatchObject({ trades: 3, contracts: 7.5, dollars: 6.47 });
    expect(v.summary.no).toMatchObject({ trades: 2, contracts: 103, dollars: 10.6 });
    expect(v.summary.total).toMatchObject({ trades: 5, contracts: 110.5, dollars: 17.07 });
    expect(v.summary.yes.avgPrice).toBeCloseTo(0.863, 3);
    expect(v.summary.no.avgPrice).toBeCloseTo(0.103, 3);
  });
  it("identifies block trades (included in the totals) and splits everything by minute", () => {
    const v = aggregateTrades(trades, open, close);
    expect(v.summary.block).toMatchObject({ trades: 1, contracts: 100, dollars: 10 });
    expect(v.minutes).toHaveLength(15);
    expect(v.minutes[0]).toMatchObject({ yes: { trades: 1, dollars: 1.68 }, no: { trades: 1, dollars: 0.6 }, block: { trades: 0, dollars: 0 } });
    expect(v.minutes[1]).toMatchObject({ yes: { trades: 1, dollars: 1.35 }, no: { trades: 1, dollars: 10 }, block: { trades: 1, dollars: 10 } });
    expect(v.minutes[2].yes.dollars).toBe(3.44);
    expect(v.minutes[3].yes.trades + v.minutes[3].no.trades).toBe(0);
  });
  it("YES share of dollars, by minute and overall (null when nothing traded)", () => {
    const v = aggregateTrades(trades, open, close);
    expect(v.minutes[0].yesShare).toBeCloseTo(1.68 / 2.28, 3); // 0.7368
    expect(v.minutes[1].yesShare).toBeCloseTo(1.35 / 11.35, 3); // a big NO block trade: money leaned NO
    expect(v.minutes[2].yesShare).toBe(1);
    expect(v.minutes[3].yesShare).toBeNull();
    expect(v.summary.yesShare).toBeCloseTo(6.47 / 17.07, 3);
  });
  it("sets the market's own YES probability next to the share and reports the gap in points", () => {
    const v0 = aggregateTrades(trades, open, close);
    const v = attachMarketProb(v0, [{ minute: 0, prob: 0.84 }, { minute: 3, prob: 0.9 }], 0.86);
    expect(v.minutes[0].marketProb).toBe(0.84);
    expect(v.minutes[0].gap).toBeCloseTo((0.7368 - 0.84) * 100, 1); // about -10.3 points: more NO buying than the price implies
    expect(v.minutes[1].marketProb).toBeNull(); // nothing recorded that minute
    expect(v.minutes[1].gap).toBeNull();
    expect(v.minutes[3].marketProb).toBe(0.9);
    expect(v.minutes[3].gap).toBeNull(); // no trades that minute, so no share to compare
    expect(v.summary.marketProb).toBe(0.86);
    expect(v.summary.gap).toBeCloseTo((6.47 / 17.07 - 0.86) * 100, 1);
    expect(attachMarketProb(v0, [], null).summary.gap).toBeNull();
  });
  it("keeps trades outside the contract window in the totals but out of every minute", () => {
    const v = aggregateTrades([...trades, tr("yes", "1.00", "0.5000", -2, 0), tr("no", "1.00", "0.5000", 16, 0)], open, close);
    expect(v.summary.outside).toBe(2);
    expect(v.summary.total.trades).toBe(7);
    expect(v.minutes.reduce((s, m) => s + m.yes.trades + m.no.trades, 0)).toBe(5);
  });
  it("handles a contract with no trades", () => {
    const v = aggregateTrades([], open, close);
    expect(v.summary.total).toMatchObject({ trades: 0, contracts: 0, dollars: 0, avgPrice: null });
  });
});

describe("complete trade detail for the AI", () => {
  const T0 = Date.UTC(2026, 5, 15, 14, 0, 0);
  const stopped = { asset: "GOLD", outcome: "yes", entry_qty: 5, entry_cost: 4.25, entry_fee: 0.1, avg_entry: 0.85, exit_proceeds: 1.5, exit_fee: 0.1, close_reason: "stop_loss", opened_ts: T0 - 300_000, closed_ts: T0, realized_pnl: -2.95, entry_prob: 0.84, fav_min: 0.3, fav_max: 0.9 } as unknown as PositionRow;

  it("a stopped-out trade that went on to win: shows the recovery, the final result and what holding would have made", () => {
    const after = [
      { ts: T0 + 60_000, mid: 0.35 },
      { ts: T0 + 120_000, mid: 0.5 },
      { ts: T0 + 240_000, mid: 0.9 },
      { ts: T0 + 290_000, mid: 0.99 },
      { ts: T0 + 400_000, mid: 0.2 }, // after the contract closed: must be ignored
    ];
    const d = enrichTrade(stopped, "yes", T0 + 300_000, after);
    expect(d.endedInOurFavor).toBe(true);
    expect(d.finalResult).toBe("yes");
    expect(d.ifHeldPnl).toBeCloseTo(0.65, 2);
    expect(d.exitPrice).toBeCloseTo(0.3, 3);
    expect(d.amount).toBeCloseTo(4.25, 2);
    expect(d.afterExit).toMatchObject({ minutesToClose: 5, points: 4 });
    expect(d.afterExit!.bestProb).toBeCloseTo(0.99, 2);
    expect(d.afterExit!.worstProb).toBeCloseTo(0.35, 2);
    expect(d.afterExit!.lastProb).toBeCloseTo(0.99, 2);
  });

  it("a NO trade is measured on the NO side, and an unsettled contract has no result yet", () => {
    const noTrade = { ...stopped, outcome: "no" } as unknown as PositionRow;
    const d = enrichTrade(noTrade, null, T0 + 300_000, [{ ts: T0 + 60_000, mid: 0.2 }]);
    expect(d.finalResult).toBeNull();
    expect(d.endedInOurFavor).toBeNull();
    expect(d.ifHeldPnl).toBeNull();
    expect(d.afterExit!.bestProb).toBeCloseTo(0.8, 2); // YES at 0.2 is NO at 0.8
  });

  it("a trade held to settlement has no 'after exit' section", () => {
    const held = { ...stopped, close_reason: "settled", exit_proceeds: 5 } as unknown as PositionRow;
    const d = enrichTrade(held, "yes", T0 + 300_000, [{ ts: T0 + 60_000, mid: 0.5 }]);
    expect(d.afterExit).toBeNull();
    expect(d.exitPrice).toBeNull();
    expect(d.endedInOurFavor).toBe(true);
  });
});

describe("Kalshi rules text for the AI", () => {
  it("carries the contract terms, says it is a template, and leaves out the confidential appendix", () => {
    expect(KALSHI_RULES_PROMPT).toMatch(/Settlement Value: The Settlement Value for this Contract is \$1\.00/);
    expect(KALSHI_RULES_PROMPT).toMatch(/Minimum Tick: The Minimum Tick size for the Contract shall be \$0\.01/);
    expect(KALSHI_RULES_PROMPT).toMatch(/crosses or meets the specified threshold at any point/);
    expect(KALSHI_RULES_PROMPT).toMatch(/TEMPLATE/);
    expect(KALSHI_RULES_PROMPT).not.toMatch(/CONFIDENTIAL|TRADING PROHIBITIONS|Strategic Petroleum Reserve/i);
  });
});

describe("overview helpers", () => {
  it("hindsight: what holding would have made versus what the early exit made", () => {
    const rows = [
      // stopped out, but the side finished winning: holding 5 contracts bought at 0.85 would have paid 5 - 4.25 - 0.1 = +0.65
      { close_reason: "stop_loss", outcome: "yes" as const, entry_qty: 5, entry_cost: 4.25, entry_fee: 0.1, realized_pnl: -2.95, result: "yes" },
      // stopped out and it kept losing: holding would have lost the whole cost + fee
      { close_reason: "stop_loss", outcome: "yes" as const, entry_qty: 5, entry_cost: 4.25, entry_fee: 0.1, realized_pnl: -1.0, result: "no" },
      // result not known yet: counted as a trade, not in the comparison
      { close_reason: "take_profit", outcome: "no" as const, entry_qty: 2, entry_cost: 1.6, entry_fee: 0.04, realized_pnl: 0.3, result: null },
    ];
    const h = hindsightFor(rows);
    expect(h.stop_loss).toEqual({ trades: 2, resolved: 2, wouldHaveWon: 1, realized: -3.95, ifHeld: -3.7 });
    expect(h.take_profit.trades).toBe(1);
    expect(h.take_profit.resolved).toBe(0);
  });
  it("Eastern date string follows New York, not UTC", () => {
    expect(etDateString(Date.UTC(2026, 5, 15, 3, 30, 0))).toBe("2026-06-14"); // 11:30 PM EDT the day before
    expect(etDateString(Date.UTC(2026, 5, 15, 5, 0, 0))).toBe("2026-06-15");
  });
});

describe("config validation + day boundary", () => {
  it("rejects unsafe values", () => {
    expect(validateBotConfig({ strategy: "metals", assets: ["GOLD", "PLATINUM"], tradeAsset: "GOLD" }).agreeCount).toBe(2);
    expect(() => validateBotConfig({ strategy: "metals", assets: ["GOLD", "SILVER"], tradeAsset: "PLATINUM" })).toThrow(/must also be one of/);
    expect(() => validateBotConfig({ strategy: "crypto", timeDelaySec: 15 * 60 })).toThrow(/Time Delay/);
    expect(() => validateBotConfig({ strategy: "crypto", agreeCount: 12 })).toThrow(/agreement/);
    expect(() => validateBotConfig({ strategy: "crypto", tradeAmount: 0 })).toThrow(/Trade amount/);
    expect(() => validateBotConfig({ strategy: "crypto", tradeAmount: 0.005 })).toThrow(/at least/);
    expect(validateBotConfig({ strategy: "crypto", tradeAmount: 0.1 }).tradeAmount).toBe(0.1); // one cheap contract
    expect(() => validateBotConfig({ strategy: "crypto", probThreshold: 0.8, probMax: 0.8 })).toThrow(/Maximum probability/);
    expect(validateBotConfig({ strategy: "crypto", probMax: 0.9 }).probMax).toBe(0.9);
    expect(validateBotConfig({ strategy: "crypto" }).probMax).toBe(1);
    expect(validateBotConfig({ strategy: "crypto", tradeAmount: 1 }).tradeAmount).toBe(1);
    expect(() => validateBotConfig({ strategy: "crypto", assets: ["BTC", "FOO"] })).toThrow(/not valid/);
  });
  it("accepts defaults from the plan", () => {
    const c = validateBotConfig({ strategy: "crypto" });
    expect(c).toMatchObject({ tradeAmount: 5, maxPositions: 1, maxTradesPerHour: 4, dailyLossLimit: 20, dailyInvestLimit: 50, probThreshold: 0.8, agreeCount: 7, timeDelaySec: 300, stopLossOn: false, stopLoss: 0, takeProfitOn: true, takeProfit: 1 });
  });
  it("finds midnight Eastern", () => {
    const t = Date.UTC(2026, 5, 15, 17, 30, 0); // 13:30 EDT
    expect(dayStartMs(t)).toBe(Date.UTC(2026, 5, 15, 4, 0, 0));
  });
});
