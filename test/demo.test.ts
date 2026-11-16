import { describe, it, expect } from "vitest";
import { defaultBotConfig, validateBotConfig } from "../src/types";
import { feePerContract } from "../src/edge";

describe("demo setting", () => {
  it("is off by default, saved when on, and refused for combos", () => {
    expect(defaultBotConfig("crypto").demo).toBe(false);
    expect(validateBotConfig({}).demo).toBe(false);
    expect(validateBotConfig({ demo: true }).demo).toBe(true);
    expect(() => validateBotConfig({ demo: true, comboOn: true, comboAssets: ["BTC", "ETH"], assets: ["BTC"], tradeAsset: "BTC" })).toThrow(/Demo mode does not support combos/);
  });
  it("a demo fill uses Kalshi's fee formula on the price paid", () => {
    // 5 contracts at 98 cents: 0.07 * 0.98 * 0.02 each
    expect(feePerContract(0.98) * 5).toBeCloseTo(0.00686, 6);
  });
});
