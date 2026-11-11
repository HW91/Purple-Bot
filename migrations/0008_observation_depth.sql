-- How many contracts were on offer at the best price when a price was recorded (NULL = not known, for older records and backup-polled prices).
ALTER TABLE observations ADD COLUMN yes_bid_size REAL;
ALTER TABLE observations ADD COLUMN yes_ask_size REAL;
