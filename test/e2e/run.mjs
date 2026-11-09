// End-to-end: real Worker + Durable Object + D1 (local), fake Kalshi (verifies signatures), fake coach worker.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import { startMock } from "./mock-kalshi.mjs";

const KP = 8798, WP = 8799;
const root = new URL("../../", import.meta.url).pathname;
const persist = fs.mkdtempSync("/tmp/pb-e2e-");
const results = [];
const ok = (name, cond, extra = "") => { results.push([cond, name]); console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 45000, step = 700) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return null; await sleep(step); } }

const startedAt = Date.now();
const mock = await startMock(KP);
fs.writeFileSync(root + ".dev.vars", `DASHBOARD_PASSWORD=pw-test\nSESSION_SECRET=${crypto.randomBytes(24).toString("hex")}\nENCRYPTION_KEY=${crypto.randomBytes(32).toString("base64")}\n`);
execSync(`npx wrangler d1 migrations apply purple-bot-db --local --persist-to ${persist}`, { cwd: root, stdio: "ignore" });
const dev = spawn("npx", ["wrangler", "dev", "-c", "wrangler.jsonc", "-c", "test/e2e/coach/wrangler.jsonc", "--port", String(WP), "--persist-to", persist, "--var", `KALSHI_BASE:http://127.0.0.1:${KP}/trade-api/v2`, "--var", `KALSHI_WS:http://127.0.0.1:${KP}/trade-api/ws/v2`], { cwd: root });
let devLog = ""; dev.stdout.on("data", (d) => (devLog += d)); dev.stderr.on("data", (d) => (devLog += d));
const cleanup = () => { try { dev.kill("SIGKILL"); } catch {} mock.close(); try { fs.unlinkSync(root + ".dev.vars"); } catch {} };
process.on("exit", cleanup);

