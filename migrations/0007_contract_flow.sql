-- Money placed on each side of a contract, minute by minute, saved when the contract ends (from the live trade feed).
-- Feeds the AI overview and chat. Money counts for the side that started each trade (Kalshi's taker side).
CREATE TABLE contract_flow (
  ticker      TEXT PRIMARY KEY,
  asset       TEXT NOT NULL,
  open_ts     INTEGER NOT NULL,
  close_ts    INTEGER NOT NULL,
  yes_dollars REAL NOT NULL,
  no_dollars  REAL NOT NULL,
  minutes     TEXT NOT NULL,      -- JSON [[yesDollars, noDollars], ...] one pair per minute, minute 0 = contract open
  saved_ts    INTEGER NOT NULL
);
CREATE INDEX idx_contract_flow_close ON contract_flow (close_ts);
