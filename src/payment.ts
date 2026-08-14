/**
 * §6/§7 x402 payment gate — messages send + credit top-up only.
 *
 * Implemented against the x402 facilitator REST protocol directly (POST
 * /verify, POST /settle) rather than x402-hono middleware: our prices are
 * dynamic per-request (size × TTL), our error codes are contractual, and the
 * facilitator interface is the stable part of a fast-moving ecosystem.
 *
 * Order of operations on a paid route:
 *   validate → free rejections (size/MAILBOX_FULL/E2E) → idempotency replay
 *   (returns existing, NO charge) → 402 gate: local payload sanity → verify →
 *   settle → business logic. Settle-before-create means a crashed create is
 *   OUR failure (manual refund, logged loud) and a replayed authorization
 *   fails at the chain nonce — never a double charge, never a free message.
 *
 * Networks: base-sepolia (keyless hosted facilitator) and base (CDP
 * facilitator; JWT auth via CDP secret — Phase B mainnet flip is config).
 * USDC has 6 decimals, so 1 microusd == 1 atomic USDC unit exactly.
 */

import { CREDIT_BAZAAR, SEND_BAZAAR } from "./bazaar-metadata.ts";
import { sawAddress, tick } from "./metrics.ts";
import type { Env } from "./types.ts";
import { transition } from "./types.ts";

