import type { AccountLimits, Bot, BotConfig, Env } from "./types";
import { DEFAULT_ACCOUNT_LIMITS, validateBotConfig } from "./types";
import { decryptSecret } from "./kalshi-auth";

export type LogLevel = "info" | "warn" | "error";
export type LogKind = "order" | "control" | "error" | "notify" | "signal" | "system";

export async function log(env: Env, level: LogLevel, kind: LogKind, message: string, botId?: string | null, data?: unknown): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO logs (ts, level, kind, bot_id, message, data) VALUES (?,?,?,?,?,?)")
      .bind(Date.now(), level, kind, botId ?? null, message.slice(0, 2000), data === undefined ? null : JSON.stringify(data).slice(0, 4000))
      .run();
  } catch (e) {
    console.error("log failed", e);
  }
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export async function getCreds(env: Env): Promise<{ keyId: string; pem: string } | null> {
  const keyId = await getSetting(env, "kalshi_key_id");
  const enc = await getSetting(env, "kalshi_key_enc");
  if (!keyId || !enc) return null;
  return { keyId, pem: await decryptSecret(env, enc) };
}

export async function getAccountLimits(env: Env): Promise<AccountLimits> {
  const raw = await getSetting(env, "account_limits");
  if (!raw) return DEFAULT_ACCOUNT_LIMITS;
  try {
    return { ...DEFAULT_ACCOUNT_LIMITS, ...(JSON.parse(raw) as Partial<AccountLimits>) };
  } catch {
    return DEFAULT_ACCOUNT_LIMITS;
  }
}

export interface BotRow {
  id: string;
  name: string;
  strategy: string;
  config: string;
  enabled: number;
}

export function rowToBot(r: BotRow): Bot {
  let cfg: BotConfig;
  try {
    cfg = validateBotConfig(JSON.parse(r.config));
  } catch {
    // A corrupt saved config must never trade: fall back to defaults but keep the bot OFF.
    cfg = validateBotConfig({ strategy: r.strategy === "metals" ? "metals" : "crypto" });
    return { id: r.id, name: r.name, strategy: cfg.strategy, config: cfg, enabled: false };
  }
  return { id: r.id, name: r.name, strategy: cfg.strategy, config: cfg, enabled: r.enabled === 1 };
}

export async function loadBots(env: Env): Promise<Bot[]> {
  const rs = await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots ORDER BY sort_order, created_ts").all<BotRow>();
  return (rs.results ?? []).map(rowToBot);
}

/** Authoritative on/off check used right before every order. */
export async function isBotEnabled(env: Env, botId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT enabled FROM bots WHERE id = ?").bind(botId).first<{ enabled: number }>();
  return r?.enabled === 1;
}

export interface PositionRow {
  id: string;
  bot_id: string;
  ticker: string;
  asset: string;
  outcome: "yes" | "no";
  entry_qty: number;
  open_qty: number;
  avg_entry: number | null;
  entry_cost: number;
  entry_fee: number;
  exit_proceeds: number;
  exit_fee: number;
  status: "open" | "closed" | "settled";
  opened_ts: number;
  closed_ts: number | null;
  close_reason: string | null;
  market_close_ts: number;
  entry_prob: number | null;
  exit_prob: number | null;
  fav_max: number | null;
  fav_min: number | null;
  prob_before_close: number | null;
  agree_count: number | null;
  duration_min: number | null;
  realized_pnl: number | null;
  result: string | null;
  demo?: number; // 1 = a demo (paper) trade, 0 or missing = a real trade
}

export async function openPositions(env: Env): Promise<PositionRow[]> {
  const rs = await env.DB.prepare("SELECT * FROM positions WHERE status = 'open'").all<PositionRow>();
  return rs.results ?? [];
}

/**
 * Whether results are demo (1) or real (0). A bot's own results follow that bot's Demo setting; anything not about one bot (the account totals, the
 * Trades tab, the dashboard) is always real. The Demo checkbox on the bot is the only place demo is decided.
 */
export async function viewDemo(env: Env, botId?: string | null): Promise<0 | 1> {
  if (!botId) return 0;
  const r = await env.DB.prepare("SELECT config FROM bots WHERE id = ?").bind(botId).first<{ config: string }>();
  try {
    return (JSON.parse(r?.config ?? "{}") as { demo?: boolean }).demo ? 1 : 0;
  } catch {
    return 0;
  }
}

export const DEMO_START_BALANCE = 1000;

/** The pretend account: $1,000 plus every closed demo trade's profit or loss, minus what open demo trades have put in. */
export async function demoBalance(env: Env): Promise<{ cash: number; portfolio: number }> {
  const pnl = await env.DB.prepare("SELECT COALESCE(SUM(realized_pnl),0) c FROM positions WHERE demo=1 AND status != 'open' AND realized_pnl IS NOT NULL").first<{ c: number }>();
  const open = await env.DB.prepare("SELECT COALESCE(SUM(entry_cost+entry_fee),0) c, COALESCE(SUM(entry_cost),0) v FROM positions WHERE demo=1 AND status='open'").first<{ c: number; v: number }>();
  const start = Number(await getSetting(env, "demo_balance_start")) || DEMO_START_BALANCE;
  return { cash: Math.round((start + (pnl?.c ?? 0) - (open?.c ?? 0)) * 100) / 100, portfolio: Math.round((open?.v ?? 0) * 100) / 100 };
}
