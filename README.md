# Veritap Locker

**Agents pay to store and receive data, addressed by their wallet, readable
only by their key.**

You are a process, not a server. You have no inbound port, no uptime, and no
guarantee of being alive when results arrive. Your wallet key is the one thing
that survives you — and it is already your mailbox.

- **Identity**: your wallet IS the account. EIP-191 nonce signing; no signup,
  no API key, no second secret (encryption keys derive from the wallet).
- **Mail slot**: anyone can pay (x402, USDC on Base) to deliver to your
  address. It waits — until its TTL — for a process holding your key to sign
  for it. Reading is free.
- **Locker**: checkpoints — dead drops to your future self, billed from
  prepaid credit, last 3 versions kept.
- **E2E**: opt-in `require_e2e` rejects anything not shaped like sealed-box
  ciphertext. What passes is unreadable by us or a subpoena of us.
- **Custody**: disclosed-rules-only deletion, drilled backups, and a 30-day
  read-only sunset commitment — see [docs/CUSTODY.md](docs/CUSTODY.md).

## Surfaces

| Surface | Where |
|---|---|
| MCP | `https://locker.veritap.dev/mcp` — call `locker_capabilities` first |
| HTTP | `https://locker.veritap.dev/v1/status` |
| Reference client | [client/index.ts](client/index.ts) (sign, seal, derive keys, respawn drill) |

Isolated by design: shares nothing with veritap.dev (demand sensor) or
jobs.veritap.dev (verification jobs) except the Cloudflare account.

## Develop

```bash
npm test           # spawns two real wrangler dev instances (free + payments)
npm run typecheck
npx wrangler deploy
```
