/**
 * Fiat top-up rail: card → credit on a wallet address, no account, ever.
 *
 * DUAL-RAIL, ONE METER: this module ONLY adds a funding path. Card payments and
 * x402 payments both land in the same `credits` ledger (kind='topup'); the x402
 * money path is untouched. Credit is non-transferable, services-only.
 *
 * Transport-pure by design — no DB, no env beyond what's passed, no stripe SDK
 * (Workers-native fetch + WebCrypto). The route handler (index.ts) owns
 * sanctions screening, the liability cap, idempotency, and the ledger writes.
 *
 * Units: Stripe speaks USD cents; the ledger speaks microusd. 1 cent = 10_000
 * microusd. Conversion lives in ONE place: centsToMicrousd().
 */

const STRIPE_API = "https://api.stripe.com/v1";
const SIG_TOLERANCE_S = 300; // Stripe's recommended replay window.

/** Card floor: below ~$5 the 30¢+2.9% card fee is a punishing %, and small
 * anonymous top-ups are the carding-fraud sweet spot. Ledger min is $1; we hold
 * the fiat floor higher on purpose. */
export const MIN_TOPUP_CENTS = 500; // $5
/** Matches the $100 per-address liability cap (credit_cap_microusd). */
export const MAX_TOPUP_CENTS = 10_000; // $100

export const centsToMicrousd = (cents: number) => cents * 10_000;
export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** Create a hosted Checkout Session that credits `address` on completion.
 * Returns the hosted URL to redirect the browser to, or a typed error. */
export async function createTopupSession(opts: {
  secretKey: string;
  address: string; // already canonicalized + cap-checked by caller
  amountCents: number;
  baseUrl: string;
}): Promise<{ url: string } | { error: string }> {
  const address = opts.address.toLowerCase();
  if (!isEvmAddress(address)) return { error: "INVALID_ADDRESS" };
  const cents = Math.floor(opts.amountCents);
  if (!Number.isFinite(cents) || cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS)
    return { error: "INVALID_AMOUNT" };

  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": `Veritap Locker credit — ${address.slice(0, 6)}…${address.slice(-4)}`,
    "line_items[0][price_data][product_data][description]":
      "Prepaid storage credit for your agent's durable memory. No subscription — spends down only on storage and delivery.",
    "line_items[0][price_data][product_data][images][0]": `${opts.baseUrl}/logo.png`,
    "metadata[address]": address,
    "payment_intent_data[metadata][address]": address,
    success_url: `${opts.baseUrl}/topup/done?s={CHECKOUT_SESSION_ID}`,
    cancel_url: `${opts.baseUrl}/topup?address=${address}&canceled=1`,
    "custom_text[submit][message]":
      "Non-refundable service credit, spendable only on Veritap Locker storage and delivery, attached to the wallet address above. Not transferable.",
  });

  let res: Response;
  try {
    res = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error("STRIPE_SESSION_NETWORK", String(e));
    return { error: "STRIPE_UNAVAILABLE" };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("STRIPE_SESSION_CREATE_FAILED", { status: res.status, detail: detail.slice(0, 300) });
    return { error: "STRIPE_UNAVAILABLE" };
  }
  const session = (await res.json().catch(() => ({}))) as { url?: string };
  return session.url ? { url: session.url } : { error: "STRIPE_UNAVAILABLE" };
}

/** Verify a Stripe-Signature header against the raw request body (HMAC-SHA256,
 * constant-time, with a 5-minute timestamp tolerance). */
export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts = new Map(
    sigHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!t || !v1 || Math.abs(nowS - t) > SIG_TOLERANCE_S) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export type StripeWebhookResult =
  | { kind: "credit"; address: string; amountMicrousd: number; sessionId: string; eventId: string }
  | { kind: "ignore" } // valid signature, not an event we act on (ack 200)
  | { kind: "bad" }; // bad signature or unparseable (respond 400 so Stripe retries)

/**
 * Verify + parse a webhook. Pure: returns what the route should DO, the route
 * does it. Call with the RAW body text (read before any JSON parse).
 */
export async function parseStripeWebhook(
  rawBody: string,
  sigHeader: string | null,
  webhookSecret: string,
): Promise<StripeWebhookResult> {
  if (!(await verifyStripeSignature(rawBody, sigHeader, webhookSecret))) return { kind: "bad" };

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { kind: "bad" };
  }
  if (event.type !== "checkout.session.completed") return { kind: "ignore" };

  const s = (event.data?.object ?? {}) as {
    id?: string;
    payment_status?: string;
    amount_total?: number;
    currency?: string;
    metadata?: { address?: string };
  };
  const address = s.metadata?.address?.toLowerCase() ?? "";
  if (
    !event.id ||
    !s.id ||
    s.payment_status !== "paid" ||
    s.currency !== "usd" ||
    !isEvmAddress(address) ||
    !s.amount_total ||
    s.amount_total < MIN_TOPUP_CENTS
  ) {
    // Permanently-bad but validly-signed input: ack (200) so Stripe stops
    // retrying, but do not credit.
    console.warn("STRIPE_WEBHOOK_UNACTIONABLE", { session: s.id, address, status: s.payment_status });
    return { kind: "ignore" };
  }
  return {
    kind: "credit",
    address,
    amountMicrousd: centsToMicrousd(s.amount_total),
    sessionId: s.id,
    eventId: event.id,
  };
}
