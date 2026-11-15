-- The target price of each contract (Kalshi's floor strike), so the chart can show how far the live asset price is from it.
ALTER TABLE markets ADD COLUMN strike REAL;