const b64url = (bytes: Uint8Array | string) => {
  const u = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * CDP platform JWT (EdDSA), matching cdp-sdk's claim shape exactly:
 * header {alg, kid, typ, nonce} · payload {sub, iss:"cdp", uris, iat, nbf,
 * exp: nbf+120}. The 88-char base64 secret is a 64-byte Ed25519 expanded key
 * (seed ‖ pubkey); WebCrypto imports the 32-byte seed via a PKCS8 wrapper —
 * the same trick the attestation signer uses.
 */
export async function cdpJwt(
  keyId: string,
  keySecret: string,
  method: string,
  host: string,
  reqPath: string,
): Promise<string> {
  const raw = Uint8Array.from(atob(keySecret.trim()), (c) => c.charCodeAt(0));
  const seed = raw.slice(0, 32);
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, false, ["sign"]);

  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const payload = { sub: keyId, iss: "cdp", uris: [`${method} ${host}${reqPath}`], iat: now, nbf: now, exp: now + 120 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/**
 * x402 V2 wire shapes (board #784: Bazaar requires v2; CDP validate rejected
 * our v1 with "upgrade to x402 v2"). v2 deltas from v1, per the official spec:
 * CAIP-2 network ids, accepts[].amount (was maxAmountRequired), ResourceInfo
 * moved to the top-level `resource` object, header PAYMENT-SIGNATURE (was
 * X-PAYMENT), and facilitator payloads at x402Version: 2.
 */
export interface PaymentRequirements {
  scheme: "exact";
  network: string; // CAIP-2, e.g. eip155:8453
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface Quote {
  requirements: PaymentRequirements;
  resource: ResourceInfo;
}

const USDC: Record<string, string> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
/** CAIP-2 ids (v2); the readable name stays the config surface. */
const CAIP2: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};

export const paymentsEnabled = (env: Env) =>
  env.X402_ENABLED === "true" && Boolean(env.RECEIVING_ADDRESS);

export function buildRequirements(
  env: Env,
  priceMicrousd: number,
  resource: string,
  description: string,
): Quote {
  const network = env.X402_NETWORK ?? "base-sepolia";
  return {
    requirements: {
      scheme: "exact",
      network: CAIP2[network] ?? CAIP2["base-sepolia"]!,
      amount: String(priceMicrousd), // USDC 6dp: microusd == atomic units
      asset: USDC[network] ?? USDC["base-sepolia"]!,
      payTo: env.RECEIVING_ADDRESS!,
      maxTimeoutSeconds: 300,
      extra: { name: network === "base" ? "USD Coin" : "USDC", version: "2" },
    },
    resource: { url: resource, description, mimeType: "application/json" },
  };
}

/**
 * Bazaar discovery metadata (board #784): rides in the PaymentRequired
 * extensions key. Shapes are GENERATED by the official @x402/extensions
 * emitter (info + schema pair the CDP indexer validates) and baked in
 * src/bazaar-metadata.ts — the verify/settle payloads are NOT touched.
 * CDP indexes the route after the next settled payment.
 */
function bazaarExtension(quote: Quote): Record<string, unknown> {
  return { bazaar: quote.resource.url.endsWith("/credit") ? CREDIT_BAZAAR : SEND_BAZAAR };
}

/** UTF-8-safe base64 (btoa alone throws on the em-dashes in our copy). */
const b64utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * The 402 response (v2 PaymentRequired) — §11a copy rides here. v2 transport
 * delivers the protocol payload in the PAYMENT-REQUIRED header (the Bazaar
 * indexer reads ONLY the header); the JSON body carries the same object for
 * humans and older tooling.
 */
export function respond402(quote: Quote, error?: string): Response {
  const paymentRequired = {
    x402Version: 2,
    error:
      error ??
      // F1/F2/F3: no hardcoded price (the quote is in accepts[].amount),
      // and reading is FREE + gated by the wallet key, not payment. Copy must
      // not imply pay-to-read or a fixed price the tiers don't honor.
      `Payment required to deliver this message to the wallet-addressed mailbox. Durable storage insures a result whose sender may be gone when you wake; the holder of the wallet key reads it for free by signing. Amount: see accepts[].amount.`,
    resource: quote.resource,
    accepts: [quote.requirements],
    extensions: bazaarExtension(quote),
  };
  const json = JSON.stringify(paymentRequired);
  return new Response(json, {
    status: 402,
    headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": b64utf8(json) },
  });
}

interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

export function decodePayment(header: string | undefined): PaymentPayload | null {
  if (!header) return null;
  try {
    return JSON.parse(atob(header)) as PaymentPayload;
  } catch {
    return null;
  }
}

/** v2 PAYMENT-RESPONSE header value for a settled request. */
export function paymentResponseHeader(s: { txHash?: string; payer?: string; network?: string }): string {
  return btoa(
    JSON.stringify({ success: true, transaction: s.txHash ?? "", network: s.network ?? "", payer: s.payer ?? "" }),
  );
}

export interface GateResult {
  ok: boolean;
  response?: Response;
  settlement?: { txHash?: string; payer?: string };
}

/**
 * Run the full gate for a paid route. Fail-closed: any facilitator ambiguity
 * is a 402, never a free ride. Returns ok:true only after successful settle.
 */
export async function paymentGate(
  env: Env,
  request: Request,
  priceMicrousd: number,
  resource: string,
  description: string,
  entityForAudit: string,
): Promise<GateResult> {
  if (!paymentsEnabled(env)) return { ok: true }; // Phase A passthrough

  const quote = buildRequirements(env, priceMicrousd, resource, description);
  const req = quote.requirements;
  // v2 header; the old X-PAYMENT is still read so a stale v1 client gets the
  // specific "does not satisfy" error below instead of a bare 402.
  const payload = decodePayment(
    request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT") ?? undefined,
  );
  if (!payload) {
    // #788 funnel: an unpaid, VALID request that received a real quote —
    // window-shopping. (Probe 402s for invalid bodies are counted separately
    // at their call sites.) entityForAudit is "send:.." | "credit:..".
    await tick(env, `quote402:${entityForAudit.split(":")[0]}`);
    return { ok: false, response: respond402(quote) };
  }
  if (!(payload as unknown as { extensions?: unknown }).extensions)
    console.warn("PAYMENT_NO_EXTENSIONS_ECHO", { note: "buyer client did not echo extensions; Bazaar cataloging may not trigger from this payment" });

  // Local sanity BEFORE facilitator round trips: wrong version/rail/recipient/
  // amount is rejected here — an underpaid authorization never reaches settle.
  const auth = payload.payload?.authorization;
  if (
    payload.x402Version !== 2 ||
    payload.accepted?.scheme !== "exact" ||
    payload.accepted?.network !== req.network ||
    !auth ||
    auth.to.toLowerCase() !== req.payTo.toLowerCase() ||
    BigInt(auth.value ?? "0") < BigInt(req.amount)
  )
    return {
      ok: false,
      response: respond402(quote, "Payment payload does not satisfy the requirements (x402 v2 required; check network, recipient, and amount)."),
    };

  // Mainnet uses the CDP facilitator with per-request JWT auth from the CDP
  // secret; testnet uses the hosted keyless facilitator. Both are config.
  const mainnet = (env.X402_NETWORK ?? "base-sepolia") === "base";
  const facilitator =
    env.FACILITATOR_URL ??
    (mainnet ? "https://api.cdp.coinbase.com/platform/v2/x402" : "https://x402.org/facilitator");
  const call = async (path: "verify" | "settle") => {
    let auth: Record<string, string> = {};
    if (mainnet && env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
      // Own WebCrypto JWT: cdp-sdk's node-crypto path emits signatures CDP
      // rejects under workerd's nodejs_compat (local node: 200, worker: 401 —
      // isolated with the same key pair). workerd's native Ed25519 works.
      const jwt = await cdpJwt(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST",
        "api.cdp.coinbase.com", `/platform/v2/x402/${path}`);
      auth = { Authorization: `Bearer ${jwt}` };
    }
    const res = await fetch(`${facilitator}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req }),
      signal: AbortSignal.timeout(20_000),
    });
    // Bazaar cataloging status rides in this header on verify/settle
    // (success | processing | rejected). Log it so indexing is observable.
    const extResp = res.headers.get("EXTENSION-RESPONSES");
    if (extResp) {
      try {
        console.log("EXTENSION_RESPONSES", { path, ...JSON.parse(atob(extResp)) });
      } catch {
        console.log("EXTENSION_RESPONSES_RAW", { path, extResp: extResp.slice(0, 200) });
      }
    }
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as {
        isValid?: boolean;
        success?: boolean;
        invalidReason?: string;
        errorReason?: string;
        transaction?: string;
        payer?: string;
      },
    };
  };

  // H5: fail CLOSED on ambiguity. Require EXPLICIT positive results, not merely
  // "not false" — a 200 with an empty/garbled body ({} from the .catch) must
  // never be read as success (that was a free-message hole).
  try {
    const verify = await call("verify");
    if (!(verify.status === 200 && verify.body.isValid === true)) {
      console.warn("VERIFY_REJECTED", { status: verify.status, reason: verify.body.invalidReason ?? verify.body.errorReason });
      // Verify-phase failure is safe to call not-charged: nothing settled.
      return {
        ok: false,
        response: respond402(quote, `Payment verification failed: ${verify.body.invalidReason ?? verify.body.errorReason ?? "rejected"}. Not charged.`),
      };
    }

    let settle;
    try {
      settle = await call("settle");
    } catch (settleErr) {
      // H4: a settle-phase timeout/exception is AMBIGUOUS — the tx may have
      // broadcast and settled on-chain. Do NOT claim "not charged". Log for
      // reconciliation; the consumed authorization means a same-payload retry
      // will (correctly) fail, so the caller must not blindly re-send.
      console.error("SETTLE_AMBIGUOUS", { payer: auth.from, nonce: auth.nonce, error: String(settleErr) });
      await transition(env, "payment", entityForAudit, null, "settle_ambiguous",
        `${priceMicrousd}µ$ from ${auth.from} nonce ${auth.nonce} — settle unacknowledged, reconcile on-chain`);
      return {
        ok: false,
        response: respond402(quote, "Payment settlement could not be confirmed. Your authorization may have settled on-chain — do NOT resend the same payment; if a message was not created it will be reconciled or refunded. This request is idempotent on the payment nonce."),
      };
    }
    const settled = settle.status === 200 && settle.body.success === true && Boolean(settle.body.transaction);
    if (!settled) {
      console.warn("SETTLE_REJECTED", { status: settle.status, reason: settle.body.errorReason });
      return {
        ok: false,
        response: respond402(quote, `Payment settlement failed: ${settle.body.errorReason ?? "not settled"}. A replayed authorization cannot settle twice.`),
      };
    }

    await transition(env, "payment", entityForAudit, null, "settled",
      `${priceMicrousd}µ$ from ${auth.from} tx ${settle.body.transaction}`);
    await tick(env, `settled:${entityForAudit.split(":")[0]}`); // #788 funnel: conversion
    await sawAddress(env, auth.from, "payer");
    return { ok: true, settlement: { txHash: settle.body.transaction, payer: auth.from } };
  } catch (e) {
    // Verify-phase network failure: nothing settled, safe to call not-charged.
    console.error("FACILITATOR_ERROR", { error: String(e) });
    return { ok: false, response: respond402(quote, "Payment facilitator unreachable; retry shortly. Not charged.") };
  }
}
