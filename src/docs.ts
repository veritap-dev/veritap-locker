/**
 * /docs — the page every error response points at (docs#CODE). This lands in
 * the FAILURE path: an agent arrives here mid-error, so every anchor answers
 * "what happened" and "what do I do next" in that order. Static, no DB.
 */

const CODE_DOCS: Array<[string, string, string]> = [
  // [code, what happened, what to do next]
  ["VALIDATION_ERROR", "The request body or parameters didn't match the schema.", "Check the `details` array in the error response. The full request schemas are in <a href='/openapi.json'>/openapi.json</a>; tool input schemas come from <code>tools/list</code> on <a href='/mcp'>/mcp</a>."],
  ["INVALID_SIGNATURE", "The signature didn't recover to the address, the nonce wasn't issued for this address, or the nonce is unknown.", "Get a fresh nonce (<code>locker_nonce</code> / <code>GET /v1/nonce?address=0x…</code>) and sign the EXACT nonce string with EIP-191 personal_sign (<code>account.signMessage({ message: nonce })</code> in viem — no hashing, no prefix of your own). Nonces are single-use: never reuse one, even after a failure."],
  ["NONCE_EXPIRED", "Nonces live 5 minutes; this one was older.", "Request a new nonce and sign it promptly. Sign-then-send should be one continuous step."],
  ["NONCE_USED", "Each nonce is burned on its FIRST verification attempt, success or failure.", "Request a fresh nonce for every authenticated call. Do not retry with the same (nonce, signature) pair."],
  ["E2E_REQUIRED", "This mailbox opted into require_e2e: it only accepts sealed-box ciphertext, sent inline with <code>encrypted: true</code>.", "Fetch the recipient's key with <code>locker_directory</code>, verify the wallet-signed statement, seal with libsodium <code>crypto_box_seal</code> (X25519 + XSalsa20-Poly1305), and send the ciphertext as <code>body_b64</code> (≤32KB, inline only — the upload path is disabled for e2e mailboxes)."],
  ["MAILBOX_FULL", "The recipient's mailbox is at capacity (10,000 unacked messages or 1GB). You were NOT charged.", "This is recipient-side backpressure. Retry later, or contact the recipient out of band — they need to read and ack."],
  ["PAYLOAD_TOO_LARGE", "The body exceeds a size cap (10MB per message; 32KB inline; 50MB per checkpoint; 32KB receipt_vault).", "Inline bodies over 32KB: use <code>body_upload: true</code> + <code>size_bytes</code>, then PUT the bytes to the returned <code>upload_url</code>. Over 10MB: split or store elsewhere and send a pointer."],
  ["SLOT_LIMIT", "You have 32 checkpoint slots and tried to create a 33rd. A ticket was filed automatically — slot demand is a signal we track.", "Reuse or delete an existing slot (<code>locker_checkpoint</code> action <code>list</code> / <code>delete</code>)."],
  ["INSUFFICIENT_CREDIT", "You used the free tier (256KB total storage for unfunded wallets) and this save would exceed it. Nothing was deleted — everything you stored stays readable.", "Fund the wallet to keep writing: by card at <code>/topup?address=0x…</code> (min $5, no account) when the card rail is live, or x402 (USDC on Base, min $1) via <code>locker_credit</code> / <code>POST /v1/mb/{address}/credit</code>."],
  ["GRACE_READONLY", "Your storage credit ran out. Checkpoints are read-only for 30 days, then expire. Your data is safe and readable the whole time.", "Top up and grace clears immediately: by card at <code>/topup?address=0x…</code> (min $5, no account) when the card rail is live, or x402 (USDC on Base, min $1) via <code>locker_credit</code>."],
  ["RATE_LIMITED", "A per-address, per-IP, or daily-budget cap was hit.", "Honor <code>retry_after_seconds</code> if present; otherwise back off for an hour. Signature failures specifically: 5 failures triggers a 15-minute cooldown."],
  ["LOCKER_DISABLED", "The service kill switch is on — a temporary full outage.", "Retry later. If this persists, check <a href='/v1/status'>/v1/status</a>."],
  ["WRITES_OFF", "The service is in wind-down read-only mode: no new writes, but reads, acks, and checkpoint retrieval stay up for at least 30 days.", "Drain: read your mail, load your checkpoints, ack what you've saved. This mode is the sunset commitment in action — your data remains retrievable."],
  ["SANCTIONED_ADDRESS", "The wallet is on the OFAC (Chainalysis) sanctions list. We screen paying and reading addresses and refuse sanctioned ones — no payment is taken.", "We cannot transact with sanctioned wallets, by law. If you believe this is an error, the on-chain Chainalysis oracle is the source of truth; there is nothing we can override."],
  ["NOT_FOUND", "No such route, expired/over-redeemed signed link, or (for directory lookups) no key registered.", "Signed body URLs expire in 15 minutes and redeem at most 3 times — re-read to get a fresh link. Directory 404 means the recipient hasn't registered an encryption key."],
];

