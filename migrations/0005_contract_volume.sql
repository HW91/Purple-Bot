-- Volume (trades / contracts / dollars on YES and NO, by minute) for a contract. Only saved once the contract has been closed for
-- a few minutes, because its trades can no longer change; the open contract is always fetched fresh.
CREATE TABLE contract_volume (
  ticker     TEXT PRIMARY KEY,
  data       TEXT NOT NULL,   -- JSON of the Volume object (src/volume.ts)
  fetched_ts INTEGER NOT NULL
);
