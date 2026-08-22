-- Fiat top-up rail (dual-rail, one meter). Idempotency + reconciliation ledger
-- for card-funded credit. The credits/credit_events tables are unchanged; a
-- Stripe top-up writes the SAME two rows the x402 path does (kind='topup'),
-- plus one row here keyed by the Stripe Checkout Session id so a replayed
-- webhook is a no-op (INSERT OR IGNORE -> changes==0 means already processed).
CREATE TABLE stripe_topups (
  session_id       TEXT PRIMARY KEY,      -- cs_... (Stripe Checkout Session)
  event_id         TEXT NOT NULL,         -- evt_... (the webhook event that credited)
  address          TEXT NOT NULL,
  amount_microusd  INTEGER NOT NULL,      -- credited amount (cents * 10_000)
  at               INTEGER NOT NULL
);
CREATE INDEX idx_stripe_topups_address ON stripe_topups (address);
