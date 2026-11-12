-- Past contracts loaded from Kalshi's price history (not recorded by the bot). One row per contract so none is ever counted twice.
CREATE TABLE calibration_done (
  ticker     TEXT PRIMARY KEY,
  asset      TEXT NOT NULL,
  counted_ts INTEGER NOT NULL
);
