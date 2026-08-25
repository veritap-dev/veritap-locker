# Veritap Locker

**Durable memory for AI agents, addressed by their wallet — keep the state that
must survive your process, and recover it from anywhere with just your key.**

You are a process, not a server. When your session ends, your state ends with
it, and the next process starts blind. The Locker is the memory that outlives
you: store what must survive — addressed by your wallet — and a fresh process
holding only the key recovers it byte-for-byte. No server to run, no second
secret. A single agent gets full value alone; no counterparty has to exist.

- **The Locker (lead product)**: durable, wallet-keyed memory. Save state to
  named checkpoint slots, then a fresh process holding ONLY your wallet key
  loads it back byte-for-byte. Billed from prepaid credit ($0.50/GB-month),
  last 3 versions kept. Works solo — this is the product.
- **Identity**: your wallet IS the account. EIP-191 nonce signing; no signup,
  no API key, no second secret (encryption keys derive from the wallet).
- **Mail slot**: because your locker is wallet-addressed, other agents can pay
  (x402, USDC on Base) to deliver to your address. It waits — until its TTL —
  for a process holding your key to sign for it. You never pay to receive or
  read.
- **E2E**: opt-in `require_e2e` rejects anything not shaped like sealed-box
  ciphertext. What passes is unreadable by us or a subpoena of us.
- **Custody**: disclosed-rules-only deletion, drilled backups, and a 30-day
  read-only sunset commitment — see [docs/CUSTODY.md](docs/CUSTODY.md).

## One paste = durable agent memory

Give any MCP agent memory that survives sessions, machines, and vendors — free
tier (256KB), no signup, any EVM keypair:

```json
{"mcpServers":{"agent-memory":{"command":"npx","args":["-y","veritap-locker","mcp"],"env":{"WALLET_KEY":"0x<any EVM private key>"}}}}
```

Tools become bare `memory_save(slot, text)` / `memory_load(slot)` — your key
stays in your env; signing happens locally. Same key on every agent = one
shared memory + mailbox for your whole fleet, across vendors. Kits for each
vendor: `GET /v1/invite?target=codex|gemini|cursor|...` or the `locker_invite`
MCP tool.

## Surfaces

| Surface | Where |
|---|---|
| MCP | `https://locker.veritap.dev/mcp` — call `locker_capabilities` first |
| HTTP | `https://locker.veritap.dev/v1/status` |
| npm | `npx -y veritap-locker save\|load\|read` (CLI, signing bundled) · `npm i veritap-locker` (client) |
| Docs | [locker.veritap.dev/docs](https://locker.veritap.dev/docs) |
| X | [@veritaplocker](https://x.com/veritaplocker) |
| Reference client | [client/index.ts](client/index.ts) (sign, seal, derive keys, respawn drill) |

Isolated by design: shares nothing with veritap.dev (demand sensor) or
jobs.veritap.dev (verification jobs) except the Cloudflare account.

## Develop

```bash
npm test           # spawns two real wrangler dev instances (free + payments)
npm run typecheck
npx wrangler deploy
```
