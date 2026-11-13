import { MAX_WINDOWS, parseHHMM, type TimeWindow } from "./windows";

export interface Env {
  DB: D1Database;
  ENGINE: DurableObjectNamespace;
  /** Service binding to recruiter-coach-worker (the business coach). Email + AI. */
  COACH: Fetcher;
  KALSHI_BASE: string;
  KALSHI_WS: string;
  /** Secrets — see README. */
  DASHBOARD_PASSWORD: string;
  SESSION_SECRET: string;
  /** base64 of 32 random bytes; encrypts the Kalshi private key at rest */
  ENCRYPTION_KEY: string;
}

/** Smallest trade amount the bot accepts. It trades whole contracts, so an amount below the price of one contract simply buys nothing (the checklist says so). Kalshi itself publishes no minimum dollar amount. */
export const MIN_TRADE_AMOUNT = 0.01;

export type Strategy = "crypto" | "metals";
export type NotifyMode = "immediate" | "daily" | "off";
/** favorite = buy the high-probability side; underdog = buy the low-probability side; either = buy whichever side has the edge (needs a minimum edge). The probability range applies to the side being bought. */
export type BetSide = "favorite" | "underdog" | "either";

export interface BotConfig {
  strategy: Strategy;
  assets: string[]; // compared for direction agreement (confirmation only)
  tradeAsset: string; // the ONE asset this bot actually trades; must be one of `assets`
  durationMin: number;
  minEdge: number; // smallest edge (dollars per contract, after fees) worth buying, for example 0.03; 0 = the edge check is off
  edgeMinSamples: number; // contracts that must back the win rate before an edge is trusted
  betSide: BetSide;
  probThreshold: number; // 0..1, minimum probability to enter (of the side being bought)
  probMax: number; // 0..1, do NOT enter above this probability (1 = no upper limit)
  agreeCount: number; // crypto: how many selected assets must agree
  timeDelaySec: number; // from contract open
  minRemainingSec: number; // "sufficient time remains"
  tradeAmount: number; // dollars
  maxPositions: number;
  maxTradesPerHour: number;
  dailyLossLimit: number;
  dailyInvestLimit: number;
  stopLossOn: boolean;
  stopLoss: number; // dollars per position
  takeProfitOn: boolean;
  takeProfit: number; // dollars per position
  maxSpread: number; // liquidity check: max (ask - bid) in dollars
  /** Order flow: only enter when the money placed on our side is at least `flowRatio` times the money on the other side. */
  flowOn: boolean;
  flowWindowMin: number; // minutes of trades to add up (0 = the whole contract so far)
  flowRatio: number; // required (our side $) / (other side $), at least 1
  noTradeWindows: TimeWindow[]; // times of day (US Eastern) when no new trade is opened
  notify: NotifyMode;
  notifyEveryTrades: number; // send an email when the last this many finished trades were all wins, then again after this many new ones that all won (0 = off)
  comboOn: boolean; // buy ONE Kalshi combo of the comboAssets (pays only if every pick wins) instead of a single contract
  comboAssets: string[]; // the assets in the combo (two or more)
  comboWindowMin: number; // every combo asset must have been inside the probability range at some point in the last this many minutes of the contract
  comboMaxCost: number; // highest price per $1 of payout the bot will accept for the combo (0.96 = 96 cents)
}

export interface Bot {
  id: string;
  name: string;
  strategy: Strategy;
  config: BotConfig;
  enabled: boolean;
}

export interface AccountLimits {
  dailyLossLimit: number;
  dailyInvestLimit: number;
  maxPositions: number;
}

export interface MarketInfo {
  ticker: string;
  asset: string;
  series: string;
  title: string;
  openTs: number;
  closeTs: number;
  status: string;
}

/** Latest top-of-book for a market, from the Kalshi ticker channel. */
export interface Quote {
  ticker: string;
  yesBid: number;
  yesAsk: number;
  yesBidSize: number;
  yesAskSize: number;
  last: number;
  ts: number;
}

