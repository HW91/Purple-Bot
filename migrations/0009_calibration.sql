-- How often contracts priced at a given level actually settled YES, learned from the bot's own recorded history.
-- One count per settled contract, per asset, per minute-before-close, per 2.5% price level of the YES mid price.
CREATE TABLE calibration (
  asset       TEXT NOT NULL,
  minute_left INTEGER NOT NULL,   -- whole minutes left when the price was seen (0 = the last minute)
  bucket      INTEGER NOT NULL,   -- floor(yes_mid * 40): 0 = 0% to 2.5%, 39 = 97.5% to 100%
  n           INTEGER NOT NULL DEFAULT 0,
  yes_wins    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset, minute_left, bucket)
);
-- 1 once a settled contract has been counted into the table above (so each contract is counted exactly once)
ALTER TABLE markets ADD COLUMN calibrated INTEGER NOT NULL DEFAULT 0;
