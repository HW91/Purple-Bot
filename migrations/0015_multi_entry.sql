-- A bot may now open several trades in one contract (up to its "entries per contract" setting). The duplicate protection moves from
-- "one entry per bot per contract" to "one entry per bot per contract per entry number", so a double-submit of the same entry is still refused.
ALTER TABLE orders ADD COLUMN entry_n INTEGER;
DROP INDEX uq_entry_per_contract;
CREATE UNIQUE INDEX uq_entry_seq
  ON orders (bot_id, ticker, entry_n)
  WHERE kind = 'entry' AND entry_n IS NOT NULL AND status IN ('submitted','accepted','partially_filled','filled');
