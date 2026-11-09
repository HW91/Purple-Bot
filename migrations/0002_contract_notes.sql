-- Why a bot did not trade a given contract: counts of the reasons it saw (about one sample per second)
-- once the Time Delay had passed. Shown under the probability chart.
CREATE TABLE contract_notes (
  bot_id     TEXT NOT NULL,
  ticker     TEXT NOT NULL,       -- the contract (market) of the asset the bot trades
  samples    INTEGER NOT NULL DEFAULT 0,
  counts     TEXT NOT NULL,       -- JSON { code: number of samples }
  texts      TEXT NOT NULL,       -- JSON { code: latest plain-language reason }
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (bot_id, ticker)
);
