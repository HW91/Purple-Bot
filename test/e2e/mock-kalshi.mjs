// A tiny fake Kalshi that VERIFIES request signatures the way Kalshi documents them.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export function startMock(port) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const KEY_ID = "test-key-id";
  const state = { quotes: new Map(), positions: new Map(), orders: [], badAuth: 0, results: new Map(), balance: 100 };
  const open = Date.now() - 360000; // current window opened 6 min ago
  const close = open + 3600000; // far enough away that 'minimum time remaining' never interferes with the test
  const iso = (t) => new Date(t).toISOString();
  const shortClose = Date.now() + 150000; // KXETH15M closes 150s after start (settlement test)
  const mk = (series) => ({ ticker: `${series}-T1`, event_ticker: `${series}-E1`, title: `${series} up?`, yes_sub_title: "Up", status: "active", open_time: iso(open), close_time: iso(series === "KXETH15M" ? shortClose : close), result: state.results.get(`${series}-T1`) ?? "", yes_bid_dollars: "0.5000", yes_ask_dollars: "0.5200", last_price_dollars: "0.5000" });

  function verify(req, wsPath) {
    const ts = req.headers["kalshi-access-timestamp"], sig = req.headers["kalshi-access-signature"], key = req.headers["kalshi-access-key"];
    if (key !== KEY_ID || !ts || !sig) return false;
    const path = wsPath ?? new URL(req.url, "http://x").pathname;
    return crypto.verify(null, Buffer.from(ts + req.method + path), publicKey, Buffer.from(sig, "base64"));
  }
  const q = (t) => state.quotes.get(t) ?? { bid: 0.5, ask: 0.52, bidSize: 100, askSize: 100 };

  const clients = new Set();
  function tick(t) {
    const x = q(t);
    const msg = JSON.stringify({ type: "ticker", sid: 1, msg: { market_ticker: t, price_dollars: String((x.bid + x.ask) / 2), yes_bid_dollars: x.bid.toFixed(4), yes_ask_dollars: x.ask.toFixed(4), yes_bid_size_fp: x.bidSize.toFixed(2), yes_ask_size_fp: x.askSize.toFixed(2), volume_fp: "1.00", ts_ms: Date.now() } });
    for (const c of clients) if (c.tickers?.has(t) && c.readyState === 1) c.send(msg);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (url.pathname.startsWith("/_")) { // test controls (no auth)
      const b = body ? JSON.parse(body) : {};
      if (url.pathname === "/_quote") { for (const t of b.tickers) { state.quotes.set(t, { bid: b.bid, ask: b.ask, bidSize: b.size ?? 100, askSize: b.size ?? 100 }); tick(t); } return send(200, {}); }
      if (url.pathname === "/_settle") { state.results.set(b.ticker, b.result); return send(200, {}); }
      if (url.pathname === "/_state") return send(200, { orders: state.orders, positions: [...state.positions], badAuth: state.badAuth });
      return send(404, {});
    }
    if (!verify(req)) { state.badAuth++; return send(401, { code: "unauthorized", message: "bad signature" }); }
    const p = url.pathname.replace("/trade-api/v2", "");
    if (p === "/portfolio/balance") return send(200, { balance: Math.round(state.balance * 100), balance_dollars: state.balance.toFixed(2), portfolio_value: 0, updated_ts: Date.now() });
    if (p === "/markets") return send(200, { markets: url.searchParams.get("status") === "open" ? [mk(url.searchParams.get("series_ticker"))] : [], cursor: "" });
    let m = p.match(/^\/markets\/(.+)$/);
    if (m) { const t = decodeURIComponent(m[1]); return send(200, { market: { ...mk(t.replace("-T1", "")), ticker: t, status: state.results.has(t) ? "determined" : "active", result: state.results.get(t) ?? "" } }); }
    if (p === "/portfolio/positions") return send(200, { market_positions: [...state.positions].filter(([, v]) => Math.abs(v) > 0.001).map(([ticker, v]) => ({ ticker, position_fp: v.toFixed(2), market_exposure_dollars: "0", realized_pnl_dollars: "0", fees_paid_dollars: "0" })), cursor: "" });
    if (p === "/portfolio/events/orders" && req.method === "POST") {
      const o = JSON.parse(body);
      state.orders.push(o);
      const x = q(o.ticker); const count = Number(o.count), price = Number(o.price);
      let fill = 0, fp = 0;
      if (o.side === "bid" && price >= x.ask - 1e-9) { fill = Math.min(count, x.askSize); fp = x.ask; }
      if (o.side === "ask" && price <= x.bid + 1e-9) { fill = Math.min(count, x.bidSize); fp = x.bid; }
      const cur = state.positions.get(o.ticker) ?? 0;
      if (o.reduce_only) fill = Math.min(fill, Math.abs(cur));
      if (fill > 0) state.positions.set(o.ticker, cur + (o.side === "bid" ? fill : -fill));
      return send(200, { order_id: crypto.randomUUID(), client_order_id: o.client_order_id, fill_count: fill.toFixed(2), remaining_count: (count - fill).toFixed(2), ...(fill > 0 ? { average_fill_price: fp.toFixed(4), average_fee_paid: "0.0200" } : {}), ts_ms: Date.now() });
    }
    return send(404, { code: "not_found", message: p });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!verify(req, "/trade-api/ws/v2")) { state.badAuth++; socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.tickers = new Set(); clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.cmd === "subscribe") { (m.params.market_tickers ?? []).forEach((t) => ws.tickers.add(t)); ws.send(JSON.stringify({ id: m.id, type: "subscribed", msg: { channel: "ticker", sid: 1 } })); (m.params.market_tickers ?? []).forEach(tick); }
        if (m.cmd === "update_subscription" && m.params.action === "add_markets") { m.params.market_tickers.forEach((t) => ws.tickers.add(t)); m.params.market_tickers.forEach(tick); }
      });
    });
  });
  setInterval(() => { for (const t of state.quotes.keys()) tick(t); }, 2000);
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ KEY_ID, pem, state, close: () => server.close() })));
}
