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
        "Payment required. Durable delivery to a wallet-addressed mailbox; the recipient signs with their x402 key to read. $0.01 insures the result you already paid for.",
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
      const { createCdpAuthHeaders } = await import("@coinbase/x402");
      const headersFn = createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
      const headers = headersFn ? await headersFn() : {};
      auth = (path === "verify" ? headers.verify : headers.settle) ?? {};
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

  try {
    const verify = await call("verify");
    if (!(verify.status === 200 && verify.body.isValid !== false && verify.body.errorReason === undefined))
      return {
        ok: false,
        response: respond402(req, `Payment verification failed: ${verify.body.invalidReason ?? verify.body.errorReason ?? "rejected"}`),
      };

    const settle = await call("settle");
    const settled = settle.status === 200 && settle.body.success !== false && !settle.body.errorReason;
    if (!settled)
      return {
        ok: false,
        response: respond402(req, `Payment settlement failed: ${settle.body.errorReason ?? "not settled"} — a replayed authorization cannot settle twice.`),
      };

    await transition(env, "payment", entityForAudit, null, "settled",
      `${priceMicrousd}µ$ from ${auth.from} tx ${settle.body.transaction ?? "?"}`);
    return { ok: true, settlement: { txHash: settle.body.transaction, payer: auth.from } };
  } catch (e) {
    // Facilitator unreachable: fail closed, tell the truth.
    console.error("FACILITATOR_ERROR", { error: String(e) });
    return { ok: false, response: respond402(req, "Payment facilitator unreachable; retry shortly. Not charged.") };
  }
}
