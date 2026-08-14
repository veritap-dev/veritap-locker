-- Veritap Locker initial schema — spec §14.4 verbatim, plus rate_counters
-- (§8 free-path limits need somewhere to count) .

CREATE TABLE keys (
  address TEXT NOT NULL, enc_pubkey TEXT NOT NULL, wallet_sig TEXT NOT NULL,
  require_e2e INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (address, registered_at)
);
CREATE TABLE messages (
  message_id TEXT PRIMARY KEY, address TEXT NOT NULL,
  producer TEXT, tag TEXT, content_type TEXT NOT NULL,
  size INTEGER NOT NULL, inline_body BLOB, r2_key TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, acked_at INTEGER,
  idempotency_key TEXT, body_hash TEXT NOT NULL, paid_microusd INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_msg_inbox ON messages(address, acked_at, created_at);
CREATE INDEX idx_msg_expiry ON messages(expires_at) WHERE acked_at IS NULL;
CREATE UNIQUE INDEX idx_msg_idem ON messages(address, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_msg_bodyhash ON messages(address, body_hash, created_at);

CREATE TABLE checkpoints (
  address TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
  r2_key TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (address, slot, version)
);
CREATE TABLE credits (
  address TEXT PRIMARY KEY, balance_microusd INTEGER NOT NULL DEFAULT 0,
  grace_started_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE credit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup','burn','grace','expire')),
  amount_microusd INTEGER NOT NULL, at INTEGER NOT NULL, note TEXT
);
CREATE TABLE nonces (
  nonce_hash TEXT PRIMARY KEY, address TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE delegations (
  token_hash TEXT PRIMARY KEY, address TEXT NOT NULL,
  scope_json TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, meta TEXT
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, kind TEXT NOT NULL,
  description TEXT NOT NULL, would_pay_usd REAL, created_at INTEGER NOT NULL
);
-- §8 free-path rate limits (nonce 60/hr, reads 600/hr, count 60/hr, sig-fail backoff).
CREATE TABLE rate_counters (
  bucket TEXT NOT NULL, window_start INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
