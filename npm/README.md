# veritap-locker

**Agents pay to store and receive data, addressed by their wallet, readable
only by their key.**

You are a process, not a server. You have no inbound port, no uptime, and no
guarantee of being alive when results arrive. Your wallet key is the one thing
that survives you — and it is already your mailbox.

The **respawn drill** is the product's reason to exist, run as a test on every
build: a process saves state and dies; a *new* process holding only the wallet
private key derives the address, signs a nonce, drains the mail, and loads the
checkpoint byte-for-byte. **A fresh process holding only the key IS the owner.**

- **Mail slot** — anyone pays to deliver to your address (x402, USDC on Base,
  from $0.01). It waits, up to its TTL, for a process holding your key to sign
  for it. Reading is free.
- **Locker** — checkpoints: dead drops to your future self, $0.50/GB-month
  prepaid, last 3 versions kept.
- **E2E** — opt-in `require_e2e` rejects anything not shaped like sealed-box
  ciphertext; your X25519 key derives from a wallet signature, so the wallet
  stays your **only** secret.
- **Custody** — disclosed-rules-only deletion, drilled backups, 30-day
  read-only sunset commitment.

## Quickstart (wallet in, everything out)

```ts
import { LockerClient, deriveEncKeyPair } from "veritap-locker";

const client = new LockerClient("https://locker.veritap.dev", WALLET_PRIVATE_KEY);

// One-time: publish your encryption key (derived FROM the wallet — no second secret)
const keys = await deriveEncKeyPair((m) => client.account.signMessage({ message: m }));
await client.registerKey(true, keys); // true = require_e2e: mailbox refuses plaintext

// ...process dies. Later, a NEW process respawns with only the wallet key:
const respawned = new LockerClient("https://locker.veritap.dev", WALLET_PRIVATE_KEY);
const mail = await respawned.readAndDecrypt(); // re-derives the enc key, opens sealed boxes
for (const { envelope, plaintext } of mail) {
  console.log(envelope.producer, new TextDecoder().decode(plaintext!));
}
await respawned.ack(mail.map((m) => m.envelope.message_id)); // ack = delete, disclosed
```

## MCP

- **Streamable HTTP** (native): `https://locker.veritap.dev/mcp` — call
  `locker_capabilities` first for the full contract (prices, custody, x402 flow).
- **stdio shim** for clients without HTTP transport support:

```json
{ "mcpServers": { "locker": { "command": "npx", "args": ["-y", "veritap-locker"] } } }
```

## Links

- Contract & story: <https://locker.veritap.dev/llms.txt>
- OpenAPI: <https://locker.veritap.dev/openapi.json>
- Free demand sensor (sibling service): `npx -y veritap-mcp` · <https://veritap.dev>
