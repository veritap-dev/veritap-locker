-- #767: owner-set count privacy (opt-in, same shape as require_e2e), and
-- receipt-vault product tracking so the ledger separates vault demand from
-- generic sends (#767.1).
ALTER TABLE keys ADD COLUMN private_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN product TEXT NOT NULL DEFAULT 'message';
CREATE INDEX IF NOT EXISTS idx_msg_product ON messages(product, created_at);
