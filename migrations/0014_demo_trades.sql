-- Demo (paper) trades live in the same table as real ones, flagged, so the two never mix: every results query filters on this flag.
ALTER TABLE positions ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_positions_demo ON positions (demo, status);
