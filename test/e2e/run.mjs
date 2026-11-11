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
const dev = spawn("npx", ["wrangler", "dev", "-c", "wrangler.jsonc", "-c", "test/e2e/coach/wrangler.jsonc", "--port", String(WP), "--persist-to", persist, "--var", `KALSHI_BASE:http://127.0.0.1:${KP}/trade-api/v2`, "--var", `KALSHI_WS:http://127.0.0.1:${KP}/trade-api/ws/v2`], { cwd: root, detached: true });
let devLog = ""; dev.stdout.on("data", (d) => (devLog += d)); dev.stderr.on("data", (d) => (devLog += d));
// kill the whole process group (npx -> wrangler -> workerd) so no stale server is left on the port for the next run
const cleanup = () => { try { process.kill(-dev.pid, "SIGKILL"); } catch {} try { dev.kill("SIGKILL"); } catch {} mock.close(); try { fs.unlinkSync(root + ".dev.vars"); } catch {} };
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
  const cfg = { strategy: "crypto", assets: ["BTC", "SOL", "XRP"], agreeCount: 3, stopLossOn: true, stopLoss: 2.5, timeDelaySec: 0, minRemainingSec: 120, tradeAmount: 5, maxPositions: 1, maxTradesPerHour: 4 };
  const bot1 = (await api("/bots", "POST", { name: "Bot One", config: cfg })).j.id;
  ok("new bot is OFF", (await api("/bots")).j.find((b) => b.id === bot1).enabled === false);

  // settlement bot on ETH (its contract closes 75s after the mock started)
  // a bot that never trades: it only makes the engine watch DOGE, whose contract closes early, to test that results are saved for every contract
  await api("/bots", "POST", { name: "DOGE watcher (never started)", config: { strategy: "crypto", assets: ["DOGE"], agreeCount: 1, tradeAsset: "DOGE" } });
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

  // ---- H. settlement of the ETH contract (held to expiry, no forced close)
  await sleep(Math.max(0, 158000 - (Date.now() - startedAt)));
  await fetch(`http://127.0.0.1:${KP}/_settle`, { method: "POST", body: JSON.stringify({ ticker: T("ETH"), result: "yes" }) });
  await fetch(`http://127.0.0.1:${KP}/_settle`, { method: "POST", body: JSON.stringify({ ticker: T("DOGE"), result: "no" }) });
  const dogeSaved = await waitFor(async () => (await api("/chart/periods?asset=DOGE")).j.find((x) => x.ticker === T("DOGE") && x.result === "no"), 90000);
  ok("the final result is saved for a contract the bot never traded (so early exits and backtests can use it)", !!dogeSaved, JSON.stringify((await api("/chart/periods?asset=DOGE")).j));
  const settled = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === bots2), 90000);
  ok("ETH position held to expiry and settled as a win", !!settled && settled.close_reason === "settled" && settled.result === "win" && Math.abs(settled.realized_pnl - 0.65) < 0.011 && settled.exit_prob === 1, JSON.stringify(settled));

  // ---- G. emergency shutdown
  const dup2 = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  await api(`/bots/${dup2}/start`, "POST");
  await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === dup2), 40000);
  const em = await api("/emergency", "POST");
  ok("emergency shutdown turns ALL bots off", em.status === 200 && (await api("/bots")).j.every((b) => !b.enabled));
  const eclosed = await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === dup2), 40000);
  ok("…and closes open positions (emergency)", !!eclosed && eclosed.close_reason === "emergency", JSON.stringify(eclosed));

  // ---- I. performance, logs, emails, AI, chat, backtest
  const perf = (await api("/performance")).j;
  ok("performance counts closed trades and extremes", perf.trades >= 4 && perf.byAsset.length >= 1 && perf.wins >= 1 && perf.losses >= 1, JSON.stringify(perf).slice(0, 300));
  const logs = (await api("/logs?limit=300")).j;
  ok("control events + orders are logged", logs.some((l) => l.kind === "control" && /START BOT/.test(l.message)) && logs.some((l) => l.kind === "order" && /ENTERED/.test(l.message)) && logs.some((l) => /EMERGENCY/.test(l.message)));
  ok("signal reasons recorded (why entered / skipped)", logs.some((l) => l.kind === "signal"));
  const ov = await api("/analyze", "POST");
  ok("daily overview (today so far) runs on demand, sends the day's measured data, and keeps the AI's real answer", ov.status === 200 && ov.j.ai === true && /^Overview for today so far/.test(ov.j.text) && /\[has:blockedBy,stopLossTakeProfitHindsight,reliability,byEntryHour,earlyExits,rules\]/.test(ov.j.text), JSON.stringify(ov.j).slice(0, 300));
  const analyses = (await api("/analyses")).j;
  ok("the overview is saved and listed", analyses.length >= 1 && /MOCK AI ANSWER/.test(analyses[0].text));
  ok("the overview can't be spammed", (await api("/analyze", "POST")).status === 429);
  const hourlyBot = (await api("/bots", "POST", { name: "old hourly", config: { strategy: "crypto", notify: "hourly" } })).j.id;
  ok("a bot saved with the old 'hourly' email choice becomes 'daily'", (await api("/bots")).j.find((b) => b.id === hourlyBot).config.notify === "daily");
  const chat = await api("/chat", "POST", { message: "Why was the last trade a loss?", botId: bot1 });
  ok("AI chat answers via the coach worker and is saved", chat.status === 200 && chat.j.answer === "MOCK AI ANSWER" && (await api(`/chat/${chat.j.convId}`)).j.length === 2, JSON.stringify(chat.j));
  const chatData = await api("/chat", "POST", { message: "ECHO_DATA what does the stop loss do?" });
  ok("chat receives the strategy data (hindsight, blocked reasons, entry hours) and the recent trades", chatData.status === 200 && /\[has:strategyStats,stopLossTakeProfitHindsight,blockedBy,byEntryHour,recentTrades,latestDailyOverview,rules,tradeDetail\]/.test(chatData.j.answer) && Number((chatData.j.answer.match(/trades:(\d+)/) || [])[1]) >= 4, chatData.j.answer);
  await api(`/chat/${chatData.j.convId}`, "DELETE");
  const chatFail = await api("/chat", "POST", { message: "FAIL_AI please", botId: bot1 });
  ok("the coach's apology reply is treated as a failure, not shown as an answer", chatFail.status === 200 && /couldn't reach the AI/.test(chatFail.j.answer) && !/having trouble connecting/.test(chatFail.j.answer), JSON.stringify(chatFail.j));
  await api(`/chat/${chatFail.j.convId}`, "DELETE");
  const del = await api(`/chat/${chat.j.convId}`, "DELETE");
  ok("conversation can be deleted", del.status === 200 && (await api("/chat")).j.length === 0);
  const bt = await api("/backtest", "POST", { botId: bot1, fromTs: Date.now() - 86400000, toTs: Date.now() + 3600000, variants: [{ label: "85%", overrides: { probThreshold: 0.85 } }] });
  ok("backtest runs on recorded data, saved separately, no live orders", bt.status === 200 && bt.j.reports.length === 2 && (await api("/backtests")).j.length === 1);
  const filt = (await api(`/chart/periods?asset=BTC&bot=${bot1}`)).j;
  const btcRow = filt.find((x) => x.ticker === T("BTC"));
  ok("contract list says how the chosen bot did (trades, open trades, profit/loss) for the Winners / Losers / No trade filter", !!btcRow && btcRow.trades >= 1 && typeof btcRow.pnl === "number" && typeof btcRow.open_trades === "number", JSON.stringify(btcRow));
  ok("a bot that never traded shows no trades on that contract", (await api(`/chart/periods?asset=BTC&bot=${hourlyBot}`)).j.find((x) => x.ticker === T("BTC"))?.trades === 0);
  const markets = (await api("/chart/periods?asset=BTC")).j;
  const chart = markets.length ? (await api(`/chart?ticker=${encodeURIComponent(markets[0].ticker)}`)).j : null;
  ok("probability observations were saved to D1 and are chartable", !!chart && chart.points.length > 0 && chart.points.every((p) => p.yes > 0 && p.yes < 1), JSON.stringify(chart).slice(0, 200));

  // ---- K. quiet markets: no price messages for 45s, a bot started now must still enter
  await quote([T("BTC"), T("SOL"), T("XRP")], 0.83, 0.85);
  await fetch(`http://127.0.0.1:${KP}/_quiet`, { method: "POST", body: JSON.stringify({ on: true }) });
  for (let i = 0; i < 9; i++) { await api("/live"); await sleep(5000); } // keeps the engine awake; the exchange sends nothing
  const quietBot = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  await api(`/bots/${quietBot}/start`, "POST");
  const quietPos = await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === quietBot), 40000);
  ok("quiet markets (no price updates for 45s) still enter once all criteria are met", !!quietPos);
  await api(`/bots/${quietBot}/stop-close`, "POST");
  await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === quietBot), 40000);
  await fetch(`http://127.0.0.1:${KP}/_quiet`, { method: "POST", body: JSON.stringify({ on: false }) });

  // ---- L. the chart note: why a bot took no trade on a contract
  await quote([T("BTC"), T("XRP")], 0.83, 0.85);
  await quote([T("SOL")], 0.30, 0.32); // SOL disagrees, so 3 of 3 can never agree
  const whyBot = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  await api(`/bots/${whyBot}/start`, "POST");
  const whyData = await waitFor(async () => { const r = (await api(`/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${whyBot}`)).j; return r.why && r.why.samples >= 3 ? r : null; }, 40000);
  ok("chart explains why no trade was taken (agreement)", !!whyData && whyData.why.top[0].code === "agreement" && /agree/.test(whyData.why.top[0].text) && whyData.why.top[0].pct >= 90, JSON.stringify(whyData?.why));
  const chk = (c, k) => c && c.find((x) => x.key === k);
  ok("the checklist shows the requirement that fails right now (assets do not agree) and the ones that pass", !!whyData && chk(whyData.checks, "agree")?.ok === false && chk(whyData.checks, "probMin")?.ok === true, JSON.stringify(whyData?.checks));
  // now let SOL agree: the bot enters, and the note keeps only what held it back BEFORE the entry
  await quote([T("SOL")], 0.83, 0.85);
  const whyPos = await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === whyBot), 40000);
  ok("the bot entered as soon as the agreement held", !!whyPos);
  await sleep(12000);
  const after = (await api(`/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${whyBot}`)).j;
  ok("after entry, the note still explains the wait and does not fill up with 'position open' reasons", after.trades.length >= 1 && after.why.top[0].code === "agreement" && after.why.top.every((x) => x.code !== "risk" && x.code !== "ok"), JSON.stringify(after.why));
  ok("after the entry the checklist is frozen as it was at the entry (everything green, risk limits passed)", !!after.checks && after.checks.every((c) => c.ok === true), JSON.stringify(after.checks));
  // the chart's entry-minimum line: saved per contract from the setting in use while the contract ran
  const chartUrl = `/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${whyBot}`;
  const s1 = (await api(chartUrl)).j.settings;
  ok("chart reports the bot's probability minimum and Time Delay for the contract (80%, 0s)", !!s1 && Math.abs(s1.probMin - 0.8) < 1e-9 && s1.delaySec === 0, JSON.stringify(s1));
  await api(`/bots/${whyBot}`, "PUT", { name: "Bot One (copy)", config: { ...cfg, probThreshold: 0.82, timeDelaySec: 120 } });
  const s2 = await waitFor(async () => { const r = (await api(chartUrl)).j.settings; return r && Math.abs(r.probMin - 0.82) < 1e-9 && r.delaySec === 120 ? r : null; }, 30000);
  ok("changing the settings moves both lines on the contract they apply to (82%, 120s)", !!s2);
  ok("a bot that never ran on the contract has no line", (await api(`/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${hourlyBot}`)).j.settings === null);
  await api(`/bots/${whyBot}/stop-close`, "POST");
  await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === whyBot), 40000);
  ok("no note is returned when no bot is picked", (await api(`/chart?ticker=${encodeURIComponent(T("BTC"))}`)).j.why === null);
  await quote([T("BTC"), T("SOL"), T("XRP")], 0.83, 0.85);

  // ---- L2. order flow: money on each side as support for entering (user-chosen time frame and ratio)
  const flowBot = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  const flowSave = await api(`/bots/${flowBot}`, "PUT", { name: "Flow bot", config: { ...cfg, flowOn: true, flowWindowMin: 0, flowRatio: 3 } });
  ok("order flow settings save (on, whole contract, ratio 3)", flowSave.status === 200, JSON.stringify(flowSave.j).slice(0, 200));
  ok("a ratio under 1 is refused", (await api(`/bots/${flowBot}`, "PUT", { name: "Flow bot", config: { ...cfg, flowOn: true, flowRatio: 0.5 } })).status >= 400);
  await api(`/bots/${flowBot}/start`, "POST");
  const flowUrl = `/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${flowBot}`;
  const flowLine = (r) => r?.checks?.find((c) => c.key === "flow");
  // the contract already has $6.47 on YES and $10.60 on NO (the fake exchange's trade list): not enough support yet
  const flowRed = await waitFor(async () => { const r = (await api(flowUrl)).j; return flowLine(r)?.ok === false && /\$\d/.test(flowLine(r).text) ? r : null; }, 60000);
  ok("with too little money on YES the checklist shows the order-flow line red, with the dollars", !!flowRed && /\$6 on YES vs \$11 on NO/.test(flowLine(flowRed).text), JSON.stringify(flowLine(flowRed)));
  ok("and the bot has not traded", !(await api("/positions")).j.open.find((p) => p.bot_id === flowBot));
  // a big YES trade arrives on the live trade channel: the running total updates and the bot enters
  await fetch(`http://127.0.0.1:${KP}/_trade`, { method: "POST", body: JSON.stringify({ tickers: [T("BTC")], side: "yes", count: 150, yes: 0.85 }) });
  const flowPos = await waitFor(async () => (await api("/positions")).j.open.find((p) => p.bot_id === flowBot), 40000);
  ok("after a large YES trade the ratio is met and the bot enters", !!flowPos);
  await sleep(11000);
  const flowAfter = (await api(flowUrl)).j;
  ok("after entry the checklist is frozen with the order-flow line green", flowLine(flowAfter)?.ok === true, JSON.stringify(flowLine(flowAfter)));
  await api(`/bots/${flowBot}/stop-close`, "POST");
  await waitFor(async () => (await api("/positions")).j.closed.find((p) => p.bot_id === flowBot), 40000);
  await quote([T("BTC"), T("SOL"), T("XRP")], 0.83, 0.85);

  // ---- L3. no-trade window: a window around the current Eastern time blocks entries; the checklist says so
  const etNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const etMin = Number(etNow.find((p) => p.type === "hour").value) * 60 + Number(etNow.find((p) => p.type === "minute").value);
  const hhmm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
  const winBot = (await api(`/bots/${bot1}/duplicate`, "POST")).j.id;
  const winSave = await api(`/bots/${winBot}`, "PUT", { name: "Window bot", config: { ...cfg, noTradeWindows: [{ start: hhmm(etMin - 90), end: hhmm(etMin + 90) }] } });
  ok("no-trade window settings save", winSave.status === 200 && (await api("/bots")).j.find((b) => b.id === winBot)?.config?.noTradeWindows?.length === 1, JSON.stringify(winSave.j).slice(0, 200));
  ok("a window with the same start and end is refused", (await api(`/bots/${winBot}`, "PUT", { name: "Window bot", config: { ...cfg, noTradeWindows: [{ start: "10:00", end: "10:00" }] } })).status >= 400);
  await api(`/bots/${winBot}/start`, "POST");
  const winChecks = await waitFor(async () => { const r = (await api(`/chart?ticker=${encodeURIComponent(T("BTC"))}&bot=${winBot}`)).j; const w = r.checks?.find((c) => c.key === "window"); return w && w.ok === false ? r : null; }, 60000);
  ok("inside a no-trade window the checklist shows it red and the bot takes no trade", !!winChecks && !(await api("/positions")).j.open.find((p) => p.bot_id === winBot), JSON.stringify(winChecks?.checks?.[0]));
  await api(`/bots/${winBot}/stop`, "POST");

  // ---- H2. time-of-day view
  const hrs = (await api("/hours?days=7")).j;
  ok("time-of-day view: 24 hours, counts every recorded contract and trade", hrs.hours?.length === 24 && hrs.contracts >= 1 && hrs.trades >= 4 && hrs.hours.reduce((s, x) => s + x.trades, 0) === hrs.trades, JSON.stringify(hrs).slice(0, 300));
  ok("time-of-day view can be limited to one asset", (await api("/hours?days=7&asset=ETH")).j.asset === "ETH");

  // ---- I2. account + per-bot profit/loss summaries
  const acctSum = (await api("/account")).j;
  const perfAll = (await api("/performance")).j;
  ok("account summary: all-time P/L and trade count match the performance numbers", acctSum.all.trades === perfAll.trades && Math.abs(acctSum.all.pnl - perfAll.pnl) < 0.011 && acctSum.limits.dailyLossLimit > 0, JSON.stringify(acctSum).slice(0, 300));
  const botSum = (await api(`/bots/${bot1}/summary`)).j;
  ok("per-bot summary returns that bot's own numbers and trades", botSum.bot?.id === bot1 && botSum.all.trades >= 1 && botSum.closed.every((p) => p.bot_id === bot1), JSON.stringify(botSum).slice(0, 300));
  ok("per-bot totals add up to the account total", Math.abs(((await api("/bots")).j.reduce((s, b) => s + b.perf.pnl, 0)) - acctSum.all.pnl) < 0.011);

  // ---- I3. the real dashboard page in a real browser: account card, tap into a bot
  try {
    const { createRequire } = await import("node:module");
    const { chromium } = createRequire(import.meta.url)("playwright");
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base + "/");
    await page.fill("#pw", "pw-test");
    await page.click("#pwEye");
    ok("eye icon shows the typed password", (await page.getAttribute("#pw", "type")) === "text");
    await page.click("#loginBtn");
    await page.waitForSelector("text=Account", { timeout: 15000 });
    await page.waitForSelector("text=Closed trades: profit/loss after fees", { timeout: 15000 });
    const dashText = await page.textContent("#main");
    ok("dashboard shows the Account card with balance and profit/loss", dashText.includes("Cash balance") && dashText.includes("All time"));
    // related numbers are grouped under headings, in a sensible order
    const order = ["Account value", "Open trades", "Closed trades: profit/loss after fees", "Results", "Daily limits (all bots)"].map((t) => dashText.indexOf(t));
    ok("dashboard groups related numbers under headings in order (value, open trades, closed trades, results, limits)", order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), JSON.stringify(order));
    const openGroup = dashText.slice(dashText.indexOf("Open trades"), dashText.indexOf("Closed trades: profit/loss after fees"));
    ok("the two open-trade numbers sit next to each other", openGroup.includes("Open now") && openGroup.includes("Profit/loss on open trades (if closed now)"));
    await page.screenshot({ path: "/tmp/claude-0/-home-user/82a96742-dc5a-5f59-b9da-e70bb4f29f5a/scratchpad/dash.png", fullPage: true });
    await page.click("button.link >> nth=0");
    await page.waitForSelector("text=Profit / loss — this bot only", { timeout: 15000 });
    ok("tapping a bot opens its own profit/loss page", true);
    await page.screenshot({ path: "/tmp/claude-0/-home-user/82a96742-dc5a-5f59-b9da-e70bb4f29f5a/scratchpad/bot.png", fullPage: true });
    await page.reload();
    await page.waitForSelector("text=Profit / loss — this bot only", { timeout: 15000 });
    ok("refresh keeps you on the same bot page", true);
    await page.click("text=← Back to Dashboard");
    await page.click("nav >> text=Settings");
    await page.reload();
    await page.waitForSelector("text=Kalshi connection", { timeout: 15000 });
    ok("refresh keeps you on the Settings tab", true);
    await page.click("nav >> text=Charts");
    await page.waitForSelector("text=Volume behind this contract", { timeout: 25000 });
    const volText = await page.textContent("#main");
    ok("Charts tab shows the volume tables (summary and by minute, no block-trade row or share/gap line)", !volText.includes("Block trades") && !volText.includes("YES share of dollars") && !volText.includes("Gap =") && volText.includes("YES bets") && volText.includes("NO bets") && volText.includes("Total") && volText.includes("YES $ ÷ NO $") && volText.includes("Money ratio") && !volText.includes("Market YES prob.") && !volText.includes("Gap (pts)"), volText.slice(-400));
    ok("no JavaScript errors in the page", errors.length === 0, errors.join(" | "));
    await browser.close();
  } catch (e) {
    ok("browser check of the dashboard", false, String(e?.stack || e));
  }

  // ---- volume behind a contract (bets on YES and NO, by minute)
  const vol = (await api(`/chart/volume?ticker=${encodeURIComponent(T("BTC"))}`)).j;
  ok("volume: YES and NO bets, contracts and dollars (YES pays the yes price, NO pays the no price)", vol.summary?.yes?.trades === 3 && vol.summary.yes.contracts === 7.5 && vol.summary.yes.dollars === 6.47 && vol.summary.no.trades === 2 && vol.summary.no.contracts === 103 && vol.summary.no.dollars === 10.6 && vol.summary.total.dollars === 17.07, JSON.stringify(vol.summary));
  ok("volume: YES share of dollars is set next to the market's own YES probability, with the gap in points", Math.abs(vol.summary.yesShare - 6.47 / 17.07) < 0.001 && typeof vol.summary.marketProb === "number" && vol.summary.marketProb > 0 && vol.summary.marketProb < 1 && Math.abs(vol.summary.gap - (vol.summary.yesShare - vol.summary.marketProb) * 100) < 0.2 && vol.minutes[0].yesShare > 0.73 && vol.minutes[0].yesShare < 0.74 && vol.minutes[0].gap === null, JSON.stringify([vol.summary.yesShare, vol.summary.marketProb, vol.summary.gap, vol.minutes[0]]));
  ok("volume: block trades are identified and included in the totals", vol.summary.block.trades === 1 && vol.summary.block.dollars === 10 && vol.summary.total.trades === 5);
  ok("volume: split by minute (one row per minute of the contract; the fake contract lasts an hour; the block trade is in the second minute)", vol.minutes.length === 60 && vol.minutes[0].yes.trades === 1 && vol.minutes[1].block.trades === 1 && vol.minutes[2].yes.dollars === 3.44, JSON.stringify(vol.minutes.slice(0, 3)));
  ok("volume: an unknown contract is refused", (await api("/chart/volume?ticker=NOPE")).status === 404);

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
