/**
 * Combo entry rule (pure, no network): a combo pays only if EVERY asset's pick wins. The bot watches the last `comboWindowMin` minutes of the
 * contract and remembers each asset the first time it is inside the probability range (and which side was in range). The assets do not have to
 * be in range at the same moment. Once every ticked asset has been seen in range, the combo can be bought.
 */
import { favorableProb, QUOTE_MAX_AGE_MS, yesProb, type AssetView } from "./strategy";
import { activeWindow, windowText } from "./windows";
import type { BotConfig } from "./types";

export interface ComboLeg {
  asset: string;
  ticker: string;
  side: "yes" | "no";
  prob: number; // probability of the side picked, when it was first seen in range
}

export interface ComboState {
  closeTs: number; // the contract these sightings belong to
  seen: Map<string, ComboLeg>;
}

export interface ComboDecision {
  ok: boolean;
  code: "ok" | "window" | "no_data" | "close_times" | "waiting" | "time_left";
  reason: string;
  legs?: ComboLeg[];
  closeTs?: number;
}

/** The side of one asset the combo would pick, or null when that side is outside the probability range. */
export function comboLegSide(cfg: Pick<BotConfig, "betSide" | "probThreshold" | "probMax">, yes: number): "yes" | "no" | null {
  const side: "yes" | "no" = cfg.betSide === "underdog" ? (yes < 0.5 ? "yes" : "no") : yes >= 0.5 ? "yes" : "no";
  const p = favorableProb(side, yes);
  return p >= cfg.probThreshold && p <= cfg.probMax + 1e-9 ? side : null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** `views` are the combo assets only. Returns the updated memory (keep it for the next call) and the decision. */
export function evaluateCombo(cfg: BotConfig, views: AssetView[], now: number, prev: ComboState | undefined): { state: ComboState | undefined; decision: ComboDecision } {
  const win = activeWindow(cfg.noTradeWindows, now);
  if (win) return { state: prev, decision: { ok: false, code: "window", reason: `No-trade window: ${windowText(win)}` } };
  const withMarket = views.filter((v) => v.market);
  if (withMarket.length < cfg.comboAssets.length) {
    const missing = cfg.comboAssets.filter((a) => !withMarket.some((v) => v.asset === a));
    return { state: prev, decision: { ok: false, code: "no_data", reason: `No open contract yet for ${missing.join(", ")}` } };
  }
  const closes = new Set(withMarket.map((v) => v.market!.closeTs));
  if (closes.size !== 1) return { state: prev, decision: { ok: false, code: "close_times", reason: "The combo assets' contracts do not close at the same time, so they cannot be combined" } };
  const closeTs = [...closes][0];
  const state: ComboState = prev && prev.closeTs === closeTs ? prev : { closeTs, seen: new Map() };

  const windowStart = closeTs - cfg.comboWindowMin * 60_000;
  if (now < windowStart) return { state, decision: { ok: false, code: "waiting", reason: `The combo watches the last ${cfg.comboWindowMin} minutes of the contract, which start in ${Math.ceil((windowStart - now) / 1000)} seconds` } };
  if (now >= closeTs - cfg.minRemainingSec * 1000) return { state, decision: { ok: false, code: "time_left", reason: "Too little time is left in the contract to buy the combo" } };

  for (const v of withMarket) {
    if (state.seen.has(v.asset)) continue;
    const q = v.quote;
    if (!q || now - q.ts > QUOTE_MAX_AGE_MS || !(q.yesBid > 0 && q.yesAsk > 0 && q.yesAsk >= q.yesBid)) continue;
    const yes = yesProb(q);
    const side = comboLegSide(cfg, yes);
    if (side) state.seen.set(v.asset, { asset: v.asset, ticker: v.market!.ticker, side, prob: favorableProb(side, yes) });
  }
  const notYet = cfg.comboAssets.filter((a) => !state.seen.has(a));
  if (notYet.length) {
    const have = cfg.comboAssets.filter((a) => state.seen.has(a));
    return { state, decision: { ok: false, code: "waiting", reason: `Waiting for ${notYet.join(", ")} to be inside ${pct(cfg.probThreshold)} to ${pct(cfg.probMax)}${have.length ? ` (already seen in range: ${have.join(", ")})` : ""}` } };
  }
  const legs = cfg.comboAssets.map((a) => state.seen.get(a)!);
  return { state, decision: { ok: true, code: "ok", reason: `Every combo asset was inside ${pct(cfg.probThreshold)} to ${pct(cfg.probMax)} in the last ${cfg.comboWindowMin} minutes: ${legs.map((l) => `${l.asset} ${l.side.toUpperCase()} ${pct(l.prob)}`).join(", ")}`, legs, closeTs } };
}

/**
 * Pick the cheapest acceptable quote. What the buyer pays for the combo's YES is not spelled out in Kalshi's documentation, so BOTH readings of a quote
 * are priced (the "yes bid" itself, and one minus the "no bid") and the dearer one must still be at or under the highest cost the owner allows.
 */
export function pickComboQuote(quotes: Array<{ id: string; yesBid: number; noBid: number }>, maxCost: number): { id: string; cost: number } | null {
  let best: { id: string; cost: number } | null = null;
  for (const q of quotes) {
    if (!(q.yesBid > 0) || !(q.noBid > 0)) continue; // both prices are needed to be sure what the trade costs
    const cost = Math.max(q.yesBid, 1 - q.noBid);
    if (cost > maxCost + 1e-9) continue;
    if (!best || cost < best.cost) best = { id: q.id, cost };
  }
  return best;
}
