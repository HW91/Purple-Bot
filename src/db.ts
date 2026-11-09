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

interface BotRow {
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
  const rs = await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots ORDER BY created_ts").all<BotRow>();
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
}

export async function openPositions(env: Env): Promise<PositionRow[]> {
  const rs = await env.DB.prepare("SELECT * FROM positions WHERE status = 'open'").all<PositionRow>();
  return rs.results ?? [];
}
