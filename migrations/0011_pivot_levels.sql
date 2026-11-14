-- Daily pivot levels per asset, worked out once per (US Eastern) day from the previous trading day's contract prices.
CREATE TABLE pivot_levels (
  asset   TEXT NOT NULL,
  day     TEXT NOT NULL,   -- the day these levels apply to (YYYY-MM-DD, US Eastern)
  src_day TEXT NOT NULL,   -- the day whose high, low and close they were made from
  high    REAL NOT NULL,
  low     REAL NOT NULL,
  close   REAL NOT NULL,
  samples INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (asset, day)
);
