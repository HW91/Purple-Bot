import { describe, it, expect } from "vitest";
import { normCdf, probAbove, realizedSigma } from "../src/model";

describe("normal distribution", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249979, 5);
    expect(normCdf(3)).toBeCloseTo(0.99865, 5);
  });
});

describe("movement measured from ticks", () => {
  const make = (n: number, step: number, now: number) => Array.from({ length: n }, (_, i) => [now - (n - i) * 1000, 100 * (1 + (i % 2 ? step : -step))] as [number, number]);
  it("is null with too few ticks and positive with enough", () => {
    const now = 1_000_000_000;
    expect(realizedSigma(make(20, 0.0005, now), now)).toBeNull();
    const s = realizedSigma(make(300, 0.0005, now), now)!;
    expect(s).toBeGreaterThan(0.0005);
    expect(s).toBeLessThan(0.0015);
  });
  it("uses the larger of the long and short windows so a burst is not averaged away", () => {
    const now = 1_000_000_000;
    const calm = make(480, 0.0001, now - 120_000);
    const burst = make(120, 0.002, now);
    const s = realizedSigma([...calm, ...burst], now)!;
    expect(s).toBeGreaterThan(0.002);
  });
});

describe("chance of finishing above the target", () => {
  it("is 50% when the price sits on the target, and rises with distance", () => {
    const base = { target: 100, secsLeft: 300, sigmaRel: 0.0003 };
    expect(probAbove({ ...base, price: 100 })).toBeCloseTo(0.5, 6);
    const near = probAbove({ ...base, price: 100.1 });
    const far = probAbove({ ...base, price: 100.4 });
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0.5);
    expect(probAbove({ ...base, price: 99.6 })).toBeLessThan(0.5);
  });
  it("is more certain with less time left", () => {
    const a = probAbove({ price: 100.2, target: 100, secsLeft: 600, sigmaRel: 0.0003 });
    const b = probAbove({ price: 100.2, target: 100, secsLeft: 90, sigmaRel: 0.0003 });
    expect(b).toBeGreaterThan(a);
  });
  it("uses the known part of the final minute", () => {
    const base = { price: 100, target: 100, secsLeft: 20, sigmaRel: 0.0003 };
    expect(probAbove({ ...base, avgSoFar: 100.5 })).toBeGreaterThan(0.99); // the first 40 seconds averaged well above the target
    expect(probAbove({ ...base, avgSoFar: 99.5 })).toBeLessThan(0.01);
  });
  it("handles the end of the contract", () => {
    expect(probAbove({ price: 101, target: 100, secsLeft: 0, sigmaRel: 0.0003 })).toBe(1);
    expect(probAbove({ price: 99, target: 100, secsLeft: 0, sigmaRel: 0.0003 })).toBe(0);
  });
});
