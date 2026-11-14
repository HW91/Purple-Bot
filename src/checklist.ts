/**
 * The "checks" list under the chart: every entry requirement checked on its own, using the latest prices.
 * Unlike evaluateEntry (which stops at the first failure), each line here is true or false right now.
 * Display only: it never decides a trade. The "risk" line is filled in by the engine when it tests the limits.
 */
import { dollars0, flowPasses, flowRatioText } from "./flow";
import { activeWindow, windowText } from "./windows";
import { bucketOf, minuteLeftOf, pooled, sideEdges, type EdgeLookup } from "./edge";
import { directionOf, favorableProb, QUOTE_MAX_AGE_MS, yesProb, type AssetView, type Direction } from "./strategy";
import type { BotConfig } from "./types";

/** ok: true = passes now, false = fails now, null = not checked. */
export interface CheckLine {
  key: string;
  ok: boolean | null;
  text: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** A dollar amount exactly as set ($0.10, $2.50, $5), never rounded to whole dollars. */
const amt = (x: number) => "$" + (Number.isInteger(x) ? String(x) : x.toFixed(2));

export function checklistFor(cfg: BotConfig, views: AssetView[], now: number, lookup?: EdgeLookup, extra?: { pivot?: string | null }): CheckLine[] {
  const fresh = views.filter((v) => v.market && v.quote && now - v.quote.ts <= QUOTE_MAX_AGE_MS && v.quote.yesBid > 0 && v.quote.yesAsk > 0 && v.quote.yesAsk >= v.quote.yesBid);
  const dirs = new Map<string, Direction | null>();
  let up = 0;
  let down = 0;
  for (const v of fresh) {
    const d = directionOf(yesProb(v.quote!));
    dirs.set(v.asset, d);
    if (d === "up") up++;
    else if (d === "down") down++;
  }
  const tv = fresh.find((v) => v.asset === cfg.tradeAsset);
  const out: CheckLine[] = [];
  const line = (key: string, ok: boolean | null, text: string) => out.push({ key, ok, text });

  // 0. no-trade windows (only shown when the bot has any)
  if (cfg.noTradeWindows.length) {
    const win = activeWindow(cfg.noTradeWindows, now);
    line("window", win === null, win ? `Inside a no-trade window: ${windowText(win)}` : "Outside your no-trade windows");
  }

  // 0b. daily pivot levels (only shown when the bot uses the check)
  if (cfg.pivotBandPct > 0 && extra && extra.pivot !== undefined) line("pivot", extra.pivot === null, extra.pivot ?? `Contract target is more than ${cfg.pivotBandPct}% away from every daily pivot level`);

  // 1. live prices
  const needed = [cfg.tradeAsset];
  const missing = needed.filter((a) => !fresh.some((v) => v.asset === a));
  line("prices", missing.length === 0, missing.length ? `No live price for ${missing.join(", ")}` : "Live prices available");

  // 2. direction agreement (only when the bot is set to check it; 0 = off, then the trade asset's own lean decides)
  let direction: Direction | null = null;
  if (cfg.agreeCount > 0) {
    let agreeText = "";
    if (up >= cfg.agreeCount && up >= down) direction = "up";
    else if (down >= cfg.agreeCount) direction = "down";
    else agreeText = `Only ${Math.max(up, down)} of ${cfg.assets.length} assets agree (need ${cfg.agreeCount})`;
    line("agree", direction !== null, direction ? `Assets agree on direction (${direction})` : agreeText);
  } else if (tv) {
    direction = dirs.get(tv.asset) ?? null;
  }

  // 3. the traded asset leans the same way (not needed when the bot may buy either side)
  if (cfg.betSide === "either") {
    /* the side comes from the edge below */
  } else if (cfg.agreeCount <= 0) {
    // agreement is off: the line just says which way the trade asset leans
    line("leans", tv ? direction !== null : null, tv ? (direction ? `${cfg.tradeAsset} leans ${direction}` : `${cfg.tradeAsset} has no clear lean (exactly 50%)`) : `${cfg.tradeAsset} has a clear lean`);
  } else if (!tv || !direction) {
    line("leans", null, `${cfg.tradeAsset} leans the same way as the others`);
  } else {
    const own = dirs.get(tv.asset);
    line("leans", own === direction, own === direction ? `${cfg.tradeAsset} leans ${direction} too` : `${cfg.tradeAsset} is not leaning ${direction}`);
  }

  const own = tv ? dirs.get(tv.asset) : null;
  const favored: "yes" | "no" | null = direction ? (direction === "up" ? "yes" : "no") : own === "up" ? "yes" : own === "down" ? "no" : null;
  const low = cfg.betSide === "underdog";
  const edgeOn = cfg.minEdge > 0;
  const restrictive = cfg.probThreshold > 0 || cfg.probMax < 1; // 0 to 100 means no limit, so those lines are left out
  // the side the bot would buy: high or low probability as chosen; with "Either" it is the side with the better edge
  let outcome: "yes" | "no" | null = favored && low ? (favored === "yes" ? "no" : "yes") : favored;
  let cell = { n: 0, yesWins: 0 };
  let sides: ReturnType<typeof sideEdges> | null = null;
  let minuteLeft = 0;
  if (tv && edgeOn) {
    const q0 = tv.quote!;
    const mid0 = yesProb(q0);
    minuteLeft = minuteLeftOf(tv.market!.closeTs, now);
    cell = lookup ? pooled(lookup, cfg.tradeAsset, minuteLeft, bucketOf(mid0)) : cell;
    sides = sideEdges(cell, q0.yesBid, q0.yesAsk);
    if (cfg.betSide === "either") {
      const okSide = (sd: "yes" | "no") => {
        const pr = favorableProb(sd, mid0);
        const c = sd === "yes" ? q0.yesAsk : 1 - q0.yesBid;
        return pr >= cfg.probThreshold && pr <= cfg.probMax + 1e-9 && c <= cfg.probMax + 1e-9;
      };
      const inside = (["yes", "no"] as const).filter(okSide);
      const pool: Array<"yes" | "no"> = inside.length ? [...inside] : ["yes", "no"];
      const se = sides;
      outcome = pool.reduce((x, y) => (se[x].edge >= se[y].edge ? x : y));
    }
  }
  if (!tv || !outcome) {
    const span = cfg.flowWindowMin > 0 ? `last ${cfg.flowWindowMin} min` : "whole contract";
    const names: Array<[string, string]> = [
      ...(low ? ([["side", "Buys the low-probability side (the opposite of where the market leans)"]] as Array<[string, string]>) : []),
      ...(cfg.betSide === "either" ? ([["side", "Buys whichever side has the better edge"]] as Array<[string, string]>) : []),
      ...(restrictive ? ([["probMin", `${low ? "Low-side probability" : "Probability"} at least ${pct(cfg.probThreshold)}`], ["probMax", `${low ? "Low-side probability and price paid" : "Probability and price paid"} at most ${pct(cfg.probMax)}`]] as Array<[string, string]>) : []),
      ...(edgeOn ? ([["history", `History behind the price: at least ${cfg.edgeMinSamples} contracts`], ["edge", `Edge at least ${(cfg.minEdge * 100).toFixed(1)} cents per contract after fees`]] as Array<[string, string]>) : []),
      ...(cfg.flowOn ? ([["flow", `Money on your side at least ${cfg.flowRatio}x the other side (${span})`]] as Array<[string, string]>) : []),
      ["delay", `Time Delay of ${cfg.timeDelaySec}s passed`],
      ["timeLeft", `At least ${cfg.minRemainingSec}s left in the contract`],
      ["spread", `Spread within ${pct(cfg.maxSpread)}`],
      ["price", "Price not too extreme"],
      ["size", `Trade amount ${amt(cfg.tradeAmount)} buys at least 1 contract`],
      ["liquidity", "Enough contracts available at the price"],
      ["risk", "Risk limits"],
    ];
    for (const [k, t] of names) line(k, null, t);
    return out;
  }

  const q = tv.quote!;
  const m = tv.market!;
  const OUT = outcome.toUpperCase();
  const p = favorableProb(outcome, yesProb(q));
  const cost = outcome === "yes" ? q.yesAsk : 1 - q.yesBid;

  if (low) line("side", null, `Buys the low-probability side: ${OUT} (the market leans ${favored === "yes" ? "YES" : "NO"})`);
  if (cfg.betSide === "either") line("side", null, `Buys the side with the better edge: ${OUT}`);
  if (restrictive) {
    const minOk = p >= cfg.probThreshold;
    line("probMin", minOk, minOk ? `${cfg.tradeAsset} ${OUT} probability ${pct(p)} meets your ${pct(cfg.probThreshold)} minimum` : `${cfg.tradeAsset} ${OUT} probability ${pct(p)} is below your ${pct(cfg.probThreshold)} minimum`);
    const maxOk = p <= cfg.probMax + 1e-9 && cost <= cfg.probMax + 1e-9;
    line("probMax", maxOk, maxOk ? `${cfg.tradeAsset} ${OUT} probability ${pct(p)} and price ${pct(cost)} are within your ${pct(cfg.probMax)} maximum` : p > cfg.probMax + 1e-9 ? `${cfg.tradeAsset} ${OUT} probability ${pct(p)} is above your ${pct(cfg.probMax)} maximum` : `Price paid ${pct(cost)} is above your ${pct(cfg.probMax)} maximum`);
  }
  if (edgeOn && sides) {
    const enough = cell.n >= cfg.edgeMinSamples;
    line("history", enough, `${cell.n} contracts priced near ${pct(yesProb(q))} with about ${minuteLeft} min left (need ${cfg.edgeMinSamples})`);
    const e = sides[outcome];
    if (!enough) {
      line("edge", null, `Edge at least ${(cfg.minEdge * 100).toFixed(1)} cents per contract after fees (needs more history first)`);
    } else {
      line("edge", e.edge >= cfg.minEdge, `${OUT}: wins ${pct(e.winRate)} (cautious ${pct(e.winRateLow)}) vs price ${pct(e.price)} plus fee ${pct(e.fee)} = ${(e.edge * 100).toFixed(1)} cents (need ${(cfg.minEdge * 100).toFixed(1)})`);
    }
  }

  if (cfg.flowOn) {
    const f = tv.flow;
    const span = cfg.flowWindowMin > 0 ? `last ${cfg.flowWindowMin} min` : "whole contract";
    if (!f) {
      line("flow", false, `Order flow: no trade data yet (${span})`);
    } else {
      const mine = outcome === "yes" ? f.yes : f.no;
      const other = outcome === "yes" ? f.no : f.yes;
      const fOk = flowPasses(mine, other, cfg.flowRatio);
      const nums = `${dollars0(mine)} on ${OUT} vs ${dollars0(other)} on ${outcome === "yes" ? "NO" : "YES"}, ${span}`;
      line("flow", fOk, fOk ? `Money on your side beats the other side: ${nums} (${flowRatioText(mine, other)}, need ${cfg.flowRatio}x)` : `Money on your side is too low: ${nums} (${flowRatioText(mine, other)}, need ${cfg.flowRatio}x)`);
    }
  }

  const elapsed = (now - m.openTs) / 1000;
  const remaining = (m.closeTs - now) / 1000;
  line("delay", elapsed >= cfg.timeDelaySec, elapsed >= cfg.timeDelaySec ? "Time Delay passed" : `Time Delay: ${Math.ceil(cfg.timeDelaySec - elapsed)}s left`);
  line("timeLeft", remaining >= cfg.minRemainingSec, remaining >= cfg.minRemainingSec ? `${Math.max(0, Math.floor(remaining))}s left in the contract` : `Only ${Math.max(0, Math.floor(remaining))}s left (need ${cfg.minRemainingSec}s)`);
  const spread = q.yesAsk - q.yesBid;
  const spreadOk = spread <= cfg.maxSpread + 1e-9;
  line("spread", spreadOk, spreadOk ? `Spread ${pct(spread)} is within your ${pct(cfg.maxSpread)} limit` : `Spread ${pct(spread)} is wider than your ${pct(cfg.maxSpread)} limit`);
  const priceOk = cost > 0.01 && cost < 0.99;
  line("price", priceOk, priceOk ? "Price not too extreme" : `Price ${cost.toFixed(2)} is too extreme to trade`);
  const wanted = priceOk ? Math.floor(cfg.tradeAmount / cost) : 0;
  line("size", wanted >= 1, wanted >= 1 ? `Trade amount ${amt(cfg.tradeAmount)} buys ${wanted} contract${wanted === 1 ? "" : "s"}` : `Trade amount ${amt(cfg.tradeAmount)} buys less than 1 contract`);
  const depth = Math.floor(outcome === "yes" ? q.yesAskSize : q.yesBidSize);
  line("liquidity", depth >= 1, depth >= 1 ? `${depth} contracts available at the price` : "No contracts available at the price");
  line("risk", null, "Risk limits");
  return out;
}
