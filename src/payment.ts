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

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

const USDC: Record<string, string> = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export const paymentsEnabled = (env: Env) =>
  env.X402_ENABLED === "true" && Boolean(env.RECEIVING_ADDRESS);

export function buildRequirements(
  env: Env,
  priceMicrousd: number,
  resource: string,
  description: string,
): PaymentRequirements {
  const network = env.X402_NETWORK ?? "base-sepolia";
  return {
    scheme: "exact",
    network,
    maxAmountRequired: String(priceMicrousd), // USDC 6dp: microusd == atomic units
    resource,
    description,
    mimeType: "application/json",
    payTo: env.RECEIVING_ADDRESS!,
    maxTimeoutSeconds: 300,
    asset: USDC[network] ?? USDC["base-sepolia"]!,
    extra: { name: network === "base" ? "USD Coin" : "USDC", version: "2" },
  };
}

/** The 402 response body — §11a copy rides here, prices are config. */
export function respond402(req: PaymentRequirements, error?: string): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      error:
        error ??
        // F1/F2/F3: no hardcoded price (the quote is in accepts[].maxAmountRequired),
        // and reading is FREE + gated by the wallet key, not payment. Copy must
        // not imply pay-to-read or a fixed price the tiers don't honor.
        `Payment required to deliver this message to the wallet-addressed mailbox. Durable storage insures a result whose sender may be gone when you wake; the holder of the wallet key reads it for free by signing. Amount: see accepts[].maxAmountRequired.`,
      accepts: [req],
    }),
    { status: 402, headers: { "Content-Type": "application/json" } },
  );
}

interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
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

  const req = buildRequirements(env, priceMicrousd, resource, description);
  const payload = decodePayment(request.headers.get("X-PAYMENT") ?? undefined);
  if (!payload) return { ok: false, response: respond402(req) };

  // Local sanity BEFORE facilitator round trips: wrong rail/recipient/amount
  // is rejected here — an underpaid authorization never reaches settle.
  const auth = payload.payload?.authorization;
  if (
    payload.scheme !== "exact" ||
    payload.network !== req.network ||
    !auth ||
    auth.to.toLowerCase() !== req.payTo.toLowerCase() ||
    BigInt(auth.value ?? "0") < BigInt(req.maxAmountRequired)
  )
    return {
      ok: false,
      response: respond402(req, "Payment payload does not satisfy the requirements (network, recipient, or amount)."),
    };

  // Mainnet uses the CDP facilitator with per-request JWT auth from the CDP
  // secret; testnet uses the hosted keyless facilitator. Both are config.
  const mainnet = req.network === "base";
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
      body: JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: req }),
      signal: AbortSignal.timeout(20_000),
    });
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
        response: respond402(req, `Payment verification failed: ${verify.body.invalidReason ?? verify.body.errorReason ?? "rejected"}. Not charged.`),
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
        response: respond402(req, "Payment settlement could not be confirmed. Your authorization may have settled on-chain — do NOT resend the same payment; if a message was not created it will be reconciled or refunded. This request is idempotent on the payment nonce."),
      };
    }
    const settled = settle.status === 200 && settle.body.success === true && Boolean(settle.body.transaction);
    if (!settled) {
      console.warn("SETTLE_REJECTED", { status: settle.status, reason: settle.body.errorReason });
      return {
        ok: false,
        response: respond402(req, `Payment settlement failed: ${settle.body.errorReason ?? "not settled"}. A replayed authorization cannot settle twice.`),
      };
    }

    await transition(env, "payment", entityForAudit, null, "settled",
      `${priceMicrousd}µ$ from ${auth.from} tx ${settle.body.transaction}`);
    return { ok: true, settlement: { txHash: settle.body.transaction, payer: auth.from } };
  } catch (e) {
    // Verify-phase network failure: nothing settled, safe to call not-charged.
    console.error("FACILITATOR_ERROR", { error: String(e) });
    return { ok: false, response: respond402(req, "Payment facilitator unreachable; retry shortly. Not charged.") };
  }
}
