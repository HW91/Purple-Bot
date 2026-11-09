-- Purple-Bot schema (single owner, Cloudflare D1)

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE bots (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  strategy   TEXT NOT NULL,              -- 'crypto' | 'metals'
  config     TEXT NOT NULL,              -- JSON, see BotConfig in src/types.ts
  enabled    INTEGER NOT NULL DEFAULT 0, -- bots always start OFF; only a person turns them on
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

-- 15-minute (or other) contracts found by market discovery
CREATE TABLE markets (
  ticker     TEXT PRIMARY KEY,
  asset      TEXT NOT NULL,
  series     TEXT NOT NULL,
  title      TEXT,
  open_ts    INTEGER NOT NULL,           -- unix ms
  close_ts   INTEGER NOT NULL,           -- unix ms
  status     TEXT,
  result     TEXT,                       -- 'yes' | 'no' once settled
  updated_ts INTEGER NOT NULL
);
CREATE INDEX idx_markets_close ON markets (close_ts);

-- Real Kalshi probability observations (never interpolated)
CREATE TABLE observations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker  TEXT NOT NULL,
  ts      INTEGER NOT NULL,              -- unix ms
  yes_bid REAL,
  yes_ask REAL,
  last    REAL
);
CREATE INDEX idx_obs_ticker_ts ON observations (ticker, ts);

-- Time ranges where the live feed was down (so gaps are recorded, not hidden)
CREATE TABLE data_gaps (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts   INTEGER NOT NULL,
  reason   TEXT
);

-- Every order we submit. id is our own client_order_id.
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  position_id      TEXT,
  ticker           TEXT NOT NULL,
  kind             TEXT NOT NULL,        -- 'entry' | 'exit'
  outcome          TEXT NOT NULL,        -- 'yes' | 'no' (the position being opened/closed)
  book_side        TEXT NOT NULL,        -- 'bid' | 'ask' (YES-leg side sent to Kalshi)
  price            REAL NOT NULL,        -- YES-leg limit price in dollars
  count_req        REAL NOT NULL,
  kalshi_order_id  TEXT,
  status           TEXT NOT NULL,        -- submitted | accepted | partially_filled | filled | canceled | rejected
  fill_count       REAL NOT NULL DEFAULT 0,
  avg_fill_price   REAL,                 -- YES-leg average fill price
  fee              REAL NOT NULL DEFAULT 0,
  error            TEXT,
  created_ts       INTEGER NOT NULL,
  updated_ts       INTEGER NOT NULL
);
CREATE INDEX idx_orders_bot ON orders (bot_id, created_ts);
CREATE INDEX idx_orders_pos ON orders (position_id);
-- Duplicate protection: at most one live/filled entry per bot per contract.
CREATE UNIQUE INDEX uq_entry_per_contract
  ON orders (bot_id, ticker)
  WHERE kind = 'entry' AND status IN ('submitted','accepted','partially_filled','filled');

CREATE TABLE positions (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  asset           TEXT NOT NULL,
  outcome         TEXT NOT NULL,         -- 'yes' | 'no'
  entry_qty       REAL NOT NULL DEFAULT 0,
  open_qty        REAL NOT NULL DEFAULT 0,
  avg_entry       REAL,                  -- price per contract of OUR outcome (NO price for NO trades)
  entry_cost      REAL NOT NULL DEFAULT 0,
  entry_fee       REAL NOT NULL DEFAULT 0,
  exit_proceeds   REAL NOT NULL DEFAULT 0,
  exit_fee        REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,         -- open | closed | settled
  opened_ts       INTEGER NOT NULL,
  closed_ts       INTEGER,
  close_reason    TEXT,                  -- stop_loss | take_profit | manual_close | emergency | settled
  market_close_ts INTEGER NOT NULL,
  entry_prob      REAL,                  -- favorable-direction probability at entry
  exit_prob       REAL,                  -- favorable-direction probability at exit/settlement
  fav_max         REAL,
  fav_min         REAL,
  prob_before_close REAL,
  agree_count     INTEGER,
  duration_min    INTEGER,
  realized_pnl    REAL,                  -- after fees
  result          TEXT                   -- 'win' | 'loss' | 'flat'
);
CREATE INDEX idx_positions_bot ON positions (bot_id, status);
CREATE INDEX idx_positions_open ON positions (status);

CREATE TABLE chat_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  bot_id     TEXT,                       -- NULL = whole account
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  role    TEXT NOT NULL,                 -- 'user' | 'assistant'
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX idx_chat_conv ON chat_messages (conv_id, id);

CREATE TABLE analyses (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  stats TEXT NOT NULL,                   -- JSON of the measured numbers the AI was given
  text  TEXT NOT NULL
);

-- Order/execution logs, control events (start/stop/shutdown), errors, notifications sent
CREATE TABLE logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL,                 -- info | warn | error
  kind    TEXT NOT NULL,                 -- order | control | error | notify | signal | system
  bot_id  TEXT,
  message TEXT NOT NULL,
  data    TEXT
);
CREATE INDEX idx_logs_ts ON logs (ts);
CREATE INDEX idx_logs_bot ON logs (bot_id, ts);

CREATE TABLE backtests (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  config     TEXT NOT NULL,
  from_ts    INTEGER NOT NULL,
  to_ts      INTEGER NOT NULL,
  report     TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
