-- #788: adoption funnel instrumentation.
-- metrics: durable daily counters (rate_counters is GC'd; funnel history must survive).
CREATE TABLE IF NOT EXISTS metrics (
  k TEXT NOT NULL,          -- e.g. disc:tools_list, disc:capabilities, quote402:message
  day TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);

-- addresses_seen: every wallet that ever touched us, by interaction kind.
-- New-wallets-per-day is the adoption curve.
CREATE TABLE IF NOT EXISTS addresses_seen (
  address TEXT NOT NULL,
  kind TEXT NOT NULL,       -- nonce | auth | recipient | payer | directory
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (address, kind)
);

-- who paid for a message (known post-settle) — lets the dashboard split
-- self-traffic (test wallets) from real adoption structurally.
ALTER TABLE messages ADD COLUMN payer TEXT;
