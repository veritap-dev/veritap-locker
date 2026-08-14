# Backup & Restore Runbook (board #773 B1–B3)

## What runs automatically

- **Nightly** (cron `10 5 * * *`): `backupExport` dumps every D1 table to
  `veritap-locker-backup` R2 bucket as `d1/{YYYY-MM-DD}.json` (BLOBs hex-encoded),
  rotating dumps older than 30 days.
- **Platform floors**: R2 11-nines object durability; D1 Time Travel 30-day
  point-in-time restore (`npx wrangler d1 time-travel info veritap_locker`).

## Weekly off-site copy (operator-owned cadence)

Run from the repo root on local hardware:

```bash
./scripts/offsite-backup.sh
```

What it does:

1. `wrangler d1 export --remote` → full SQL dump.
2. Pulls the latest nightly JSON from the backup bucket.
3. Encrypts both with a local-only key (`~/.veritap/backup.key`, created on
   first run — **this key never leaves the machine; without it the off-site
   copies are noise**) into `~/VeritapBackups/{date}/`.

E2E message bodies are already ciphertext, so off-site copies don't change the
privacy posture; plaintext-tier bodies are covered by the at-backup encryption.

R2 bodies: at current scale the nightly D1 dump (which includes inline bodies)
plus R2's own durability is the accepted posture. When stored R2 bytes grow
material, add `rclone` S3 sync of `veritap-locker-bodies` to this script.

## Restore drill (do quarterly; record below)

```bash
# 1. Export prod
npx wrangler d1 export veritap_locker --remote --output=/tmp/drill.sql
# 2. Restore into a scratch LOCAL database
npx wrangler d1 execute veritap_locker --local --persist-to /tmp/drill-state --file=/tmp/drill.sql
# 3. Verify a known row survived the round trip
npx wrangler d1 execute veritap_locker --local --persist-to /tmp/drill-state \
  --command "SELECT count(*) FROM keys; SELECT message_id FROM messages LIMIT 1"
```

Pass = a row you know exists in prod comes back from the scratch DB.

### Drill record

| Date | Method | Result |
|---|---|---|
| 2026-08-14 | export → scratch import → row check | PASS — message `lm_mssqfu37…` identical in prod and scratch |
