import { Engine } from "./engine";
import { KalshiAuthError, KalshiClient } from "./kalshi";
import { b64encode, encryptSecret, importSigningKey } from "./kalshi-auth";
import { deleteSetting, getAccountLimits, getCreds, getSetting, loadBots, log, rowToBot, setSetting, type PositionRow } from "./db";
import { askAI } from "./notify";
import { computePerformance } from "./stats";
import { dayStartMs } from "./strategy";
import { buildDayStats, etDateString, runOverview } from "./analysis";
import { KALSHI_RULES_PROMPT } from "./kalshi-rules";
import { simulate, type Obs, type SimMarket } from "./backtest";
import { DEFAULT_ACCOUNT_LIMITS, defaultBotConfig, validateBotConfig, type Env } from "./types";
import { UI_HTML } from "./ui";

export { Engine };

const enc = new TextEncoder();
const SESSION_DAYS = 7;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}
const err = (message: string, status = 400) => json({ error: message }, status);

// ------------------------------------------------------------------ sessions (single owner)

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}

function safeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function makeSession(env: Env): Promise<string> {
  const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
  return `${exp}.${await hmac(env.SESSION_SECRET, "session:" + exp)}`;
}

async function hasSession(req: Request, env: Env): Promise<boolean> {
  const m = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)pb_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, "session:" + exp));
}

async function loginRateLimited(env: Env): Promise<boolean> {
  const raw = await getSetting(env, "login_fails");
  if (!raw) return false;
  const { n, ts } = JSON.parse(raw) as { n: number; ts: number };
  return n >= 5 && Date.now() - ts < 15 * 60_000;
}

async function recordLoginFail(env: Env): Promise<void> {
  const raw = await getSetting(env, "login_fails");
  const prev = raw ? (JSON.parse(raw) as { n: number; ts: number }) : { n: 0, ts: 0 };
  const n = Date.now() - prev.ts > 15 * 60_000 ? 1 : prev.n + 1;
  await setSetting(env, "login_fails", JSON.stringify({ n, ts: Date.now() }));
}

// ------------------------------------------------------------------ helpers

const engine = (env: Env) => env.ENGINE.get(env.ENGINE.idFromName("main")) as unknown as DurableObjectStub<Engine>;
const uid = () => crypto.randomUUID();

async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

async function kalshiClient(env: Env): Promise<KalshiClient | null> {
  const creds = await getCreds(env);
  if (!creds) return null;
  return new KalshiClient(env.KALSHI_BASE, creds.keyId, await importSigningKey(creds.pem));
}

async function closedPositions(env: Env, botId?: string | null, limit = 2000): Promise<PositionRow[]> {
  const sql = botId ? "SELECT * FROM positions WHERE status != 'open' AND bot_id = ? ORDER BY closed_ts DESC LIMIT ?" : "SELECT * FROM positions WHERE status != 'open' ORDER BY closed_ts DESC LIMIT ?";
  const st = botId ? env.DB.prepare(sql).bind(botId, limit) : env.DB.prepare(sql).bind(limit);
  return (await st.all<PositionRow>()).results ?? [];
}

/** Profit/loss totals (realized, after fees) from closed positions since `since`, for the whole account or one bot. */
async function plAgg(env: Env, since: number, botId?: string): Promise<{ trades: number; wins: number; losses: number; pnl: number; fees: number; winRate: number | null }> {
  const sql =
    "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END),0) w, COALESCE(SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END),0) l, " +
    "COALESCE(SUM(realized_pnl),0) pnl, COALESCE(SUM(entry_fee+exit_fee),0) fees FROM positions WHERE status != 'open' AND realized_pnl IS NOT NULL AND closed_ts >= ?" +
    (botId ? " AND bot_id = ?" : "");
  const r = await (botId ? env.DB.prepare(sql).bind(since, botId) : env.DB.prepare(sql).bind(since)).first<{ n: number; w: number; l: number; pnl: number; fees: number }>();
  const w = r?.w ?? 0;
  const l = r?.l ?? 0;
  return { trades: r?.n ?? 0, wins: w, losses: l, pnl: Math.round((r?.pnl ?? 0) * 100) / 100, fees: Math.round((r?.fees ?? 0) * 100) / 100, winRate: w + l ? w / (w + l) : null };
}

