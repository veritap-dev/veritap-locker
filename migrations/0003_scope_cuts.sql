-- Audit scope-creep cuts (board #767/#774): remove dead schema before the MCP
-- wrapper calcifies it. `delegations` has no read/write path anywhere and
-- contradicts the one-secret thesis (#771); `would_pay_usd` was declared and
-- never written. SQLite DROP COLUMN is supported (>=3.35); table drop is clean.
DROP TABLE IF EXISTS delegations;
ALTER TABLE tickets DROP COLUMN would_pay_usd;
