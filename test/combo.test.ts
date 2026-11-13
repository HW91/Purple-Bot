import { describe, it, expect } from "vitest";
import { comboLegSide, evaluateCombo, pickComboQuote } from "../src/combo";
import type { AssetView } from "../src/strategy";
import { defaultBotConfig, validateBotConfig, type MarketInfo, type Quote } from "../src/types";

const OPEN = 1_000_000_000_000;
const CLOSE = OPEN + 15 * 60_000;
const mk = (asset: string, closeTs = CLOSE): MarketInfo => ({ ticker: `KX${asset}15M-T`, asset, series: `KX${asset}15M`, title: "", openTs: OPEN, closeTs, status: "open" });
const q = (t: string, bid: number, ask: number, ts: number): Quote => ({ ticker: t, yesBid: bid, yesAsk: ask, yesBidSize: 100, yesAskSize: 100, last: (bid + ask) / 2, ts });
const view = (asset: string, bid: number, ask: number, now: number, closeTs = CLOSE): AssetView => ({ asset, market: mk(asset, closeTs), quote: q(mk(asset).ticker, bid, ask, now) });

const cfg = validateBotConfig({ ...defaultBotConfig("crypto"), comboOn: true, comboAssets: ["BTC", "GOLD", "SILVER"], assets: ["BTC"], tradeAsset: "BTC", agreeCount: 0, probThreshold: 0.975, probMax: 0.985, comboWindowMin: 5, minRemainingSec: 15 });

describe("combo leg side", () => {
  it("picks the side inside the range, YES or NO", () => {
    expect(comboLegSide(cfg, 0.98)).toBe("yes");
    expect(comboLegSide(cfg, 0.02)).toBe("no"); // NO is 98%
    expect(comboLegSide(cfg, 0.9)).toBeNull();
    expect(comboLegSide(cfg, 0.999)).toBeNull();
  });
});

describe("combo entry", () => {
  const inWindow = CLOSE - 4 * 60_000; // 4 minutes left: inside the last 5
  it("waits until the last minutes of the contract start", () => {
    const now = CLOSE - 8 * 60_000;
    const { decision } = evaluateCombo(cfg, ["BTC", "GOLD", "SILVER"].map((a) => view(a, 0.98, 0.98, now)), now, undefined);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("waiting");
  });
  it("does not need every asset in range at the same moment", () => {
    let st = undefined as ReturnType<typeof evaluateCombo>["state"];
    let r = evaluateCombo(cfg, [view("BTC", 0.98, 0.98, inWindow), view("GOLD", 0.9, 0.9, inWindow), view("SILVER", 0.9, 0.9, inWindow)], inWindow, st);
    st = r.state;
    expect(r.decision.ok).toBe(false);
    expect(r.decision.reason).toContain("GOLD, SILVER");
    const t2 = inWindow + 60_000; // BTC has moved out of range, GOLD is in
    r = evaluateCombo(cfg, [view("BTC", 0.995, 0.995, t2), view("GOLD", 0.98, 0.98, t2), view("SILVER", 0.9, 0.9, t2)], t2, st);
    st = r.state;
    expect(r.decision.ok).toBe(false);
    const t3 = t2 + 60_000;
    r = evaluateCombo(cfg, [view("BTC", 0.995, 0.995, t3), view("GOLD", 0.995, 0.995, t3), view("SILVER", 0.02, 0.02, t3)], t3, st); // SILVER NO is 98%
    expect(r.decision.ok).toBe(true);
    expect(r.decision.legs!.map((l) => `${l.asset}:${l.side}`)).toEqual(["BTC:yes", "GOLD:yes", "SILVER:no"]);
  });
  it("forgets the sightings when a new contract starts", () => {
    let r = evaluateCombo(cfg, [view("BTC", 0.98, 0.98, inWindow), view("GOLD", 0.9, 0.9, inWindow), view("SILVER", 0.9, 0.9, inWindow)], inWindow, undefined);
    const next = CLOSE + 15 * 60_000 - 4 * 60_000;
    r = evaluateCombo(cfg, ["BTC", "GOLD", "SILVER"].map((a) => view(a, 0.9, 0.9, next, CLOSE + 15 * 60_000)), next, r.state);
    expect(r.state!.seen.size).toBe(0);
  });
  it("refuses assets whose contracts close at different times and stale prices", () => {
    const a = evaluateCombo(cfg, [view("BTC", 0.98, 0.98, inWindow), view("GOLD", 0.98, 0.98, inWindow, CLOSE + 60_000), view("SILVER", 0.98, 0.98, inWindow)], inWindow, undefined);
    expect(a.decision.code).toBe("close_times");
    const stale = evaluateCombo(cfg, ["BTC", "GOLD", "SILVER"].map((x) => view(x, 0.98, 0.98, inWindow - 120_000)), inWindow, undefined);
    expect(stale.decision.ok).toBe(false);
  });
  it("stops buying when too little time is left", () => {
    const now = CLOSE - 10_000;
    const r = evaluateCombo(cfg, ["BTC", "GOLD", "SILVER"].map((a) => view(a, 0.98, 0.98, now)), now, undefined);
    expect(r.decision.code).toBe("time_left");
  });
});

describe("combo quote choice", () => {
  it("takes the cheapest price at or under the limit, pricing both readings of a quote", () => {
    expect(pickComboQuote([{ id: "a", yesBid: 0.94, noBid: 0.04 }, { id: "b", yesBid: 0.93, noBid: 0.05 }], 0.96)).toEqual({ id: "b", cost: 0.95 });
    expect(pickComboQuote([{ id: "a", yesBid: 0.94, noBid: 0.02 }], 0.96)).toBeNull(); // 1 - 0.02 = 0.98 is over the limit
    expect(pickComboQuote([{ id: "a", yesBid: 0.9, noBid: 0 }], 0.96)).toBeNull(); // a side declined: cannot be sure of the price
  });
});

describe("combo settings", () => {
  it("are off by default and validated when on", () => {
    expect(defaultBotConfig("crypto").comboOn).toBe(false);
    expect(() => validateBotConfig({ ...cfg, comboAssets: ["BTC"] })).toThrow(/2 to 5/);
    expect(() => validateBotConfig({ ...cfg, betSide: "either", minEdge: 0.03 })).toThrow(/Either/);
    expect(() => validateBotConfig({ ...cfg, comboWindowMin: 15 })).toThrow(/between 1 and 14/);
    expect(() => validateBotConfig({ ...cfg, comboMaxCost: 1.2 })).toThrow(/between 50% and 100%/);
    expect(validateBotConfig({ ...cfg, comboAssets: ["btc", "gold"] }).comboAssets).toEqual(["BTC", "GOLD"]);
  });
});
