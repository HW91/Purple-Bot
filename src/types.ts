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

/** Smallest trade amount the bot accepts. It trades whole contracts (one costs up to $0.99 + fees). Kalshi itself publishes no minimum dollar amount. */
export const MIN_TRADE_AMOUNT = 1;

export type Strategy = "crypto" | "metals";
export type NotifyMode = "immediate" | "hourly" | "daily" | "off";

export interface BotConfig {
  strategy: Strategy;
  assets: string[];
  durationMin: number;
  probThreshold: number; // 0..1
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
  notify: NotifyMode;
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
    durationMin: 15,
    probThreshold: 0.8,
    agreeCount: strategy === "crypto" ? 7 : 2,
    timeDelaySec: 300,
    minRemainingSec: 120,
    tradeAmount: 5,
    maxPositions: 1,
    maxTradesPerHour: 4,
    dailyLossLimit: 20,
    dailyInvestLimit: 50,
    stopLossOn: true,
    stopLoss: 2.5,
    takeProfitOn: true,
    takeProfit: 1.0,
    maxSpread: 0.06,
    notify: "immediate",
  };
}

/**
 * Validate + normalise a bot config coming from the dashboard. Throws a plain
 * message string-error on anything unsafe so a typo can never become a trade.
 */
export function validateBotConfig(input: Partial<BotConfig>): BotConfig {
  const strategy: Strategy = input.strategy === "metals" ? "metals" : "crypto";
  const d = defaultBotConfig(strategy);
  const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const universe: readonly string[] = strategy === "crypto" ? CRYPTO_ASSETS : METAL_ASSETS;
  const assets = (Array.isArray(input.assets) ? input.assets : d.assets).map((a) => String(a).toUpperCase());
  for (const a of assets) if (!universe.includes(a)) throw new Error(`Asset ${a} is not valid for the ${strategy} strategy`);
  const uniq = [...new Set(assets)];
  if (strategy === "metals" && !(uniq.includes("GOLD") && uniq.includes("SILVER"))) {
    throw new Error("The metals strategy always needs both GOLD and SILVER selected");
  }
  if (uniq.length === 0) throw new Error("Select at least one asset");

  const cfg: BotConfig = {
    strategy,
    assets: uniq,
    durationMin: Math.max(1, Math.round(num(input.durationMin, d.durationMin))),
    probThreshold: num(input.probThreshold, d.probThreshold),
    agreeCount: Math.round(num(input.agreeCount, d.agreeCount)),
    timeDelaySec: Math.round(num(input.timeDelaySec, d.timeDelaySec)),
    minRemainingSec: Math.round(num(input.minRemainingSec, d.minRemainingSec)),
    tradeAmount: num(input.tradeAmount, d.tradeAmount),
    maxPositions: Math.round(num(input.maxPositions, d.maxPositions)),
    maxTradesPerHour: Math.round(num(input.maxTradesPerHour, d.maxTradesPerHour)),
    dailyLossLimit: num(input.dailyLossLimit, d.dailyLossLimit),
    dailyInvestLimit: num(input.dailyInvestLimit, d.dailyInvestLimit),
    stopLossOn: bool(input.stopLossOn, d.stopLossOn),
    stopLoss: num(input.stopLoss, d.stopLoss),
    takeProfitOn: bool(input.takeProfitOn, d.takeProfitOn),
    takeProfit: num(input.takeProfit, d.takeProfit),
    maxSpread: num(input.maxSpread, d.maxSpread),
    notify: (["immediate", "hourly", "daily", "off"] as const).includes(input.notify as NotifyMode)
      ? (input.notify as NotifyMode)
      : d.notify,
  };
  if (strategy === "metals") cfg.agreeCount = 2; // gold + silver, fixed
  if (!(cfg.probThreshold > 0.5 && cfg.probThreshold < 1)) throw new Error("Probability threshold must be between 50% and 100%");
  if (cfg.timeDelaySec < 0 || cfg.timeDelaySec > (cfg.durationMin - 1) * 60) {
    throw new Error(`Time Delay must be between 0 and ${cfg.durationMin - 1} minutes for ${cfg.durationMin}-minute contracts`);
  }
  if (strategy === "crypto" && (cfg.agreeCount < 1 || cfg.agreeCount > cfg.assets.length)) {
    throw new Error(`Directional agreement must be between 1 and the number of selected assets (${cfg.assets.length})`);
  }
  if (cfg.minRemainingSec < 0 || cfg.minRemainingSec >= cfg.durationMin * 60) throw new Error("Minimum remaining time is out of range");
  if (cfg.tradeAmount < MIN_TRADE_AMOUNT) {
    throw new Error(`Trade amount must be at least $${MIN_TRADE_AMOUNT}: the bot buys whole contracts, and one contract costs up to 99 cents plus fees`);
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
  return cfg;
}