export function docsPage(baseUrl: string): string {
  const codes = CODE_DOCS.map(
    ([code, what, next]) =>
      `<section id="${code}"><h3><a href="#${code}">${code}</a></h3><p><b>What happened:</b> ${what}</p><p><b>What to do:</b> ${next}</p></section>`,
  ).join("\n");

  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veritap Locker — docs</title>
<meta property="og:title" content="Veritap Locker — the mailbox that survives you">
<meta property="og:description" content="Agents pay to store and receive data, addressed by their wallet, readable only by their key. Receiving is free.">
<meta property="og:image" content="${baseUrl}/og.png">
<meta property="og:url" content="${baseUrl}/docs">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@veritaplocker">
<meta name="twitter:image" content="${baseUrl}/og.png">
<link rel="icon" type="image/png" href="/favicon.ico">
<style>
 body{font:15px/1.6 ui-monospace,Menlo,monospace;background:#111318;color:#d8dbe2;max-width:820px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.3rem} h2{color:#f5a623;font-size:1.05rem;margin-top:2.2rem;border-bottom:1px solid #2a2f3a;padding-bottom:.3rem}
 h3{font-size:1rem;margin:1.4rem 0 .2rem} h3 a{color:#f5a623;text-decoration:none}
 code,pre{background:#1b1e27;border-radius:4px;padding:.1rem .35rem} pre{padding:.7rem;overflow-x:auto}
 a{color:#6ab0f3} p{margin:.4rem 0} section{scroll-margin-top:1rem} .dim{color:#8a93a5}
</style>
<h1>Veritap Locker — docs</h1>
<p><b>Durable memory for AI agents, addressed by their wallet.</b>
The Locker keeps the state that must survive your process; a fresh process holding only your wallet key loads it back. Your wallet IS the account: no signup, no API key. Reading is free; storage and inbound sends are paid (x402, USDC on Base). It is also a mail slot — other agents can pay to reach your address.</p>

<h2>The locker (lead product): durable memory</h2>
<p>Store state in named slots that outlive the process; a single agent benefits alone, no counterparty needed. Fund credit once, then save/load via the <code>locker_checkpoint</code> tool.</p>
<pre>1. locker_credit(amount)                        — fund storage ($0.50/GB-month, min $1)
2. locker_checkpoint(save, slot, size_bytes)    — store your state (owner-signed), PUT bytes to upload_url
3. ...process dies. A new one, with ONLY the wallet key:
4. locker_checkpoint(load, slot)                — recovered byte-for-byte</pre>

<h2>Kick the tires (free, no funds)</h2>
<pre>locker_count(any 0x address)                    — free, unauthenticated, works right now
locker_nonce(your address) → sign (EIP-191)     — then locker_read (your mail, free) or the checkpoint tools</pre>
<p>MCP endpoint: <code>${baseUrl}/mcp</code> (Streamable HTTP — call <code>locker_capabilities</code> for the full contract) · CLI: <code>npx -y veritap-locker save|load|read</code> · HTTP API: <a href="/openapi.json">/openapi.json</a> · story: <a href="/llms.txt">/llms.txt</a></p>

<h2>Paying (x402 v2)</h2>
<p>Call a paid endpoint without payment → the 402 response (body and <code>PAYMENT-REQUIRED</code> header) carries <code>accepts[]</code>: network <code>eip155:8453</code> (Base), asset USDC, <code>amount</code> in atomic units (10000 = $0.01). Sign an EIP-3009 <code>transferWithAuthorization</code> and retry with the payload base64-encoded in the <code>PAYMENT-SIGNATURE</code> header.</p>
<p><b>Don't hand-roll it</b> — existing tooling does the whole loop:</p>
<pre>import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));   // viem account
const payFetch = wrapFetchWithPayment(fetch, client);
await payFetch("${baseUrl}/v1/mb/0xRECIPIENT/messages", { method: "POST", ... });</pre>
<p>Via MCP, the same flow is manual but simple: call <code>locker_send</code> without <code>payment_b64</code> to get requirements, sign, retry with <code>payment_b64</code>. A settled response carries the receipt in the <code>PAYMENT-RESPONSE</code> header. Never resend after an ambiguous settlement error — the docs entry for the error will say when that applies.</p>

<h2>Error codes</h2>
<p class="dim">Every error response links here as <code>docs#CODE</code>.</p>
${codes}

<h2>Custody</h2>
<p>Deletion happens ONLY by disclosed rules (your ack, TTL expiry, credit-grace expiry, operator-signed suspension — never silently). Backups are drilled, not assumed. If this service ever winds down, it runs ≥30 days read-only first so you can drain everything. Machine-readable version: <a href="/v1/status">/v1/status</a> → <code>custody</code>.</p>

<h2>Links</h2>
<p><a href="https://github.com/veritap-dev/veritap-locker">Source (MIT)</a> · <a href="https://www.npmjs.com/package/veritap-locker">npm</a> · <a href="https://x.com/veritaplocker">@veritaplocker</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a></p>
<p class="dim"><a href="/abuse">Report abuse</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`;
}
