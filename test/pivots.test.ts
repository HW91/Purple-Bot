import { describe, it, expect } from "vitest";
import { classicPivots, dailyPrices, pivotNear } from "../src/pivots";
import { etDateString } from "../src/analysis";
import { defaultBotConfig, validateBotConfig } from "../src/types";

describe("classic daily pivot points", () => {
  it("uses the standard formulas", () => {
    const lv = Object.fromEntries(classicPivots(110, 90, 100).map((l) => [l.name, l.value]));
    expect(lv.pivot).toBeCloseTo(100, 6);
    expect(lv.R1).toBeCloseTo(110, 6); // 2*100 - 90
    expect(lv.S1).toBeCloseTo(90, 6); // 2*100 - 110
    expect(lv.R2).toBeCloseTo(120, 6); // 100 + 20
    expect(lv.S2).toBeCloseTo(80, 6);
    expect(lv.R3).toBeCloseTo(130, 6); // 110 + 2*(100 - 90)
    expect(lv.S3).toBeCloseTo(70, 6); // 90 - 2*(110 - 100)
  });
});

describe("previous trading day from contracts", () => {
  const at = (iso: string, strike: number, final: number) => ({ close_time: iso, floor_strike: strike, expiration_value: String(final) });
  const day = (date: string, n: number, base: number) => Array.from({ length: n }, (_, i) => at(`${date}T${String(14 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00Z`, base + i, base + i + 0.5));

  it("takes the high, low and last final value of the latest earlier day with enough contracts", () => {
    const list = [...day("2026-11-12", 24, 100), ...day("2026-11-13", 24, 200), ...day("2026-11-14", 24, 300)];
    const p = dailyPrices(list, "2026-11-14", etDateString)!;
    expect(p.day).toBe("2026-11-13");
    expect(p.high).toBeCloseTo(223.5, 6);
    expect(p.low).toBe(200);
    expect(p.close).toBeCloseTo(223.5, 6);
    expect(p.samples).toBe(24);
  });
  it("skips a day with too few contracts (a weekend) and goes back to the last trading day", () => {
    const list = [...day("2026-11-12", 24, 100), ...day("2026-11-13", 3, 200)];
    expect(dailyPrices(list, "2026-11-14", etDateString)!.day).toBe("2026-11-12");
  });
  it("returns null when there is nothing usable", () => {
    expect(dailyPrices([], "2026-11-14", etDateString)).toBeNull();
    expect(dailyPrices(day("2026-11-14", 24, 100), "2026-11-14", etDateString)).toBeNull(); // today never counts
  });
});

describe("staying away from a level", () => {
  const levels = classicPivots(110, 90, 100);
  it("finds the nearest level inside the band and nothing outside it", () => {
    expect(pivotNear(100.05, levels, 0.1)!.level.name).toBe("pivot");
    expect(pivotNear(100.2, levels, 0.1)).toBeNull();
    expect(pivotNear(109.95, levels, 0.1)!.level.name).toBe("R1");
    expect(pivotNear(100.005, levels, 0.01)!.level.name).toBe("pivot"); // 0.01% works
  });
});

describe("pivot setting", () => {
  it("is off by default and limited to 0 to 5 percent", () => {
    expect(defaultBotConfig("crypto").pivotBandPct).toBe(0);
    expect(validateBotConfig({ pivotBandPct: 0.01 }).pivotBandPct).toBe(0.01);
    expect(() => validateBotConfig({ pivotBandPct: 6 })).toThrow(/0% \(off\) and 5%/);
    expect(() => validateBotConfig({ pivotBandPct: -1 })).toThrow();
  });
});
