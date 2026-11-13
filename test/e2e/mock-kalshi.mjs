// A tiny fake Kalshi that VERIFIES request signatures the way Kalshi documents them.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export function startMock(port) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const KEY_ID = "test-key-id";
  const state = { settledClose: new Map(), quotes: new Map(), positions: new Map(), orders: [], badAuth: 0, results: new Map(), balance: 100, exposure: new Map(), combo: { collectionAsks: [], created: [], rfqs: [], accepted: null, deleted: false, noQuote: false, invert: false, ticker: "", yesBid: 0.93, noBid: 0.05 } };
  const open = Date.now() - 360000; // current window opened 6 min ago
  const close = open + 3600000; // far enough away that 'minimum time remaining' never interferes with the test
  const iso = (t) => new Date(t).toISOString();
  const shortClose = Date.now() + 150000; // KXETH15M closes 150s after start (settlement test)
  const mk = (series) => ({ ticker: `${series}-T1`, event_ticker: `${series}-E1`, title: `${series} up?`, yes_sub_title: "Up", status: "active", open_time: iso(open), close_time: iso(series === "KXETH15M" || series === "KXDOGE15M" ? shortClose : close), result: state.results.get(`${series}-T1`) ?? "", yes_bid_dollars: q(`${series}-T1`).bid.toFixed(4), yes_ask_dollars: q(`${series}-T1`).ask.toFixed(4), last_price_dollars: ((q(`${series}-T1`).bid + q(`${series}-T1`).ask) / 2).toFixed(4) });

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
      if (url.pathname === "/_trade") { // a public trade on the live trade channel: { tickers, side, count, yes }
        for (const t of b.tickers) {
          const msg = JSON.stringify({ type: "trade", sid: 2, seq: 1, msg: { trade_id: "t" + Math.random().toString(36).slice(2), market_ticker: t, yes_price_dollars: Number(b.yes).toFixed(4), no_price_dollars: (1 - Number(b.yes)).toFixed(4), count_fp: Number(b.count).toFixed(2), taker_side: b.side, taker_outcome_side: b.side, taker_book_side: b.side === "yes" ? "bid" : "ask", is_block_trade: false, ts: Math.floor(Date.now() / 1000), ts_ms: Date.now() } });
          for (const c of clients) if (c.tradeTickers?.has(t) && c.readyState === 1) c.send(msg);
        }
        return send(200, {});
      }
      if (url.pathname === "/_quiet") { state.quiet = b.on !== false; return send(200, {}); }
      if (url.pathname === "/_settle") { state.results.set(b.ticker, b.result); return send(200, {}); }
      if (url.pathname === "/_combo") { Object.assign(state.combo, b.set ?? {}); if (b.reset) { state.combo.collectionAsks = []; state.combo.created = []; state.combo.rfqs = []; state.combo.accepted = null; state.combo.deleted = false; for (const t of [...state.positions.keys()]) if (t.startsWith("KXMVEEV")) { state.positions.delete(t); state.exposure.delete(t); } } return send(200, state.combo); }
      if (url.pathname === "/_state") return send(200, { orders: state.orders, positions: [...state.positions], badAuth: state.badAuth, combo: state.combo });
      return send(404, {});
    }
    if (!verify(req)) { state.badAuth++; return send(401, { code: "unauthorized", message: "bad signature" }); }
    const p = url.pathname.replace("/trade-api/v2", "");
    if (p === "/portfolio/balance") return send(200, { balance: Math.round(state.balance * 100), balance_dollars: state.balance.toFixed(2), portfolio_value: 0, updated_ts: Date.now() });
    if (p === "/markets" && url.searchParams.get("status") === "settled") { // past contracts for the history load: three per series, closed 2, 3 and 4 hours ago
      const series = url.searchParams.get("series_ticker");
      const list = [1, 2, 3].map((n) => { const closeSec = Math.floor(Date.now() / 60000) * 60 - (n + 1) * 3600; const ticker = `${series}-HIST${n}`; state.settledClose.set(ticker, closeSec); return { ticker, event_ticker: `${series}-HIST${n}`, status: "settled", open_time: new Date((closeSec - 900) * 1000).toISOString(), close_time: new Date(closeSec * 1000).toISOString(), result: n === 2 ? "no" : "yes" }; });
      return send(200, { markets: list, cursor: "" });
    }
    let cs = p.match(/^\/series\/([^/]+)\/markets\/([^/]+)\/candlesticks$/);
    if (cs) { // 15 one-minute candles ending at the close: YES bid/ask rising from 55c to 83c
      const closeSec = state.settledClose.get(decodeURIComponent(cs[2]));
      if (!closeSec) return send(404, { error: "unknown market" });
      return send(200, { ticker: cs[2], candlesticks: Array.from({ length: 15 }, (_, i) => { const k = 14 - i; const bid = 0.55 + (14 - k) * 0.02; return { end_period_ts: closeSec - k * 60, yes_bid: { close_dollars: bid.toFixed(4) }, yes_ask: { close_dollars: (bid + 0.02).toFixed(4) }, price: {}, volume_fp: "1.00", open_interest_fp: "1.00" }; }) });
    }
    if (p === "/markets") return send(200, { markets: url.searchParams.get("status") === "open" ? [mk(url.searchParams.get("series_ticker"))] : [], cursor: "" });
    if (p === "/markets/trades") { // same fields as Kalshi's Get Trades (docs.kalshi.com/api-reference/market/get-trades)
      const t = url.searchParams.get("ticker");
      const at = (min, sec) => iso(open + min * 60000 + sec * 1000);
      const tr = (id, side, count, yes, minute, sec, blockTrade = false) => ({ trade_id: id, ticker: t, count_fp: count, yes_price_dollars: yes, no_price_dollars: (1 - Number(yes)).toFixed(4), taker_outcome_side: side, taker_book_side: side === "yes" ? "bid" : "ask", created_time: at(minute, sec), is_block_trade: blockTrade });
      return send(200, { trades: [tr("1", "yes", "2.00", "0.8400", 0, 30), tr("2", "no", "3.00", "0.8000", 0, 45), tr("3", "yes", "1.50", "0.9000", 1, 10), tr("4", "no", "100.00", "0.9000", 1, 40, true), tr("5", "yes", "4.00", "0.8600", 2, 5)], cursor: "" });
    }
    let m = p.match(/^\/markets\/(.+)$/);
    if (m) { const t = decodeURIComponent(m[1]); return send(200, { market: { ...mk(t.replace("-T1", "")), ticker: t, status: state.results.has(t) ? "determined" : "active", result: state.results.get(t) ?? "" } }); }
    if (p === "/portfolio/positions") return send(200, { market_positions: [...state.positions].filter(([, v]) => Math.abs(v) > 0.001).map(([ticker, v]) => ({ ticker, position_fp: v.toFixed(2), market_exposure_dollars: (state.exposure.get(ticker) ?? 0).toFixed(4), realized_pnl_dollars: "0", fees_paid_dollars: state.exposure.has(ticker) ? "0.0400" : "0" })), cursor: "" });
    // ---- combos (Kalshi multivariate events + request for quote), shaped like docs.kalshi.com
    if (p === "/multivariate_event_collections" && req.method === "GET") {
      state.combo.collectionAsks.push(url.searchParams.get("associated_event_ticker"));
      return send(200, { multivariate_contracts: [{ collection_ticker: "KXMVETEST", size_min: 2, size_max: 5, associated_events: ["KXBTC15M", "KXSOL15M", "KXETH15M", "KXGOLD15M"].map((s) => ({ ticker: `${s}-E1`, is_yes_only: false, active_quoters: [] })) }], cursor: "" });
    }
    if (p === "/multivariate_event_collections/KXMVETEST" && req.method === "POST") {
      const b = JSON.parse(body);
      state.combo.created.push(b.selected_markets);
      state.combo.ticker = `KXMVEEV-${state.combo.created.length}-COMBO`;
      return send(200, { event_ticker: "KXMVEEV-1", market_ticker: state.combo.ticker });
    }
    if (p === "/communications/rfqs" && req.method === "POST") {
      const b = JSON.parse(body);
      state.combo.rfqs.push(b);
      return send(201, { id: "rfq-1" });
    }
    if (p === "/communications/quotes" && req.method === "GET") {
      const st = state.combo.accepted ? "executed" : "open";
      if (url.searchParams.get("status") === "open" && st !== "open") return send(200, { quotes: [] });
      if (state.combo.noQuote) return send(200, { quotes: [] });
      return send(200, { quotes: [{ id: "quote-1", rfq_id: "rfq-1", status: st, market_ticker: state.combo.ticker, contracts_fp: "1.00", yes_bid_dollars: state.combo.yesBid.toFixed(4), no_bid_dollars: state.combo.noBid.toFixed(4) }] });
    }
    if (p === "/communications/rfqs/rfq-1/quotes/quote-1/accept" && req.method === "PUT") {
      const side = JSON.parse(body).accepted_side;
      state.combo.accepted = side;
      const count = state.combo.rfqs[state.combo.rfqs.length - 1].contracts;
      const holdsYes = state.combo.invert ? side === "no" : side === "yes"; // invert = the opposite meaning, to test the self-correcting check
      state.positions.set(state.combo.ticker, holdsYes ? count : -count);
      state.exposure.set(state.combo.ticker, count * 0.95);
      res.writeHead(204); return res.end();
    }
    if (p === "/communications/rfqs/rfq-1" && req.method === "DELETE") { state.combo.deleted = true; res.writeHead(204); return res.end(); }
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
      ws.tickers = new Set(); ws.tradeTickers = new Set(); clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.cmd === "subscribe") {
          const channel = (m.params.channels ?? ["ticker"])[0];
          const set = channel === "trade" ? ws.tradeTickers : ws.tickers;
          (m.params.market_tickers ?? []).forEach((t) => set.add(t));
          ws.send(JSON.stringify({ id: m.id, type: "subscribed", msg: { channel, sid: channel === "trade" ? 2 : 1 } }));
          if (channel !== "trade") (m.params.market_tickers ?? []).forEach(tick);
        }
        if (m.cmd === "update_subscription" && m.params.action === "add_markets") {
          const isTrade = (m.params.sids ?? []).includes(2);
          m.params.market_tickers.forEach((t) => (isTrade ? ws.tradeTickers : ws.tickers).add(t));
          if (!isTrade) m.params.market_tickers.forEach(tick);
        }
      });
    });
  });
  setInterval(() => { if (state.quiet) return; for (const t of state.quotes.keys()) tick(t); }, 2000);
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ KEY_ID, pem, state, close: () => server.close() })));
}
