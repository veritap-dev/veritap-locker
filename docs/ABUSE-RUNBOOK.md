# Abuse Runbook (board #804)

How abuse reports are handled. Written before it's needed so the duty is on
paper, not improvised.

## Intake

- **Email:** abuse@veritap.dev (Cloudflare Email Routing → operator inbox).
- **Web:** `GET /abuse` (form) → `POST /abuse` files an `abuse_report` ticket
  in the `tickets` table with a timestamp and a reference `AB-<id>`.
- Every report is logged. Reference the ticket id in all follow-up.

Query open reports:

```bash
npx wrangler d1 execute veritap_locker --remote \
  --command "SELECT id, wallet, description, created_at FROM tickets WHERE kind='abuse_report' ORDER BY created_at DESC LIMIT 50"
```

## What we can see (and can't)

- **require_e2e messages** are sealed-box ciphertext. We cannot read them and
  must not claim to. We can act on metadata (address, timing) only.
- **Plaintext-tier messages** are readable. Content-based duties attach here.

## Action space

Deliberately narrow: **whole-address suspension**, operator-signed, logged as a
`state_transition`. We do not surgically edit mailboxes. Suspension stops new
sends to/from the address; disclosed deletion rules still govern existing data.

To suspend an address (operator, manual):

```bash
# Record the decision, then apply the block per the current suspension mechanism.
npx wrangler d1 execute veritap_locker --remote \
  --command "INSERT INTO state_transitions (at, entity, entity_id, from_state, to_state, meta) VALUES (strftime('%s','now'),'address','<0xADDR>','active','suspended','abuse AB-<id>')"
```

## Response time

Acknowledge within **72 hours**; act on clear violations promptly. Child-safety
reports are immediate (below).

## CSAM — immediate escalation (U.S. law)

If an abuse report gives us **actual knowledge** of child sexual abuse material
in a **plaintext-tier** body:

1. **Preserve** the evidence (do NOT delete the message; snapshot the r2_key /
   inline body and the envelope metadata to secure operator storage).
2. **Report** to the NCMEC CyberTipline at <https://report.cybertip.org> (U.S.
   providers are required to report on actual knowledge, 18 U.S.C. § 2258A).
3. **Suspend** the address (above) and preserve associated records.
4. **Document** the report id, timestamps, and actions in the ticket.

We **cannot** have knowledge of require_e2e (encrypted) contents and make no
representation that we monitor them; this duty attaches only to plaintext
bodies where knowledge is actually possible.

## Sanctions

Paying and reading wallets are screened against the Chainalysis OFAC oracle in
code (`SANCTIONED_ADDRESS`, 403). No manual step needed; screening is automatic
and cached. A hard-down oracle fails open and logs `OFAC_SCREEN_FAILED` — treat
repeated failures as an ops alert.
