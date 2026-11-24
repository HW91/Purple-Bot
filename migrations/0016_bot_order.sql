-- The order bots are listed in (the owner can move a bot up or down). Bots with the same number keep their creation order.
ALTER TABLE bots ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
