/**
 * Bazaar-trigger smoke: one real $0.01 purchase WITH the extensions echo the
 * spec requires ("clients echo them in PaymentPayload") — @x402/fetch doesn't
 * do this on its own, which may be why two prior settles never cataloged.
 * Manual 402 flow so we control the envelope; the EIP-3009 signature covers
 * only the transfer authorization, so adding `extensions` is legitimate.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const BASE = process.env.LOCKER_BASE ?? "https://locker.veritap.dev";
const key = readFileSync(new URL("../test/fixtures/buyer.key", import.meta.url), "utf8").trim();
const account = privateKeyToAccount(key);
console.log("buyer:", account.address);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));

const url = `${BASE}/v1/mb/${account.address}/messages`;
const body = JSON.stringify({
  producer: "veritap-smoke",
  tag: "bazaar-echo",
  content_type: "text/plain",
  body_b64: Buffer.from(`bazaar echo smoke ${new Date().toISOString()}`).toString("base64"),
  idempotency_key: `bazaar-echo-${Date.now()}`,
});

// 1. Get the 402 + PaymentRequired (header is authoritative in v2).
const r1 = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
const paymentRequired = JSON.parse(Buffer.from(r1.headers.get("payment-required"), "base64").toString());
console.log("402 extensions declared:", Object.keys(paymentRequired.extensions ?? {}));

// 2. Sign the payment.
const payload = await client.createPaymentPayload(paymentRequired);

// 3. THE ECHO: include exactly the extensions info the server declared.
payload.extensions = paymentRequired.extensions;

// 4. Pay.
const r2 = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64"),
  },
  body,
});
console.log("send status:", r2.status);
console.log(JSON.stringify(await r2.json(), null, 1));
const receipt = r2.headers.get("payment-response");
if (receipt) console.log("receipt:", Buffer.from(receipt, "base64").toString());
if (r2.status !== 201) process.exit(1);
console.log("ECHO SMOKE PASSED");