// Every crypto that has a 15-minute contract on Kalshi (confirmed from Kalshi's series list).
export const CRYPTO_ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ADA", "BCH", "NEAR", "TON", "ZEC"] as const;
/** The nine selected by default for a new crypto bot. */
export const DEFAULT_CRYPTO_ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "ADA", "BCH"] as const;
export const METAL_ASSETS = ["GOLD", "SILVER", "PLATINUM", "PALLADIUM", "COPPER"] as const;

export const DEFAULT_ACCOUNT_LIMITS: AccountLimits = {
  dailyLossLimit: 40,
  dailyInvestLimit: 100,
  maxPositions: 3,
};

export function defaultBotConfig(strategy: Strategy): BotConfig {
  return {
    strategy,
    assets: strategy === "crypto" ? [...DEFAULT_CRYPTO_ASSETS] : ["GOLD", "SILVER"],
    tradeAsset: strategy === "crypto" ? "BTC" : "GOLD",
    durationMin: 15,
    minEdge: 0,
    edgeMinSamples: 300,
    betSide: "favorite",
    probThreshold: 0.8,
    probMax: 1,
    agreeCount: strategy === "crypto" ? 7 : 2,
    timeDelaySec: 300,
    minRemainingSec: 120,
    tradeAmount: 5,
    maxPositions: 1,
    maxTradesPerHour: 4,
    dailyLossLimit: 20,
    dailyInvestLimit: 50,
    stopLossOn: false, // no stop loss unless you turn one on and choose the amount
    stopLoss: 0,
    takeProfitOn: true,
    takeProfit: 1.0,
    maxSpread: 0.06,
    flowOn: false,
    flowWindowMin: 3,
    flowRatio: 1.5,
    noTradeWindows: [],
    notify: "immediate",
    notifyEveryTrades: 0,
    comboOn: false,
    comboAssets: [],
    comboWindowMin: 5,
    comboMaxCost: 0.96,
  };
}

/**
 * Validate + normalise a bot config coming from the dashboard. Throws a plain
 * message string-error on anything unsafe so a typo can never become a trade.
 */