async function plSummary(env: Env, botId?: string) {
  const now = Date.now();
  const day = dayStartMs(now);
  const where = botId ? " AND bot_id = ?" : "";
  const bind = (sql: string, ...b: unknown[]) => (botId ? env.DB.prepare(sql).bind(...b, botId) : env.DB.prepare(sql).bind(...b));
  const [today, week, all, open, invested] = await Promise.all([
    plAgg(env, day, botId),
    plAgg(env, now - 7 * 86_400_000, botId),
    plAgg(env, 0, botId),
    bind("SELECT COUNT(*) c, COALESCE(SUM(entry_cost),0) cost FROM positions WHERE status='open'" + where).first<{ c: number; cost: number }>(),
    bind("SELECT COALESCE(SUM(entry_cost+entry_fee),0) c FROM positions WHERE opened_ts >= ?" + where, day).first<{ c: number }>(),
  ]);
  return { today, week, all, openCount: open?.c ?? 0, openExposure: Math.round((open?.cost ?? 0) * 100) / 100, investedToday: Math.round((invested?.c ?? 0) * 100) / 100 };
}

// ------------------------------------------------------------------ router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(UI_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
      }
      if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });

      if (path === "/api/login" && req.method === "POST") {
        if (await loginRateLimited(env)) return err("Too many attempts. Try again in 15 minutes.", 429);
        const { password } = await body<{ password?: string }>(req);
        if (!password || !env.DASHBOARD_PASSWORD || !safeEqual(password, env.DASHBOARD_PASSWORD)) {
          await recordLoginFail(env);
          return err("Wrong password", 401);
        }
        await deleteSetting(env, "login_fails");
        return json({ ok: true }, 200, { "Set-Cookie": `pb_session=${await makeSession(env)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      }
      if (path === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": "pb_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });

      if (!(await hasSession(req, env))) return err("Not signed in", 401);
      // CSRF: state-changing calls must carry our header (cross-site forms/images cannot set it).
      if (req.method !== "GET" && req.headers.get("X-PB") !== "1") return err("Missing X-PB header", 403);

      return await route(req, env, url, path);
    } catch (e) {
      if (e instanceof KalshiAuthError) return err(e.message, 401);
      console.error(e);
      await log(env, "error", "error", `API ${path}: ${(e as Error).message}`);
      return err((e as Error).message || "Server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL, path: string): Promise<Response> {
  const m = req.method;
  let g: RegExpMatchArray | null;

  // ---------------- account / settings
  if (path === "/api/settings" && m === "GET") {
    const creds = await getSetting(env, "kalshi_key_id");
    return json({
      kalshiConnected: !!creds,
      keyId: creds,
      notifyEmail: (await getSetting(env, "notify_email")) ?? "",
      accountLimits: await getAccountLimits(env),
      seriesMap: JSON.parse((await getSetting(env, "series_map")) ?? "{}"),
      defaults: { crypto: defaultBotConfig("crypto"), metals: defaultBotConfig("metals"), account: DEFAULT_ACCOUNT_LIMITS },
    });
  }
  if (path === "/api/settings" && m === "POST") {
    const b = await body<{ notifyEmail?: string; accountLimits?: Record<string, number>; seriesMap?: Record<string, string> }>(req);
    if (b.notifyEmail !== undefined) {
      if (b.notifyEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.notifyEmail)) return err("That email address does not look right");
      await setSetting(env, "notify_email", b.notifyEmail.trim());
    }
    if (b.accountLimits) {
      const a = b.accountLimits;
      const lim = { dailyLossLimit: Number(a.dailyLossLimit), dailyInvestLimit: Number(a.dailyInvestLimit), maxPositions: Math.round(Number(a.maxPositions)) };
      if (!(lim.dailyLossLimit > 0 && lim.dailyInvestLimit > 0 && lim.maxPositions > 0)) return err("Account limits must all be greater than zero");
      await setSetting(env, "account_limits", JSON.stringify(lim));
    }
    if (b.seriesMap) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.seriesMap)) if (typeof v === "string" && /^[A-Z0-9_]{2,40}$/.test(v.trim().toUpperCase())) clean[k.toUpperCase()] = v.trim().toUpperCase();
      await setSetting(env, "series_map", JSON.stringify(clean));
    }
    await log(env, "info", "control", "Settings saved");
    await engine(env).poke();
    return json({ ok: true });
  }

  // ---------------- Kalshi connection
  if (path === "/api/kalshi/connect" && m === "POST") {
    const { keyId, pem } = await body<{ keyId?: string; pem?: string }>(req);
    if (!keyId?.trim() || !pem?.trim()) return err("Enter both the API Key ID and the private key");
    let sk;
    try {
      sk = await importSigningKey(pem);
    } catch (e) {
      return err((e as Error).message);
    }
    // Prove the key works against the real account BEFORE saving it.
    let balance;
    try {
      balance = await new KalshiClient(env.KALSHI_BASE, keyId.trim(), sk).balance();
    } catch (e) {
      return err(`Kalshi did not accept that key: ${(e as Error).message}`, 400);
    }
    await setSetting(env, "kalshi_key_id", keyId.trim());
    await setSetting(env, "kalshi_key_enc", await encryptSecret(env, pem.trim()));
    await log(env, "info", "control", `Kalshi credentials ${(await getSetting(env, "kalshi_key_enc")) ? "saved" : "saved"} (${sk.kind} key)`);
    await engine(env).credentialsChanged();
    return json({ ok: true, keyKind: sk.kind, balance: balance.balance, portfolioValue: balance.portfolioValue });
  }
  if (path === "/api/kalshi/test" && m === "POST") {
    const c = await kalshiClient(env);
    if (!c) return err("No Kalshi key is saved yet");
    const b = await c.balance();
    return json({ ok: true, ...b });
  }
  if (path === "/api/kalshi/disconnect" && m === "POST") {
    const open = await env.DB.prepare("SELECT COUNT(*) c FROM positions WHERE status='open'").first<{ c: number }>();
    const on = await env.DB.prepare("SELECT COUNT(*) c FROM bots WHERE enabled=1").first<{ c: number }>();
    if ((open?.c ?? 0) > 0 || (on?.c ?? 0) > 0) return err("Turn every bot off and close all positions before disconnecting Kalshi", 409);
    await deleteSetting(env, "kalshi_key_id");
    await deleteSetting(env, "kalshi_key_enc");
    await log(env, "info", "control", "Kalshi credentials removed");
    await engine(env).credentialsChanged();
    return json({ ok: true });
  }
  if (path === "/api/discover" && m === "GET") {
    const c = await kalshiClient(env);
    if (!c) return err("Connect Kalshi first");
    const list = await c.seriesList();
    return json({ series: list.filter((s) => /15M$/i.test(s.ticker) || /fifteen/i.test(s.frequency ?? "")).map((s) => ({ ticker: s.ticker, title: s.title, frequency: s.frequency })) });
  }

  // ---------------- live view + controls
  if (path === "/api/live" && m === "GET") return json(await engine(env).watch());
  if (path === "/api/emergency" && m === "POST") {
    const n = await engine(env).emergency();
    return json({ ok: true, closing: n });
  }
  if (path === "/api/reconcile" && m === "POST") return json(await engine(env).reconcileNow());

  // ---------------- bots
  if (path === "/api/bots" && m === "GET") {
    const bots = await loadBots(env);
    const all = await closedPositions(env);
    return json(bots.map((b) => ({ ...b, perf: computePerformance(all.filter((p) => p.bot_id === b.id)) })));
  }
  if (path === "/api/bots" && m === "POST") {
    const b = await body<{ name?: string; config?: Record<string, unknown> }>(req);
    const cfg = validateBotConfig((b.config ?? {}) as never);
    const name = (b.name ?? "").trim() || `${cfg.strategy === "crypto" ? "Crypto" : "Metals"} bot`;
    const id = uid();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO bots (id, name, strategy, config, enabled, created_ts, updated_ts) VALUES (?,?,?,?,0,?,?)").bind(id, name, cfg.strategy, JSON.stringify(cfg), now, now).run();
    await log(env, "info", "control", `Bot created (OFF): ${name}`, id);
    return json({ id });
  }
  if ((g = path.match(/^\/api\/bots\/([\w-]+)$/))) {
    const id = g[1];
    if (m === "PUT") {
      const b = await body<{ name?: string; config?: Record<string, unknown> }>(req);
      const cfg = validateBotConfig((b.config ?? {}) as never);
      const cur = await env.DB.prepare("SELECT strategy FROM bots WHERE id=?").bind(id).first<{ strategy: string }>();
      if (!cur) return err("Bot not found", 404);
      if (cur.strategy !== cfg.strategy) return err("A bot's strategy cannot be changed. Create a new bot instead.");
      await env.DB.prepare("UPDATE bots SET name=?, config=?, updated_ts=? WHERE id=?").bind((b.name ?? "").trim() || "Bot", JSON.stringify(cfg), Date.now(), id).run();
      await log(env, "info", "control", "Bot settings saved", id, cfg);
      await engine(env).poke();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const row = await env.DB.prepare("SELECT enabled FROM bots WHERE id=?").bind(id).first<{ enabled: number }>();
      if (!row) return err("Bot not found", 404);
      const open = await env.DB.prepare("SELECT COUNT(*) c FROM positions WHERE status='open' AND bot_id=?").bind(id).first<{ c: number }>();
      if (row.enabled || (open?.c ?? 0) > 0) return err("Turn the bot off and close its positions before deleting it", 409);
      await env.DB.prepare("DELETE FROM bots WHERE id=?").bind(id).run();
      await log(env, "info", "control", "Bot deleted (trade history kept)", id);
      return json({ ok: true });
    }
  }
  if ((g = path.match(/^\/api\/bots\/([\w-]+)\/(start|stop|stop-close|duplicate)$/)) && m === "POST") {
    const [, id, action] = g;
    const row = await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots WHERE id=?").bind(id).first<{ id: string; name: string; strategy: string; config: string; enabled: number }>();
    if (!row) return err("Bot not found", 404);
    if (action === "duplicate") {
      const nid = uid();
      const now = Date.now();
      await env.DB.prepare("INSERT INTO bots (id, name, strategy, config, enabled, created_ts, updated_ts) VALUES (?,?,?,?,0,?,?)").bind(nid, `${row.name} (copy)`, row.strategy, row.config, now, now).run();
      await log(env, "info", "control", "Bot duplicated (OFF)", nid);
      return json({ id: nid });
    }
    if (action === "start") {
      if (!(await getSetting(env, "kalshi_key_id"))) return err("Connect your Kalshi account first");
      if (!rowToBot(row).config) return err("Bot settings are invalid");
      await env.DB.prepare("UPDATE bots SET enabled=1, updated_ts=? WHERE id=?").bind(Date.now(), id).run();
      await log(env, "info", "control", "START BOT pressed — new trades enabled", id);
      await engine(env).poke();
      return json({ ok: true });
    }
    // stop and stop-close: turn entries off FIRST so nothing queued can still place an order
    await env.DB.prepare("UPDATE bots SET enabled=0, updated_ts=? WHERE id=?").bind(Date.now(), id).run();
    if (action === "stop") {
      await log(env, "info", "control", "STOP — NO NEW TRADES pressed (existing positions keep being managed)", id);
      await engine(env).poke();
      return json({ ok: true });
    }
    await log(env, "warn", "control", "STOP AND CLOSE ALL POSITIONS pressed", id);
    const n = await engine(env).closeAll(id, "manual_close");
    return json({ ok: true, closing: n });
  }

  // ---------------- profit / loss summaries
  if (path === "/api/account" && m === "GET") return json({ ...(await plSummary(env)), limits: await getAccountLimits(env) });
  if ((g = path.match(/^\/api\/bots\/([\w-]+)\/summary$/)) && m === "GET") {
    const id = g[1];
    const row = await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots WHERE id=?").bind(id).first<{ id: string; name: string; strategy: string; config: string; enabled: number }>();
    if (!row) return err("Bot not found", 404);
    const closed = (await env.DB.prepare("SELECT * FROM positions WHERE status != 'open' AND bot_id = ? ORDER BY closed_ts DESC LIMIT 50").bind(id).all()).results;
    return json({ bot: rowToBot(row), ...(await plSummary(env, id)), closed });
  }

  // ---------------- trades / performance / logs
  if (path === "/api/positions" && m === "GET") {
    const open = (await env.DB.prepare("SELECT * FROM positions WHERE status='open' ORDER BY opened_ts DESC").all()).results;
    const closed = (await env.DB.prepare("SELECT * FROM positions WHERE status!='open' ORDER BY closed_ts DESC LIMIT ?").bind(Math.min(Number(url.searchParams.get("limit") ?? 200), 1000)).all()).results;
    return json({ open, closed });
  }
  if (path === "/api/orders" && m === "GET") return json((await env.DB.prepare("SELECT * FROM orders ORDER BY created_ts DESC LIMIT ?").bind(Math.min(Number(url.searchParams.get("limit") ?? 100), 500)).all()).results);
  if (path === "/api/performance" && m === "GET") {
    const botId = url.searchParams.get("bot");
    return json(computePerformance(await closedPositions(env, botId)));
  }
  // How the market and your trades behave by hour of day (US Eastern), from what this bot has recorded.
  // "Reached 80%+" = in the tradeable part of a contract (after 5 min, before the last 2 min) either side reached 80%.
  // "Reversed" = that side then LOST at settlement. A high reversal rate at some hours means the 80% signal was less reliable then.
  if (path === "/api/hours" && m === "GET") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 30);
    const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
    const since = Date.now() - days * 86_400_000;
    const etHour = (ms: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, contracts: 0, settled: 0, reached: 0, reversed: 0, trades: 0, wins: 0, losses: 0, pnl: 0 }));
    const rows = (
      await env.DB.prepare(
        "SELECT m.open_ts, m.result, " +
          "MAX(CASE WHEN o.ts >= m.open_ts + 300000 AND o.ts <= m.close_ts - 120000 THEN (o.yes_bid + o.yes_ask) / 2 END) hi, " +
          "MIN(CASE WHEN o.ts >= m.open_ts + 300000 AND o.ts <= m.close_ts - 120000 THEN (o.yes_bid + o.yes_ask) / 2 END) lo, COUNT(*) n " +
          "FROM markets m JOIN observations o ON o.ticker = m.ticker WHERE m.open_ts >= ?" +
          (asset ? " AND m.asset = ?" : "") +
          " GROUP BY m.ticker HAVING n >= 3",
      )
        .bind(...(asset ? [since, asset] : [since]))
        .all<{ open_ts: number; result: string | null; hi: number | null; lo: number | null; n: number }>()
    ).results;
    for (const r of rows) {
      const h = hours[etHour(r.open_ts)];
      h.contracts++;
      const settled = r.result === "yes" || r.result === "no";
      if (settled) h.settled++;
      const yesTouch = r.hi !== null && r.hi >= 0.8;
      const noTouch = r.lo !== null && r.lo <= 0.2;
      h.reached += (yesTouch ? 1 : 0) + (noTouch ? 1 : 0);
      if (settled) h.reversed += (yesTouch && r.result === "no" ? 1 : 0) + (noTouch && r.result === "yes" ? 1 : 0);
    }
    const trades = (
      await env.DB.prepare("SELECT opened_ts, realized_pnl, result FROM positions WHERE status != 'open' AND realized_pnl IS NOT NULL AND opened_ts >= ?" + (asset ? " AND asset = ?" : ""))
        .bind(...(asset ? [since, asset] : [since]))
        .all<{ opened_ts: number; realized_pnl: number; result: string }>()
    ).results;
    for (const t of trades) {
      const h = hours[etHour(t.opened_ts)];
      h.trades++;
      if (t.result === "win") h.wins++;
      if (t.result === "loss") h.losses++;
      h.pnl += t.realized_pnl;
    }
    return json({ days, asset: asset || "ALL", tz: "America/New_York", contracts: rows.length, trades: trades.length, hours: hours.map((h) => ({ ...h, pnl: Math.round(h.pnl * 100) / 100 })) });
  }
  if (path === "/api/logs" && m === "GET") {
    const kind = url.searchParams.get("kind");
    const lim = Math.min(Number(url.searchParams.get("limit") ?? 150), 500);
    const st = kind ? env.DB.prepare("SELECT * FROM logs WHERE kind=? ORDER BY id DESC LIMIT ?").bind(kind, lim) : env.DB.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").bind(lim);
    return json((await st.all()).results);
  }
  // Overview for today so far, only when YOU press the button (the scheduled one runs once, after midnight Eastern)
  if (path === "/api/analyze" && m === "POST") {
    const last = Number((await getSetting(env, "last_manual_overview_ts")) ?? 0);
    if (Date.now() - last < 60_000) return err("An overview was just run. Wait a minute and try again.", 429);
    await setSetting(env, "last_manual_overview_ts", String(Date.now()));
    const now = Date.now();
    const o = await runOverview(env, dayStartMs(now), now, `today so far (${etDateString(now)})`);
    return json({ ok: true, ai: o.ai, text: o.text });
  }
  if (path === "/api/analyses" && m === "GET") return json((await env.DB.prepare("SELECT id, ts, text FROM analyses ORDER BY id DESC LIMIT 24").all()).results);

  // ---------------- charts
  if (path === "/api/chart/periods" && m === "GET") {
    const asset = (url.searchParams.get("asset") ?? "").toUpperCase();
    // each contract also says whether the chosen bot traded it and how that trade ended (for the Winners / Losers / No trade filter)
    const bot = url.searchParams.get("bot");
    const bf = bot ? " AND p.bot_id = ?" : "";
    const rows = (
      await env.DB.prepare(
        "SELECT m.ticker, m.title, m.open_ts, m.close_ts, m.result, " +
          `(SELECT COUNT(*) FROM positions p WHERE p.ticker = m.ticker${bf}) trades, ` +
          `(SELECT COUNT(*) FROM positions p WHERE p.ticker = m.ticker AND p.status = 'open'${bf}) open_trades, ` +
          `(SELECT COALESCE(SUM(p.realized_pnl), 0) FROM positions p WHERE p.ticker = m.ticker AND p.status != 'open'${bf}) pnl ` +
          "FROM markets m WHERE m.asset = ? ORDER BY m.close_ts DESC LIMIT 300",
      )
        .bind(...(bot ? [bot, bot, bot, asset] : [asset]))
        .all()
    ).results;
    return json(rows);
  }
  if (path === "/api/chart" && m === "GET") {
    const ticker = url.searchParams.get("ticker") ?? "";
    const mk = await env.DB.prepare("SELECT ticker, asset, title, open_ts, close_ts, result FROM markets WHERE ticker=?").bind(ticker).first();
    if (!mk) return err("Unknown market", 404);
    const obs = (await env.DB.prepare("SELECT ts, yes_bid, yes_ask FROM observations WHERE ticker=? ORDER BY ts").bind(ticker).all<{ ts: number; yes_bid: number; yes_ask: number }>()).results;
    const trades = (await env.DB.prepare("SELECT outcome, opened_ts, closed_ts, avg_entry, realized_pnl, close_reason FROM positions WHERE ticker=?").bind(ticker).all()).results;
    // Why the chosen bot did not trade this contract (counts of what blocked it, after its Time Delay)
    let why: { samples: number; top: Array<{ code: string; text: string; pct: number }> } | null = null;
    const botParam = url.searchParams.get("bot");
    if (botParam) {
      const n = await env.DB.prepare("SELECT samples, counts, texts FROM contract_notes WHERE bot_id=? AND ticker=?").bind(botParam, ticker).first<{ samples: number; counts: string; texts: string }>();
      if (n && n.samples > 0) {
        const counts = JSON.parse(n.counts) as Record<string, number>;
        const texts = JSON.parse(n.texts) as Record<string, string>;
        const top = Object.entries(counts)
          .filter(([c]) => c !== "ok")
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([c, k]) => ({ code: c, text: texts[c] ?? c, pct: Math.round((100 * k) / n.samples) }));
        why = { samples: n.samples, top };
      }
    }
    // the probability minimum this bot was using on this contract (saved while it ran; old contracts have none)
    let settings: { probMin: number; probMax: number } | null = null;
    if (botParam) {
      const s = await env.DB.prepare("SELECT prob_min, prob_max FROM contract_settings WHERE bot_id=? AND ticker=?").bind(botParam, ticker).first<{ prob_min: number; prob_max: number }>();
      if (s) settings = { probMin: s.prob_min, probMax: s.prob_max };
    }
    return json({ market: mk, points: obs.map((o) => ({ ts: o.ts, yes: (o.yes_bid + o.yes_ask) / 2, bid: o.yes_bid, ask: o.yes_ask })), trades, why, settings });
  }

  // ---------------- AI chat (only calls AI when the user sends a message)
  if (path === "/api/chat" && m === "GET") return json((await env.DB.prepare("SELECT id, title, bot_id, updated_ts FROM chat_conversations ORDER BY updated_ts DESC LIMIT 100").all()).results);
  if ((g = path.match(/^\/api\/chat\/([\w-]+)$/))) {
    if (m === "GET") return json((await env.DB.prepare("SELECT role, content, ts FROM chat_messages WHERE conv_id=? ORDER BY id").bind(g[1]).all()).results);
    if (m === "DELETE") {
      await env.DB.batch([env.DB.prepare("DELETE FROM chat_messages WHERE conv_id=?").bind(g[1]), env.DB.prepare("DELETE FROM chat_conversations WHERE id=?").bind(g[1])]);
      return json({ ok: true });
    }
  }
  if (path === "/api/chat" && m === "POST") {
    const b = await body<{ convId?: string; botId?: string | null; message?: string }>(req);
    const text = (b.message ?? "").trim();
    if (!text) return err("Type a message first");
    let convId = b.convId;
    const now = Date.now();
    if (!convId) {
      convId = uid();
      await env.DB.prepare("INSERT INTO chat_conversations (id, title, bot_id, created_ts, updated_ts) VALUES (?,?,?,?,?)").bind(convId, text.slice(0, 60), b.botId ?? null, now, now).run();
    }
    const conv = await env.DB.prepare("SELECT bot_id FROM chat_conversations WHERE id=?").bind(convId).first<{ bot_id: string | null }>();
    if (!conv) return err("Conversation not found", 404);
    const history = (await env.DB.prepare("SELECT role, content FROM chat_messages WHERE conv_id=? ORDER BY id DESC LIMIT 10").bind(convId).all<{ role: string; content: string }>()).results.reverse();
    await env.DB.prepare("INSERT INTO chat_messages (conv_id, role, content, ts) VALUES (?,?,?,?)").bind(convId, "user", text, now).run();
    const context = await chatContext(env, conv.bot_id);
    const prompt =
      "You are the assistant inside a personal Kalshi trading-bot dashboard. You are ADVISORY ONLY: you can explain and recommend, but you cannot change settings, start/stop bots, place orders, close positions or override risk limits, and you must never say you did. " +
      "If you recommend a setting change, say the owner must apply it themselves in the bot's settings. Answer only from the data below; separate MEASURED facts from ESTIMATES; if the data does not say, say you do not know. Be short and plain.\n\n" +
      "How to read the data: strategyStats covers the last 14 days. Inside it, stopLossTakeProfitHindsight compares trades that exited early (stop loss or take profit) with what holding to settlement would have paid (hindsight only; it ignores the risk the exit removed). blockedBy is what kept the bots from trading and the share of tradeable time. reliability is how often a side that reached 80% then lost at settlement. byEntryHour is results by entry hour in US Eastern. performance is by asset, probability range, YES/NO and how trades ended. recentTrades lists up to the last 100 closed trades, newest first. Always say how many trades a conclusion rests on.\n\n" +
      "Use the Kalshi rules below to explain how contracts are defined and settled when asked. " + KALSHI_RULES_PROMPT + "\n\n" +
      `DATA (JSON):\n${context}\n\nCONVERSATION SO FAR:\n${history.map((h) => `${h.role.toUpperCase()}: ${h.content}`).join("\n")}\n\nUSER: ${text}`;
    const answer = (await askAI(env, prompt, `pb-${convId}`)) ?? "I couldn't reach the AI just now. Your question was saved; try again in a moment.";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO chat_messages (conv_id, role, content, ts) VALUES (?,?,?,?)").bind(convId, "assistant", answer, Date.now()),
      env.DB.prepare("UPDATE chat_conversations SET updated_ts=? WHERE id=?").bind(Date.now(), convId),
    ]);
    return json({ convId, answer });
  }

  // ---------------- backtests (never touch live orders or live settings)
  if (path === "/api/backtests" && m === "GET") return json((await env.DB.prepare("SELECT id, bot_id, from_ts, to_ts, created_ts, report FROM backtests ORDER BY created_ts DESC LIMIT 30").all()).results.map((r) => ({ ...r, report: JSON.parse(String((r as { report: string }).report)) })));
  if (path === "/api/backtest" && m === "POST") {
    const b = await body<{ botId?: string; fromTs?: number; toTs?: number; variants?: Array<{ label?: string; overrides?: Record<string, unknown> }> }>(req);
    const row = await env.DB.prepare("SELECT id, name, strategy, config, enabled FROM bots WHERE id=?").bind(b.botId ?? "").first<{ id: string; name: string; strategy: string; config: string; enabled: number }>();
    if (!row) return err("Pick a bot", 404);
    const from = Number(b.fromTs);
    const to = Number(b.toTs);
    if (!(from > 0 && to > from)) return err("Pick a valid date range");
    const bot = rowToBot(row);
    const mk = (await env.DB.prepare("SELECT ticker, asset, open_ts, close_ts, result FROM markets WHERE open_ts>=? AND close_ts<=? ORDER BY open_ts").bind(from, to).all<{ ticker: string; asset: string; open_ts: number; close_ts: number; result: string | null }>()).results;
    const obsRows = (await env.DB.prepare("SELECT ticker, ts, yes_bid, yes_ask FROM observations WHERE ts>=? AND ts<=? ORDER BY ts").bind(from, to).all<{ ticker: string; ts: number; yes_bid: number; yes_ask: number }>()).results;
    const obs = new Map<string, Obs[]>();
    for (const o of obsRows) (obs.get(o.ticker) ?? obs.set(o.ticker, []).get(o.ticker)!).push({ ts: o.ts, bid: o.yes_bid, ask: o.yes_ask });
    const feeRow = await env.DB.prepare("SELECT SUM(fee) f, SUM(fill_count) n FROM orders WHERE fill_count > 0").first<{ f: number | null; n: number | null }>();
    const feePer = feeRow?.n ? (feeRow.f ?? 0) / feeRow.n : 0.02;
    const markets: SimMarket[] = mk.map((x) => ({ ticker: x.ticker, asset: x.asset, openTs: x.open_ts, closeTs: x.close_ts, result: x.result === "yes" || x.result === "no" ? x.result : null }));
    const variants = [{ label: "Current settings", overrides: {} }, ...(b.variants ?? []).slice(0, 5).map((v) => ({ label: v.label ?? "Variant", overrides: v.overrides ?? {} }))];
    const reports = variants.map((v) => {
      let cfg;
      try {
        cfg = validateBotConfig({ ...bot.config, ...v.overrides } as never);
      } catch (e) {
        return { label: v.label, error: (e as Error).message };
      }
      return { label: v.label, overrides: v.overrides, report: simulate(cfg, markets, obs, { feePerContract: feePer, slippage: 0.01 }) };
    });
    const id = uid();
    await env.DB.prepare("INSERT INTO backtests (id, bot_id, config, from_ts, to_ts, report, created_ts) VALUES (?,?,?,?,?,?,?)").bind(id, bot.id, JSON.stringify(bot.config), from, to, JSON.stringify(reports).slice(0, 900_000), Date.now()).run();
    return json({ id, reports, dataNote: markets.length === 0 ? "No recorded contracts in that range yet. The bot records probabilities only while it is running or being watched." : undefined });
  }

  return err("Not found", 404);
}

/** Authorized account data the AI chat may use. Never includes credentials. */
async function chatContext(env: Env, botId: string | null): Promise<string> {
  const bots = await loadBots(env);
  const scope = botId ? bots.filter((b) => b.id === botId) : bots;
  const closed = (await closedPositions(env, botId, 300)).slice(0, 100); // up to a full day of trades (96 fifteen-minute contracts)
  const strategy = await buildDayStats(env, Date.now() - 14 * 86_400_000, Date.now(), "the last 14 days", botId);
  const open = (await env.DB.prepare(botId ? "SELECT * FROM positions WHERE status='open' AND bot_id=?" : "SELECT * FROM positions WHERE status='open'").bind(...(botId ? [botId] : [])).all()).results;
  const logs = (await env.DB.prepare(botId ? "SELECT ts, level, kind, message FROM logs WHERE bot_id=? ORDER BY id DESC LIMIT 40" : "SELECT ts, level, kind, message FROM logs ORDER BY id DESC LIMIT 40").bind(...(botId ? [botId] : [])).all()).results;
  const analysis = await env.DB.prepare("SELECT ts, text FROM analyses ORDER BY id DESC LIMIT 1").first();
  const latest = (await env.DB.prepare("SELECT o.ticker, m.asset, o.ts, (o.yes_bid+o.yes_ask)/2 AS yes FROM observations o JOIN markets m ON m.ticker=o.ticker WHERE o.ts >= ? GROUP BY o.ticker HAVING o.ts = MAX(o.ts)").bind(Date.now() - 20 * 60_000).all()).results;
  const orders = (await env.DB.prepare("SELECT ticker, kind, status, fill_count, price, fee, error, created_ts FROM orders ORDER BY created_ts DESC LIMIT 20").all()).results;
  return JSON.stringify({
    now: new Date().toISOString(),
    bots: scope.map((b) => ({ name: b.name, enabled: b.enabled, config: b.config })),
    strategyStats: strategy,
    performance: computePerformance(await closedPositions(env, botId, 500)),
    openPositions: open,
    recentTrades: closed.map((p) => ({ asset: p.asset, side: p.outcome, entryProb: p.entry_prob, favMax: p.fav_max, favMin: p.fav_min, exitProb: p.exit_prob, pnl: p.realized_pnl, result: p.result, how: p.close_reason, agree: p.agree_count })),
    latestProbabilities: latest,
    recentOrders: orders,
    recentLogs: logs,
    latestDailyOverview: analysis,
  }).slice(0, 50_000);
}
