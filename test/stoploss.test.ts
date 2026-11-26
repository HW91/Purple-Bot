import { describe, it, expect } from "vitest";
import { evaluateExitTimed } from "../src/strategy";
import { validateBotConfig } from "../src/types";

const base = { stopLossOn: true, stopLoss: 2.5, takeProfitOn: true, takeProfit: 1, stopLossNotLastSec: 0, stopLossHoldSec: 0 };
const pos = { outcome: "yes" as const, openQty: 10, avgEntry: 0.95, entryFee: 0.1 };
const down = { yesBid: 0.5, yesAsk: 0.52 }; // (0.5 - 0.95) * 10 - 0.1 = -4.6
const fine = { yesBid: 0.95, yesAsk: 0.96 };
const T0 = 1_000_000;

describe("stop loss protections", () => {
  it("without them the stop sells at once, as before", () => {
    expect(evaluateExitTimed(base, pos, down, { now: T0, closeTs: T0 + 600_000, breachSince: null }).reason).toBe("stop_loss");
  });
  it("never sells in the last N seconds of the contract", () => {
    const cfg = { ...base, stopLossNotLastSec: 60 };
    expect(evaluateExitTimed(cfg, pos, down, { now: T0, closeTs: T0 + 30_000, breachSince: null }).reason).toBeNull();
    expect(evaluateExitTimed(cfg, pos, down, { now: T0, closeTs: T0 + 120_000, breachSince: null }).reason).toBe("stop_loss");
  });
  it("sells only after the loss has lasted N seconds, and a recovery starts the wait over", () => {
    const cfg = { ...base, stopLossHoldSec: 5 };
    const ctx = (now: number, since: number | null) => ({ now, closeTs: T0 + 600_000, breachSince: since });
    const first = evaluateExitTimed(cfg, pos, down, ctx(T0, null));
    expect(first).toEqual({ reason: null, breachSince: T0 });
    expect(evaluateExitTimed(cfg, pos, down, ctx(T0 + 3_000, first.breachSince)).reason).toBeNull();
    expect(evaluateExitTimed(cfg, pos, down, ctx(T0 + 5_000, first.breachSince)).reason).toBe("stop_loss");
    const recovered = evaluateExitTimed(cfg, pos, fine, ctx(T0 + 4_000, first.breachSince));
    expect(recovered.breachSince).toBeNull(); // the loss ended: the wait is forgotten
    const again = evaluateExitTimed(cfg, pos, down, ctx(T0 + 6_000, recovered.breachSince));
    expect(again).toEqual({ reason: null, breachSince: T0 + 6_000 });
  });
  it("take profit still works while the stop loss is held back", () => {
    const cfg = { ...base, stopLossHoldSec: 5, stopLossNotLastSec: 60 };
    expect(evaluateExitTimed(cfg, { ...pos, avgEntry: 0.8 }, { yesBid: 0.95, yesAsk: 0.96 }, { now: T0, closeTs: T0 + 30_000, breachSince: null }).reason).toBe("take_profit");
  });
  it("settings are off by default and limited", () => {
    expect(validateBotConfig({}).stopLossNotLastSec).toBe(0);
    expect(validateBotConfig({}).stopLossHoldSec).toBe(0);
    expect(() => validateBotConfig({ stopLossNotLastSec: 301 })).toThrow(/0 to 300/);
    expect(() => validateBotConfig({ stopLossHoldSec: 61 })).toThrow(/0 to 60/);
  });
});

import { moneyReversal } from "../src/flow";

describe("stop loss only when the money reverses", () => {
  const before3 = { yes: 270_000, no: 30_000 }; // three minutes averaging $100,000 in total
  it("a reversal needs the opposing money to reach the set percent of the recent average", () => {
    expect(moneyReversal({ yes: 5_000, no: 49_000 }, before3, 3, "yes", 50).active).toBe(false);
    expect(moneyReversal({ yes: 5_000, no: 50_000 }, before3, 3, "yes", 50).active).toBe(true);
  });
  it("small orders do not count: $1,000 on NO against $100 on YES is not a reversal when minutes usually carry $100,000", () => {
    expect(moneyReversal({ yes: 100, no: 1_000 }, before3, 3, "yes", 50).active).toBe(false);
  });
  it("works for a NO trade: the opposing money is the YES money", () => {
    expect(moneyReversal({ yes: 60_000, no: 1_000 }, before3, 3, "no", 50).active).toBe(true);
    expect(moneyReversal({ yes: 20_000, no: 1_000 }, before3, 3, "no", 50).active).toBe(false);
  });
  it("with no money in the earlier minutes there is nothing to compare with, so the normal stop loss applies", () => {
    const r = moneyReversal({ yes: 0, no: 100 }, { yes: 0, no: 0 }, 3, "yes", 50);
    expect(r.known).toBe(false);
    expect(r.active).toBe(true);
  });
  it("the contract you showed: previous minutes of $28.8k, $32.8k and $25.5k and only $9,987 on NO in the last minute is not a reversal at 50%", () => {
    const r = moneyReversal({ yes: 84_385, no: 9_987 }, { yes: 27_236 + 31_887 + 24_745, no: 1_538 + 927 + 730 }, 3, "yes", 50);
    expect(r.active).toBe(false);
    expect(Math.round(r.avgTotal)).toBe(29_021);
    expect(Math.round(r.needed)).toBe(14_511);
  });
  it("settings are off by default and limited", () => {
    expect(validateBotConfig({}).stopLossMoneyFilter).toBe(false);
    expect(validateBotConfig({}).stopLossMoneyPct).toBe(50);
    expect(validateBotConfig({}).stopLossMoneyMinutes).toBe(3);
    expect(() => validateBotConfig({ stopLossMoneyPct: 0 })).toThrow(/above 0/);
    expect(() => validateBotConfig({ stopLossMoneyMinutes: 11 })).toThrow(/1 to 10/);
  });
});