export function validateBotConfig(input: Partial<BotConfig>): BotConfig {
  // "strategy" only picks the starting values (crypto or metals defaults); every bot can trade and check any asset, and which label it keeps follows its trade asset
  const startFrom: Strategy = input.strategy === "metals" ? "metals" : "crypto";
  const d = defaultBotConfig(startFrom);
  const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const universe: readonly string[] = [...CRYPTO_ASSETS, ...METAL_ASSETS];
  const assets = (Array.isArray(input.assets) ? input.assets : d.assets).map((a) => String(a).toUpperCase());
  for (const a of assets) if (!universe.includes(a)) throw new Error(`Asset ${a} is not a tradable asset`);
  const uniq = [...new Set(assets)];
  if (uniq.length === 0) throw new Error("Select at least one asset");
  const tradeAsset = String(input.tradeAsset ?? (startFrom === "metals" ? "GOLD" : uniq.includes("BTC") ? "BTC" : uniq[0])).toUpperCase();
  const strategy: Strategy = (METAL_ASSETS as readonly string[]).includes(tradeAsset) ? "metals" : "crypto";
  if (!uniq.includes(tradeAsset)) throw new Error(`The asset to trade (${tradeAsset}) must also be one of the selected assets`);

  // bots saved before the two entry rules were merged: "edge" becomes a minimum edge with either side and no other filters; "range" has no edge check
  const saved = (input as { entryRule?: string }).entryRule;
  const legacyEdge = saved === "edge";
  const minEdge = saved === "range" ? 0 : num(input.minEdge, legacyEdge ? 0.03 : 0);
  const betSide: BetSide = legacyEdge ? "either" : input.betSide === "underdog" ? "underdog" : input.betSide === "either" ? "either" : "favorite";
  // a low-probability bot starts from a low range (3% to 7%) unless one is given
  // the edge rule starts from smaller, tighter values (small trades, tight spread, hold to settlement) unless the owner gives their own
  const ed = minEdge > 0 ? { timeDelaySec: 60, tradeAmount: 1, dailyLossLimit: 3, dailyInvestLimit: 20, maxSpread: 0.03, takeProfitOn: false } : { timeDelaySec: d.timeDelaySec, tradeAmount: d.tradeAmount, dailyLossLimit: d.dailyLossLimit, dailyInvestLimit: d.dailyInvestLimit, maxSpread: d.maxSpread, takeProfitOn: d.takeProfitOn };
  const lowDefaults = betSide === "underdog" ? { probThreshold: 0.03, probMax: 0.07 } : { probThreshold: d.probThreshold, probMax: d.probMax };
  const cfg: BotConfig = {
    strategy,
    assets: uniq,
    tradeAsset,
    durationMin: Math.max(1, Math.round(num(input.durationMin, d.durationMin))),
    minEdge,
    edgeMinSamples: Math.round(num(input.edgeMinSamples, d.edgeMinSamples)),
    betSide,
    probThreshold: legacyEdge ? 0 : num(input.probThreshold, lowDefaults.probThreshold),
    probMax: legacyEdge ? 1 : num(input.probMax, lowDefaults.probMax),
    agreeCount: legacyEdge ? 0 : Math.round(num(input.agreeCount, d.agreeCount)),
    timeDelaySec: Math.round(num(input.timeDelaySec, ed.timeDelaySec)),
    minRemainingSec: Math.round(num(input.minRemainingSec, d.minRemainingSec)),
    tradeAmount: num(input.tradeAmount, ed.tradeAmount),
    maxPositions: Math.round(num(input.maxPositions, d.maxPositions)),
    maxTradesPerHour: Math.round(num(input.maxTradesPerHour, d.maxTradesPerHour)),
    dailyLossLimit: num(input.dailyLossLimit, ed.dailyLossLimit),
    dailyInvestLimit: num(input.dailyInvestLimit, ed.dailyInvestLimit),
    stopLossOn: bool(input.stopLossOn, d.stopLossOn),
    stopLoss: num(input.stopLoss, d.stopLoss),
    takeProfitOn: bool(input.takeProfitOn, ed.takeProfitOn),
    takeProfit: num(input.takeProfit, d.takeProfit),
    maxSpread: num(input.maxSpread, ed.maxSpread),
    flowOn: legacyEdge ? false : bool(input.flowOn, d.flowOn),
    flowWindowMin: Math.round(num(input.flowWindowMin, d.flowWindowMin)),
    flowRatio: num(input.flowRatio, d.flowRatio),
    noTradeWindows: (Array.isArray(input.noTradeWindows) ? input.noTradeWindows : d.noTradeWindows).map((w) => ({ start: String(w?.start ?? ""), end: String(w?.end ?? "") })),
    // the old "hourly" choice no longer exists (the AI overview is daily now), so saved hourly bots become daily
    notify: (input.notify as string) === "hourly" ? "daily" : (["immediate", "daily", "off"] as const).includes(input.notify as NotifyMode) ? (input.notify as NotifyMode) : d.notify,
    notifyEveryTrades: Math.round(num(input.notifyEveryTrades, d.notifyEveryTrades)),
    comboOn: bool(input.comboOn, d.comboOn),
    comboAssets: [...new Set((Array.isArray(input.comboAssets) ? input.comboAssets : d.comboAssets).map((a) => String(a).toUpperCase()))],
    comboWindowMin: Math.round(num(input.comboWindowMin, d.comboWindowMin)),
    comboMaxCost: num(input.comboMaxCost, d.comboMaxCost),
  };
  for (const a of cfg.comboAssets) if (!universe.includes(a)) throw new Error(`Combo asset ${a} is not a tradable asset`);
  if (cfg.comboOn) {
    if (cfg.comboAssets.length < 2 || cfg.comboAssets.length > 5) throw new Error("A combo needs 2 to 5 assets ticked");
    if (cfg.betSide === "either") throw new Error("A combo needs the side to bet set to High probability or Low probability, not Either");
    if (cfg.minEdge > 0) throw new Error("A combo does not use the minimum edge: set it to 0");
    if (!(cfg.comboWindowMin >= 1 && cfg.comboWindowMin < cfg.durationMin)) throw new Error(`Combo minutes must be between 1 and ${cfg.durationMin - 1}`);
    if (!(cfg.comboMaxCost > 0.5 && cfg.comboMaxCost < 1)) throw new Error("Highest combo cost must be between 50% and 100%");
  }
  if (!(cfg.notifyEveryTrades >= 0 && cfg.notifyEveryTrades <= 1000)) throw new Error("Notify after this many trades must be a whole number from 0 (off) to 1000");
  // older metals bots (and new ones that give no number) keep "every checked asset must agree"; 0 means do not check agreement at all
  if (startFrom === "metals" && input.agreeCount === undefined) cfg.agreeCount = cfg.assets.length;
  if (!(cfg.minEdge >= 0 && cfg.minEdge <= 0.5)) throw new Error("Minimum edge must be between $0.00 and $0.50 per contract (0 turns the edge check off)");
  if (cfg.minEdge > 0 && !(cfg.edgeMinSamples >= 20 && cfg.edgeMinSamples <= 100000)) throw new Error("Contracts needed behind a win rate must be at least 20");
  if (cfg.betSide === "either" && !(cfg.minEdge > 0)) throw new Error("Side to bet 'Either' needs a minimum edge above 0, so the bot knows which side to buy");
  // 0% to 100% means no limit; the side being bought is either the high or the low probability side, so any range inside 0% to 100% is allowed
  if (!(cfg.probThreshold >= 0 && cfg.probThreshold < cfg.probMax && cfg.probMax <= 1)) throw new Error("Probability range must run from 0% or more up to 100% or less, with the first number below the second");
  if (cfg.timeDelaySec < 0 || cfg.timeDelaySec > (cfg.durationMin - 1) * 60) {
    throw new Error(`Time Delay must be between 0 and ${cfg.durationMin - 1} minutes for ${cfg.durationMin}-minute contracts`);
  }
  if (cfg.agreeCount < 0 || cfg.agreeCount > cfg.assets.length) {
    throw new Error(`Assets that must agree must be between 0 (do not check) and the number of selected assets (${cfg.assets.length})`);
  }
  if (cfg.minRemainingSec < 0 || cfg.minRemainingSec >= cfg.durationMin * 60) throw new Error("Minimum remaining time is out of range");
  if (cfg.tradeAmount < MIN_TRADE_AMOUNT) {
    throw new Error(`Trade amount must be at least $${MIN_TRADE_AMOUNT}`);
  }
  for (const [k, v] of [
    ["Trade amount", cfg.tradeAmount],
    ["Max simultaneous positions", cfg.maxPositions],
    ["Max trades per hour", cfg.maxTradesPerHour],
    ["Daily loss limit", cfg.dailyLossLimit],
    ["Daily investment limit", cfg.dailyInvestLimit],
  ] as const) {
    if (!(v > 0)) throw new Error(`${k} must be greater than zero`);
  }
  if (cfg.stopLossOn && !(cfg.stopLoss > 0)) throw new Error("Stop loss must be greater than zero");
  if (cfg.takeProfitOn && !(cfg.takeProfit > 0)) throw new Error("Take profit must be greater than zero");
  if (!(cfg.maxSpread > 0 && cfg.maxSpread < 1)) throw new Error("Max spread must be between $0 and $1");
  if (cfg.flowWindowMin < 0 || cfg.flowWindowMin > cfg.durationMin) throw new Error(`Order flow time frame must be between 0 (whole contract) and ${cfg.durationMin} minutes`);
  if (cfg.noTradeWindows.length > MAX_WINDOWS) throw new Error(`At most ${MAX_WINDOWS} no-trade windows`);
  for (const w of cfg.noTradeWindows) {
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    if (s === null || e === null) throw new Error("Each no-trade window needs a start and an end time");
    if (s === e) throw new Error("A no-trade window's start and end times must be different");
  }
  if (!(cfg.flowRatio >= 1 && cfg.flowRatio <= 1000)) throw new Error("Order flow ratio must be at least 1 (for example 1.5 means your side needs 1.5 times the other side's money)");
  return cfg;
}
