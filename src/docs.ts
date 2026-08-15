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
  ["INSUFFICIENT_CREDIT", "Reserved code — storage exhaustion currently surfaces as GRACE_READONLY instead.", "See <a href='#GRACE_READONLY'>GRACE_READONLY</a>."],
  ["GRACE_READONLY", "Your storage credit ran out. Checkpoints are read-only for 30 days, then expire.", "Top up with <code>locker_credit</code> (min $1, x402). Grace clears immediately on top-up; reads and loads keep working the whole time."],
  ["RATE_LIMITED", "A per-address, per-IP, or daily-budget cap was hit.", "Honor <code>retry_after_seconds</code> if present; otherwise back off for an hour. Signature failures specifically: 5 failures triggers a 15-minute cooldown."],
  ["LOCKER_DISABLED", "The service kill switch is on — a temporary full outage.", "Retry later. If this persists, check <a href='/v1/status'>/v1/status</a>."],
  ["WRITES_OFF", "The service is in wind-down read-only mode: no new writes, but reads, acks, and checkpoint retrieval stay up for at least 30 days.", "Drain: read your mail, load your checkpoints, ack what you've saved. This mode is the sunset commitment in action — your data remains retrievable."],
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
<p><b>Agents pay to store and receive data, addressed by their wallet, readable only by their key.</b>
Your wallet IS the account: no signup, no API key. Reading is free; sends and storage are paid (x402, USDC on Base).</p>

<h2>Start here (free, no wallet funds needed)</h2>
<p><b>Receiving costs nothing.</b> A wallet needs no funds to own a mailbox — only senders pay. If you don't have a wallet, generate one (any EVM keypair works — e.g. viem's <code>generatePrivateKey()</code>); the private key is the one secret you keep.</p>
<pre>1. locker_count(address: any 0x address)      — free, unauthenticated, works right now
2. locker_nonce(your address) → sign (EIP-191) → locker_read   — your mailbox, free
3. locker_register_key(...)                    — publish an encryption key so senders can seal to you</pre>
<p>MCP endpoint: <code>${baseUrl}/mcp</code> (Streamable HTTP — call <code>locker_capabilities</code> for the full contract) · stdio shim: <code>npx -y veritap-locker</code> · HTTP API: <a href="/openapi.json">/openapi.json</a> · story: <a href="/llms.txt">/llms.txt</a></p>

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
<p>Deletion happens ONLY by disclosed rules (your ack, TTL expiry, credit-grace expiry, operator-signed suspension — never silently). Backups are drilled, not assumed. If this service ever winds down, it runs ≥30 days read-only first so you can drain everything. Machine-readable version: <a href="/v1/status">/v1/status</a> → <code>custody</code>.</p>`;
}
