/**
 * Kalshi REST client (production by default). Endpoints and field names were taken from
 * https://docs.kalshi.com (Create Order V2, Get Balance, Get Positions, Get Markets, Get Order).
 * Nothing here is guessed: if Kalshi changes a shape, the response is rejected loudly instead of traded on.
 */
import { authHeaders, type SigningKey } from "./kalshi-auth";
import type { RawTrade } from "./volume";

export class KalshiAuthError extends Error {}
export class KalshiHttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  status: string;
  open_time: string;
  close_time: string;
  result?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  expiration_value?: string; // the final value used to settle the contract
  floor_strike?: number | null; // the target: at or above this value, YES wins
}

export interface OrderResult {
  orderId: string;
  clientOrderId?: string;
  fillCount: number;
  remainingCount: number;
  avgFillPrice: number | null; // YES-leg price
  avgFee: number; // per contract
}

export interface AccountPosition {
  ticker: string;
  position: number; // signed: + YES, - NO
  exposure: number;
  realizedPnl: number;
  fees: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const num = (v: unknown, d = 0): number => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

export class KalshiClient {
  constructor(private base: string, private keyId: string, private sk: SigningKey) {}

  private async request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      const headers = {
        ...(await authHeaders(this.sk, this.keyId, method, url.pathname)),
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      };
      const res = await fetch(url.toString(), { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
      // Kalshi 429s have no Retry-After; docs say to use exponential backoff.
      if (res.status === 429 && attempt < 4) {
        await sleep(250 * 2 ** attempt);
        attempt++;
        continue;
      }
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        /* non-JSON body */
      }
      if (res.status === 401 || res.status === 403) throw new KalshiAuthError(`Kalshi rejected the credentials (${res.status}). ${text.slice(0, 200)}`);
      if (!res.ok) throw new KalshiHttpError(res.status, `Kalshi ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, json);
      return json as T;
    }
  }

  async balance(): Promise<{ balance: number; portfolioValue: number }> {
    const r = await this.request<{ balance: number; portfolio_value: number }>("GET", "/portfolio/balance");
    if (typeof r?.balance !== "number") throw new Error("Unexpected balance response from Kalshi");
    return { balance: r.balance / 100, portfolioValue: num(r.portfolio_value) / 100 };
  }

  async openMarketsInSeries(series: string): Promise<KalshiMarket[]> {
    const r = await this.request<{ markets: KalshiMarket[] }>("GET", "/markets", { query: { series_ticker: series, status: "open", limit: 20 } });
    return r?.markets ?? [];
  }

  async market(ticker: string): Promise<KalshiMarket> {
    const r = await this.request<{ market: KalshiMarket }>("GET", `/markets/${encodeURIComponent(ticker)}`);
    if (!r?.market) throw new Error("Unexpected market response from Kalshi");
    return r.market;
  }

  /**
   * Every completed trade on one contract (Get Trades, newest first, 1000 per page). Kalshi sets no maximum total, so this keeps paging until
   * the list ends; `maxPages` is only a safety stop (100 pages = 100,000 trades = about 1,000 request tokens). 429s are retried with backoff in request().
   */
  async trades(ticker: string, maxPages = 100): Promise<{ trades: RawTrade[]; truncated: boolean }> {
    const out: RawTrade[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.request<{ trades: RawTrade[]; cursor?: string }>("GET", "/markets/trades", { query: { ticker, limit: 1000, cursor } });
      out.push(...(r?.trades ?? []));
      cursor = r?.cursor || undefined;
      if (!cursor) return { trades: out, truncated: false };
    }
    return { trades: out, truncated: true };
  }

  /** Settled contracts of one series (newest first), a page at a time. min_settled_ts is in seconds. */
  async settledMarkets(series: string, minSettledTs: number, cursor?: string): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
    const r = await this.request<{ markets: KalshiMarket[]; cursor?: string }>("GET", "/markets", { query: { series_ticker: series, status: "settled", min_settled_ts: minSettledTs, limit: 1000, cursor } });
    return { markets: r?.markets ?? [], cursor: r?.cursor || undefined };
  }

  /** Kalshi's own 1-minute price history for one contract; contracts old enough to be archived are read from the historical copy. */
  async candlesticks(series: string, ticker: string, startTs: number, endTs: number): Promise<Array<{ end_period_ts: number; yes_bid?: { close_dollars?: string | null }; yes_ask?: { close_dollars?: string | null } }>> {
    const query = { start_ts: startTs, end_ts: endTs, period_interval: 1 };
    try {
      const r = await this.request<{ candlesticks: Array<{ end_period_ts: number; yes_bid?: { close_dollars?: string | null }; yes_ask?: { close_dollars?: string | null } }> }>("GET", `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks`, { query });
      return r?.candlesticks ?? [];
    } catch (e) {
      if (!(e instanceof KalshiHttpError) || (e.status !== 404 && e.status !== 400)) throw e;
      const r = await this.request<{ candlesticks: Array<{ end_period_ts: number; yes_bid?: { close_dollars?: string | null }; yes_ask?: { close_dollars?: string | null } }> }>("GET", `/historical/markets/${encodeURIComponent(ticker)}/candlesticks`, { query });
      return r?.candlesticks ?? [];
    }
  }

  async seriesList(): Promise<Array<{ ticker: string; title?: string; frequency?: string; category?: string }>> {
    const r = await this.request<{ series: Array<{ ticker: string; title?: string; frequency?: string; category?: string }> }>("GET", "/series");
    return r?.series ?? [];
  }

  /**
   * Create Order V2. `side` is the YES leg: bid = buy YES, ask = sell YES (selling YES with no position opens NO).
   * We only ever send immediate_or_cancel so there is never a resting order to forget about.
   */
  async createOrder(p: { ticker: string; clientOrderId: string; side: "bid" | "ask"; count: number; price: number; reduceOnly: boolean }): Promise<OrderResult> {
    const r = await this.request<{
      order_id: string;
      client_order_id?: string;
      fill_count: string;
      remaining_count: string;
      average_fill_price?: string;
      average_fee_paid?: string;
    }>("POST", "/portfolio/events/orders", {
      body: {
        ticker: p.ticker,
        client_order_id: p.clientOrderId,
        side: p.side,
        count: p.count.toFixed(2),
        price: p.price.toFixed(4),
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
        reduce_only: p.reduceOnly,
        cancel_order_on_pause: true,
        subaccount: 0,
      },
    });
    if (!r?.order_id) throw new Error("Kalshi did not return an order id");
    return {
      orderId: r.order_id,
      clientOrderId: r.client_order_id,
      fillCount: num(r.fill_count),
      remainingCount: num(r.remaining_count),
      avgFillPrice: r.average_fill_price !== undefined ? num(r.average_fill_price) : null,
      avgFee: num(r.average_fee_paid),
    };
  }

  async getOrder(orderId: string): Promise<{ fillCount: number; remaining: number; fees: number; fillCost: number; status: string }> {
    const r = await this.request<{ order: Record<string, unknown> }>("GET", `/portfolio/orders/${encodeURIComponent(orderId)}`);
    const o = r?.order;
    if (!o) throw new Error("Unexpected order response from Kalshi");
    return {
      fillCount: num(o.fill_count_fp),
      remaining: num(o.remaining_count_fp),
      fees: num(o.taker_fees_dollars) + num(o.maker_fees_dollars),
      fillCost: num(o.taker_fill_cost_dollars) + num(o.maker_fill_cost_dollars),
      status: String(o.status ?? ""),
    };
  }

  async cancelOrder(orderId: string, ticker: string): Promise<void> {
    await this.request("DELETE", `/portfolio/events/orders/${encodeURIComponent(orderId)}`, { query: { market_ticker: ticker } });
  }

  async positions(): Promise<AccountPosition[]> {
    const out: AccountPosition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ market_positions: Array<Record<string, unknown>>; cursor?: string }>("GET", "/portfolio/positions", {
        query: { limit: 200, cursor },
      });
      for (const p of r?.market_positions ?? []) {
        out.push({
          ticker: String(p.ticker),
          position: num(p.position_fp),
          exposure: num(p.market_exposure_dollars),
          realizedPnl: num(p.realized_pnl_dollars),
          fees: num(p.fees_paid_dollars),
        });
      }
      cursor = r?.cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }
}
