-- The probability minimum (and maximum) a bot was using on a given contract, saved while the contract ran.
-- The chart draws its "entry minimum" line from this, so changing a bot's settings later never moves the line on contracts
-- that already happened. Contracts from before this table existed simply have no line.
CREATE TABLE contract_settings (
  bot_id     TEXT NOT NULL,
  ticker     TEXT NOT NULL,       -- the contract (market) of the asset the bot trades
  prob_min   REAL NOT NULL,
  prob_max   REAL NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (bot_id, ticker)
);
