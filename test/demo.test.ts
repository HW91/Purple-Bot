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

import { edgeIsGone } from "../src/model";

describe("several trades in one contract, and the edge-gone exit", () => {
  it("has safe defaults and limits", () => {
    const d = defaultBotConfig("crypto");
    expect(d.entriesPerContract).toBe(1);
    expect(d.entryCooldownSec).toBe(30);
    expect(d.exitOnEdgeGone).toBe(true);
    expect(validateBotConfig({ entriesPerContract: 3 }).entriesPerContract).toBe(3);
    expect(() => validateBotConfig({ entriesPerContract: 0 })).toThrow(/1 to 10/);
    expect(() => validateBotConfig({ entriesPerContract: 11 })).toThrow(/1 to 10/);
    expect(() => validateBotConfig({ entryCooldownSec: -1 })).toThrow(/0 to 600/);
  });
  it("the edge is gone when the estimate is no longer above the price the trade could be sold at", () => {
    // a YES trade: sold at the YES bid
    expect(edgeIsGone("yes", 0.97, 0.9, 0.92)).toBe(false); // estimate 97% against a 90-cent bid: still worth holding
    expect(edgeIsGone("yes", 0.97, 0.97, 0.99)).toBe(true); // the bid has caught up with the estimate
    expect(edgeIsGone("yes", 0.9, 0.95, 0.96)).toBe(true); // the estimate fell below the bid
    // a NO trade: sold at one minus the YES ask; the estimate of NO winning is one minus the YES estimate
    expect(edgeIsGone("no", 0.03, 0.05, 0.1)).toBe(false); // NO wins 97%, could sell NO at 90 cents
    expect(edgeIsGone("no", 0.03, 0.01, 0.02)).toBe(true); // NO sells at 98 cents, above the 97% estimate
  });
});

import { fundsHelpHtml } from "../src/notify";

describe("insufficient balance email", () => {
  it("adds the transfer instructions only for a balance error", () => {
    const text = fundsHelpHtml('Kalshi POST /portfolio/events/orders failed (400): {"error":{"code":"insufficient_balance","message":"insufficient balance"}}');
    expect(text).toContain("Exchange 2");
    expect(text).toContain("kalshi.com/account/exchange-indexes");
    expect(text).toContain("Disable balance management");
    expect(fundsHelpHtml("insufficient_shard_balance")).not.toBe("");
    expect(fundsHelpHtml("Kalshi order failed (400): bad price")).toBe("");
  });
});
