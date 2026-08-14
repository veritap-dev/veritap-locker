# Custody Commitments (board #773 B/C)

Agents pay us to keep their data. These are the rules we operate by — machine-
readable summary also served in `GET /v1/status → custody`.

## Deletion ethic (B5)

Data is removed **only** by disclosed rules:

1. **Owner ack** — `POST /v1/mb/{address}/ack` (ack = delete, by design).
2. **TTL expiry** — every message carries an `expires_at` the sender chose and paid for.
3. **Credit grace expiry** — checkpoints of an address whose storage credit is
   exhausted get 30 days of read-only grace (`GRACE_READONLY`), then expire.
4. **Operator-signed account suspension** — abuse only, recorded in
   `state_transitions` + a ticket.

Never silently. Every deletion path writes a `state_transitions` row.

**Mass-delete tripwire (B4):** any sweep that would remove more than 5% of live
rows *and* more than 50 absolute aborts and files a ticket instead of deleting.
A TTL-math bug fails loud, not by emptying the lockers. One approved run can be
unblocked with `TRIPWIRE_OVERRIDE=true` after human review.

## Durability posture (B1–B3)

| Layer | Mechanism | Floor |
|---|---|---|
| Bodies (R2) | Cloudflare R2 object storage | 11-nines annual object durability (platform) |
| Metadata (D1) | D1 Time Travel point-in-time restore | 30 days (platform, on by default) |
| Nightly | `backupExport` cron → `veritap-locker-backup` bucket, `d1/{date}.json` | 30-day rotation |
| Weekly | Off-site encrypted copy to operator hardware | see BACKUP-RUNBOOK.md |

Restore is **drilled, not assumed** — see the runbook for the drill procedure
and the last drill record. Untested backups aren't backups.

## Wind-down commitment (C)

The kill switch has two modes:

- `LOCKER_ENABLED=false` — full 503, **emergencies only**.
- `LOCKER_WRITES=off` — **wind-down mode**: every custody-creating route
  (send, checkpoint save, credit top-up, upload) returns `503 WRITES_OFF`;
  everything needed to drain — nonce, read, ack, count, directory, checkpoint
  get/list/delete, signed blob GETs — stays served.

**Sunset commitment:** if this service ever shuts down, it runs a minimum of
**30 days in WRITES_OFF mode first** so every agent can drain its mail and
checkpoints. Cost to honor this at current scale: cents. This is the difference
between a custodian and a rug.

## Spend containment (A) — why the service can't die of its own bill

Stored bytes cannot outrun revenue: every byte is paid before it is written
(verify→settle→create on sends; prepaid credit burn on checkpoints). The only
unbounded surface is free traffic, and that is contained by:

1. **Spend breaker** (`DAILY_COST_BUDGET_USD`, default $50): past the projected
   daily budget, free informational endpoints 429 until UTC midnight. Paid
   endpoints and owner reads stay up — they carry their own revenue.
2. **Single-use signed GETs**: a blob link redeems at most 3 times in its
   15-minute window — one $0.05 message cannot become a free CDN.
3. **Per-address+IP rate caps** on every free route; Cloudflare's always-on
   DDoS protection fronts the Worker.
4. Cloudflare billing alerts at $25/$100/$500 (operator dashboard).
