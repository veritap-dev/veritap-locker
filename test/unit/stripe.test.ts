/** Fiat top-up rail unit vectors: webhook signature verification, event
 * parsing, and the cents→microusd conversion (money-correctness). */

import { describe, expect, it } from "vitest";

import {
  centsToMicrousd,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  parseStripeWebhook,
  verifyStripeSignature,
} from "../../src/stripe.ts";

const SECRET = "whsec_test_deadbeefdeadbeefdeadbeef";
const ADDR = "0x1111111111111111111111111111111111111111";

/** Build a Stripe-Signature header the way Stripe does: HMAC-SHA256 over `t.body`. */
async function sign(body: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

const completedEvent = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        currency: "usd",
        amount_total: 500, // $5.00
        metadata: { address: ADDR },
        ...over,
      },
    },
  });

describe("cents→microusd", () => {
  it("1 cent == 10_000 microusd; $5 == 5_000_000", () => {
    expect(centsToMicrousd(1)).toBe(10_000);
    expect(centsToMicrousd(500)).toBe(5_000_000);
    expect(MIN_TOPUP_CENTS).toBe(500);
    expect(MAX_TOPUP_CENTS).toBe(10_000);
  });
});

describe("verifyStripeSignature", () => {
  it("accepts a fresh, correctly-signed body", async () => {
    const body = completedEvent();
    const t = 1_700_000_000;
    const sig = await sign(body, SECRET, t);
    expect(await verifyStripeSignature(body, sig, SECRET, t)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const t = 1_700_000_000;
    const sig = await sign(completedEvent(), SECRET, t);
    expect(await verifyStripeSignature(completedEvent({ amount_total: 999_999 }), sig, SECRET, t)).toBe(false);
  });

  it("rejects a stale timestamp (> 5 min)", async () => {
    const body = completedEvent();
    const t = 1_700_000_000;
    const sig = await sign(body, SECRET, t);
    expect(await verifyStripeSignature(body, sig, SECRET, t + 600)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const body = completedEvent();
    const t = 1_700_000_000;
    const sig = await sign(body, "whsec_wrong", t);
    expect(await verifyStripeSignature(body, sig, SECRET, t)).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyStripeSignature("{}", null, SECRET)).toBe(false);
  });
});

describe("parseStripeWebhook", () => {
  const now = Math.floor(Date.now() / 1000);

  it("credits a paid checkout.session.completed with the right amount + address", async () => {
    const body = completedEvent();
    const sig = await sign(body, SECRET, now);
    const r = await parseStripeWebhook(body, sig, SECRET);
    expect(r.kind).toBe("credit");
    if (r.kind !== "credit") throw new Error("unreachable");
    expect(r.address).toBe(ADDR);
    expect(r.amountMicrousd).toBe(5_000_000);
    expect(r.sessionId).toBe("cs_test_1");
    expect(r.eventId).toBe("evt_test_1");
  });

  it("returns 'bad' on an invalid signature (Stripe will retry)", async () => {
    const body = completedEvent();
    const r = await parseStripeWebhook(body, "t=1,v1=deadbeef", SECRET);
    expect(r.kind).toBe("bad");
  });

  it("ignores an unpaid session (valid sig, no credit)", async () => {
    const body = completedEvent({ payment_status: "unpaid" });
    const sig = await sign(body, SECRET, now);
    expect((await parseStripeWebhook(body, sig, SECRET)).kind).toBe("ignore");
  });

  it("ignores a non-USD session", async () => {
    const body = completedEvent({ currency: "eur" });
    const sig = await sign(body, SECRET, now);
    expect((await parseStripeWebhook(body, sig, SECRET)).kind).toBe("ignore");
  });

  it("ignores a below-minimum amount", async () => {
    const body = completedEvent({ amount_total: 100 }); // $1 < $5 floor
    const sig = await sign(body, SECRET, now);
    expect((await parseStripeWebhook(body, sig, SECRET)).kind).toBe("ignore");
  });

  it("ignores a bad address in metadata", async () => {
    const body = completedEvent({ metadata: { address: "not-an-address" } });
    const sig = await sign(body, SECRET, now);
    expect((await parseStripeWebhook(body, sig, SECRET)).kind).toBe("ignore");
  });

  it("ignores unrelated event types", async () => {
    const body = JSON.stringify({ id: "evt_x", type: "payment_intent.created", data: { object: {} } });
    const sig = await sign(body, SECRET, now);
    expect((await parseStripeWebhook(body, sig, SECRET)).kind).toBe("ignore");
  });
});