const base = `http://127.0.0.1:${WP}`;
let cookie = "";
async function api(path, method = "GET", body, headers = {}) {
  const r = await fetch(base + "/api" + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== "GET" ? { "Content-Type": "application/json", "X-PB": "1" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc && sc.startsWith("pb_session=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j };
}
const mockState = async () => (await fetch(`http://127.0.0.1:${KP}/_state`)).json();
const quote = (tickers, bid, ask, size) => fetch(`http://127.0.0.1:${KP}/_quote`, { method: "POST", body: JSON.stringify({ tickers, bid, ask, size }) });
const coachSeen = async () => (await fetch(`${base}/__coach`).catch(() => null)) ;

try {
  const ready = await waitFor(async () => (await fetch(base + "/")).status === 200, 90000, 1000);
  ok("worker starts locally", !!ready, devLog.slice(-600));

  // ---- A. sign-in + CSRF
  ok("API refuses when signed out", (await api("/settings")).status === 401);
  ok("wrong password rejected", (await api("/login", "POST", { password: "nope" })).status === 401);
  ok("right password signs in", (await api("/login", "POST", { password: "pw-test" })).status === 200 && !!cookie);
  const noHeader = await fetch(base + "/api/emergency", { method: "POST", headers: { Cookie: cookie } });
  ok("state-changing call without X-PB header is refused (CSRF)", noHeader.status === 403);

  // ---- B. Kalshi connection (signature verified by the fake exchange)
  const bad = await api("/kalshi/connect", "POST", { keyId: "wrong-id", pem: mock.pem });
  ok("wrong key id is rejected by Kalshi and NOT saved", bad.status === 400 && (await api("/settings")).j.kalshiConnected === false, JSON.stringify(bad.j));
  const good = await api("/kalshi/connect", "POST", { keyId: mock.KEY_ID, pem: mock.pem });
  ok("Ed25519 key connects; signature accepted by exchange; balance read", good.status === 200 && good.j.keyKind === "ed25519" && good.j.balance === 100, JSON.stringify(good.j));
  const st = (await api("/settings")).j;
  ok("settings never expose the private key", st.kalshiConnected && !JSON.stringify(st).includes("PRIVATE KEY"));
  await api("/settings", "POST", { notifyEmail: "owner@example.com" });

  // ---- C. bots start OFF, bad config rejected
  ok("invalid bot rejected (unknown asset)", (await api("/bots", "POST", { name: "x", config: { strategy: "crypto", assets: ["BTC", "NOPE"] } })).status === 500 || (await api("/bots", "POST", { name: "x", config: { strategy: "crypto", assets: ["BTC", "NOPE"] } })).status === 400);
  const cfg = { strategy: "crypto", assets: ["BTC", "SOL", "XRP"], agreeCount: 3, timeDelaySec: 0, minRemainingSec: 120, tradeAmount: 5, maxPositions: 1, maxTradesPerHour: 4 };
  const bot1 = (await api("/bots", "POST", { name: "Bot One", config: cfg })).j.id;
  ok("new bot is OFF", (await api("/bots")).j.find((b) => b.id === bot1).enabled === false);

  // settlement bot on ETH (its contract closes 75s after the mock started)
  const bots2 = (await api("/bots", "POST", { name: "ETH settle bot", config: { strategy: "crypto", assets: ["ETH"], agreeCount: 1, timeDelaySec: 0, minRemainingSec: 15, tradeAmount: 5, stopLossOn: false, takeProfitOn: false } })).j.id;
  const T = (s) => `KX${s}15M-T1`;
  await quote([T("BTC"), T("SOL"), T("XRP"), T("ETH")], 0.83, 0.85);
  await api("/live"); // dashboard heartbeat wakes the engine
  await sleep(6000);
  ok("OFF bots place no orders", (await mockState()).orders.length === 0);

  // ---- D. start ETH bot (settlement scenario) and bot1
  await api(`/bots/${bots2}/start`, "POST");
  const ethOrder = await waitFor(async () => (await mockState()).orders.find((o) => o.ticker === T("ETH")), 40000);
  ok("ETH bot entered: YES bought as IOC at the ask", !!ethOrder && ethOrder.side === "bid" && ethOrder.price === "0.8500" && ethOrder.time_in_force === "immediate_or_cancel" && ethOrder.reduce_only === false, JSON.stringify(ethOrder));

  await api(`/bots/${bot1}/start`, "POST");
  const o1 = await waitFor(async () => (await mockState()).orders.find((o) => o.ticker === T("BTC") || o.ticker === T("SOL") || o.ticker === T("XRP")), 40000);
  ok("bot1 entered after 3-of-3 agreement + 85% price", !!o1 && o1.side === "bid" && Number(o1.count) === 5, JSON.stringify(o1));
  const pos1 = (await api("/positions")).j.open.find((p) => p.bot_id === bot1);
  ok("position recorded with entry probability + extremes", !!pos1 && pos1.outcome === "yes" && Math.abs(pos1.avg_entry - 0.85) < 1e-9 && pos1.entry_prob > 0.83 && pos1.fav_max !== null);
  await sleep(14000);
  ok("max 1 position: no second order from bot1", (await mockState()).orders.filter((o) => o.reduce_only === false && [T("BTC"), T("SOL"), T("XRP")].includes(o.ticker)).length === 1);

  // ---- E. stop loss using actual fills + fees
  await quote([T("BTC"), T("SOL"), T("XRP")], 0.30, 0.32);
  const closed1 = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === bot1), 45000);
  ok("stop loss closes the position", !!closed1 && closed1.close_reason === "stop_loss", JSON.stringify(closed1));
  const exitOrder = (await mockState()).orders.find((o) => o.reduce_only === true && o.ticker === (closed1?.ticker));
  ok("closing order is reduce-only IOC selling YES at the bid", !!exitOrder && exitOrder.side === "ask" && exitOrder.price === "0.3000" && exitOrder.time_in_force === "immediate_or_cancel", JSON.stringify(exitOrder));
  ok("realized P/L = proceeds - cost - both fees (-2.95)", !!closed1 && Math.abs(closed1.realized_pnl - -2.95) < 0.011 && closed1.result === "loss", JSON.stringify(closed1));

  // ---- F. Stop and Close All with a duplicate bot
  await quote([T("BTC"), T("SOL"), T("XRP")], 0.83, 0.85);
  const dup = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  ok("duplicate starts OFF", (await api("/bots")).j.find((b) => b.id === dup).enabled === false);
  await api(`/bots/${dup}/start`, "POST");
  const dpos = await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === dup), 40000);
  ok("duplicate bot entered", !!dpos);
  const sc = await api(`/bots/${dup}/stop-close`, "POST");
  ok("Stop and Close All turns the bot OFF immediately", sc.status === 200 && (await api("/bots")).j.find((b) => b.id === dup).enabled === false);
  const dclosed = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === dup), 40000);
  ok("…and closes its position (manual_close)", !!dclosed && dclosed.close_reason === "manual_close", JSON.stringify(dclosed));
  const nOrders = (await mockState()).orders.length; await sleep(8000);
  ok("a stopped bot places no further orders", (await mockState()).orders.length === nOrders);

  // ---- G. emergency shutdown
  const dup2 = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  await api(`/bots/${dup2}/start`, "POST");
  await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === dup2), 40000);
  const em = await api("/emergency", "POST");
  ok("emergency shutdown turns ALL bots off", em.status === 200 && (await api("/bots")).j.every((b) => !b.enabled));
  const eclosed = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === dup2), 40000);
  ok("…and closes open positions (emergency)", !!eclosed && eclosed.close_reason === "emergency", JSON.stringify(eclosed));

  // ---- H. settlement of the ETH contract (held to expiry, no forced close)
  await sleep(Math.max(0, 158000 - (Date.now() - startedAt)));
  await fetch(`http://127.0.0.1:${KP}/_settle`, { method: "POST", body: JSON.stringify({ ticker: T("ETH"), result: "yes" }) });
  const settled = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === bots2), 90000);
  ok("ETH position held to expiry and settled as a win", !!settled && settled.close_reason === "settled" && settled.result === "win" && Math.abs(settled.realized_pnl - 0.65) < 0.011 && settled.exit_prob === 1, JSON.stringify(settled));

  // ---- I. performance, logs, emails, AI, chat, backtest
  const perf = (await api("/performance")).j;
  ok("performance counts closed trades and extremes", perf.trades >= 4 && perf.byAsset.length >= 1 && perf.wins >= 1 && perf.losses >= 1, JSON.stringify(perf).slice(0, 300));
  const logs = (await api("/logs?limit=300")).j;
  ok("control events + orders are logged", logs.some((l) => l.kind === "control" && /START BOT/.test(l.message)) && logs.some((l) => l.kind === "order" && /ENTERED/.test(l.message)) && logs.some((l) => /EMERGENCY/.test(l.message)));
  ok("signal reasons recorded (why entered / skipped)", logs.some((l) => l.kind === "signal"));
  const chat = await api("/chat", "POST", { message: "Why was the last trade a loss?", botId: bot1 });
  ok("AI chat answers via the coach worker and is saved", chat.status === 200 && chat.j.answer === "MOCK AI ANSWER" && (await api(`/chat/${chat.j.convId}`)).j.length === 2, JSON.stringify(chat.j));
  const del = await api(`/chat/${chat.j.convId}`, "DELETE");
  ok("conversation can be deleted", del.status === 200 && (await api("/chat")).j.length === 0);
  const bt = await api("/backtest", "POST", { botId: bot1, fromTs: Date.now() - 86400000, toTs: Date.now() + 3600000, variants: [{ label: "85%", overrides: { probThreshold: 0.85 } }] });
  ok("backtest runs on recorded data, saved separately, no live orders", bt.status === 200 && bt.j.reports.length === 2 && (await api("/backtests")).j.length === 1);
  const markets = (await api("/chart/periods?asset=BTC")).j;
  const chart = markets.length ? (await api(`/chart?ticker=${encodeURIComponent(markets[0].ticker)}`)).j : null;
  ok("probability observations were saved to D1 and are chartable", !!chart && chart.points.length > 0 && chart.points.every((p) => p.yes > 0 && p.yes < 1), JSON.stringify(chart).slice(0, 200));

  // ---- J. delete rules + disconnect rules
  ok("cannot delete a bot while ON", await (async () => { await api(`/bots/${bot1}/start`, "POST"); const r = await api(`/bots/${bot1}`, "DELETE"); await api(`/bots/${bot1}/stop`, "POST"); return r.status === 409; })());
  ok("badAuth count on fake exchange only came from the deliberately wrong key", (await mockState()).badAuth === 1, String((await mockState()).badAuth));
} catch (e) {
  ok("e2e finished without an exception", false, String(e?.stack || e));
} finally {
  const failed = results.filter(([c]) => !c).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) console.log("---- wrangler log tail ----\n" + devLog.slice(-2500));
  cleanup();
  process.exit(failed ? 1 : 0);
}
