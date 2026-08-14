/**
 * §6 mainnet smoke: ONE real purchase with real USDC before the Bazaar flag.
 * The buyer (test/fixtures/buyer.key, funded ~$5) sends ITSELF a note through
 * the paid rail, then reads it back with the same key — the complete product
 * loop with real money: pay → deliver → survive → sign → read.
 *
 * Run: node scripts/smoke-buy.mjs
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { LockerClient } from "../client/index.ts";

const BASE = process.env.LOCKER_BASE ?? "https://locker.veritap.dev";
const key = readFileSync(new URL("../test/fixtures/buyer.key", import.meta.url), "utf8").trim();
const account = privateKeyToAccount(key);
console.log("buyer:", account.address);

const fetchWithPay = wrapFetchWithPayment(fetch, account);

const body = {
  producer: "veritap-smoke",
  tag: "mainnet-smoke",
  content_type: "text/plain",
  body_b64: Buffer.from(`mainnet smoke ${new Date().toISOString()} — if you can pay, you can read your mail`).toString("base64"),
  idempotency_key: `smoke-${Date.now()}`,
};

console.log("→ paid send ($0.01 USDC on Base)…");
const res = await fetchWithPay(`${BASE}/v1/mb/${account.address}/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log("send status:", res.status);
const sent = await res.json();
console.log(JSON.stringify(sent, null, 1));
if (res.status !== 201) process.exit(1);
const receipt = res.headers.get("x-payment-response");
if (receipt) console.log("payment receipt:", Buffer.from(receipt, "base64").toString().slice(0, 200));

console.log("→ reading it back with only the wallet key…");
const client = new LockerClient(BASE, key);
const read = await client.read();
const mine = read.body.messages.find((m) => m.message_id === sent.message_id);
if (!mine) { console.error("MESSAGE NOT FOUND"); process.exit(1); }
const bytes = await client.fetchBody(mine);
console.log("read back:", new TextDecoder().decode(bytes));
console.log("SMOKE PASSED — money in, message durable, key reads it.");
