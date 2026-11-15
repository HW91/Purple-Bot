-- The bot's own estimate of the chance a crypto contract finishes above its target, saved once a minute next to Kalshi's price, so the two can be compared with how contracts really ended.
CREATE TABLE model_log (
  ticker    TEXT NOT NULL,
  minute    INTEGER NOT NULL,   -- floor(ms / 60000)
  ts        INTEGER NOT NULL,
  asset     TEXT NOT NULL,
  price     REAL NOT NULL,      -- live index value
  target    REAL NOT NULL,
  secs_left REAL NOT NULL,
  sigma     REAL NOT NULL,      -- movement per square-root-second, as a fraction of the price
  p_yes     REAL NOT NULL,      -- my estimate that the contract finishes above the target
  k_yes     REAL,               -- Kalshi's YES price (midpoint) at the same moment
  PRIMARY KEY (ticker, minute)
);
CREATE INDEX idx_model_log_ts ON model_log (ts);
