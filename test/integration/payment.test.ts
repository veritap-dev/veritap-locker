/**
 * §12-D against the payments-enabled instance (facilitator at a dead port, so
 * anything that would settle fails CLOSED — proving no free rides).
 * Real-chain settle happens in the mainnet smoke test with $5 (§6).
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { LockerClient } from "../../client/index.ts";

const PAY = () => process.env.LOCKER_PAY_BASE ?? "http://localhost:8789";
const FREE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";
const RECEIVING = "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const addr = () => new LockerClient(FREE(), generatePrivateKey()).address;
const bodyB64 = (n: number) => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536)));
  return btoa(String.fromCharCode(...u.subarray(0, Math.min(n, 30000))));
};

const send = (base: string, to: string, body: Record<string, unknown>, payment?: string) =>
  fetch(`${base}/v1/mb/${to}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(payment ? { "PAYMENT-SIGNATURE": payment } : {}),
    },
    body: JSON.stringify(body),
  });

describe("x402 gate (§12.19-20)", () => {
  it("unpaid send → 402 with correct price, asset, and recipient (§12.19)", async () => {
    const res = await send(PAY(), addr(), { content_type: "text/plain", body_b64: bodyB64(1000) });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> };
    expect(body.x402Version).toBe(2);
    const req = body.accepts[0]!;
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("eip155:84532");
    expect(req.amount).toBe("10000"); // ≤100KB, default TTL = $0.01
    expect(req.payTo).toBe(RECEIVING);
    expect(req.asset).toBe(SEPOLIA_USDC);
  });

  it("extended TTL priced into the 402 (§12.11 pricing)", async () => {
    const res = await send(PAY(), addr(), {
      content_type: "text/plain",
      body_b64: bodyB64(1000),
      ttl_days: 365,
    });
    const body = (await res.json()) as { accepts: Array<{ amount: string }> };
    // base 10000 + ceil(335/90)=4 × 10000 = 50000 µ$ ($0.05)
    expect(body.accepts[0]!.amount).toBe("50000");
  });

  it("oversize still 413 BEFORE payment — no charge (§12.8)", async () => {
    const res = await send(PAY(), addr(), {
      content_type: "x",
      body_upload: true,
      size_bytes: 10 * 1024 * 1024 + 1,
    });
    expect(res.status).toBe(413);
  });

  it("underpaid authorization rejected locally, never settled (§12.19)", async () => {
    const payment = btoa(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: SEPOLIA_USDC,
          payTo: RECEIVING,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
        payload: {
          signature: "0x" + "ab".repeat(65),
          authorization: {
            from: "0x" + "11".repeat(20),
            to: RECEIVING,
            value: "5000", // half the price
            validAfter: "0",
            validBefore: "9999999999",
            nonce: "0x" + "22".repeat(32),
          },
        },
      }),
    );
    const res = await send(PAY(), addr(), { content_type: "text/plain", body_b64: bodyB64(1000) }, payment);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not satisfy");
  });

  it("wrong recipient rejected locally (§12.19)", async () => {
    const payment = btoa(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: SEPOLIA_USDC,
          payTo: RECEIVING,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
        payload: {
          signature: "0x" + "ab".repeat(65),
          authorization: {
            from: "0x" + "11".repeat(20),
            to: "0x" + "99".repeat(20), // not our address
            value: "10000",
            validAfter: "0",
            validBefore: "9999999999",
            nonce: "0x" + "22".repeat(32),
          },
        },
      }),
    );
    const res = await send(PAY(), addr(), { content_type: "text/plain", body_b64: bodyB64(1000) }, payment);
    expect(res.status).toBe(402);
  });

  it("facilitator unreachable → fail closed, honest 402, no message (§12.19)", async () => {
    const to = addr();
    const payment = btoa(
      JSON.stringify({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: SEPOLIA_USDC,
          payTo: RECEIVING,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
        payload: {
          signature: "0x" + "ab".repeat(65),
          authorization: {
            from: "0x" + "11".repeat(20),
            to: RECEIVING,
            value: "10000",
            validAfter: "0",
            validBefore: "9999999999",
            nonce: "0x" + "22".repeat(32),
          },
        },
      }),
    );
    const res = await send(PAY(), to, { content_type: "text/plain", body_b64: bodyB64(1000) }, payment);
    expect(res.status).toBe(402);
    // and nothing was stored:
    const count = (await (await fetch(`${PAY()}/v1/mb/${to}/count`)).json()) as { unacked: number };
    expect(count.unacked).toBe(0);
  });

  it("idempotent replay returns the existing message BEFORE the gate — no double charge (§12.20)", async () => {
    const { execSync } = await import("node:child_process");
    const to = addr();
    // Seed a previously-PAID message straight into the pay instance's D1 —
    // simulating a settled send whose response the agent lost.
    execSync(
      `npx wrangler d1 execute veritap_locker --local --persist-to .wrangler/test-state-pay --command ` +
        `"INSERT INTO messages (message_id, address, content_type, size, encrypted, created_at, expires_at, idempotency_key, body_hash, paid_microusd) ` +
        `VALUES ('lm_seedpaid1', '${to}', 'text/plain', 8, 0, strftime('%s','now'), strftime('%s','now')+86400, 'pay-idem-1', 'seedhash', 10000)"`,
      { stdio: "ignore" },
    );
    const replay = await send(PAY(), to, {
      content_type: "text/plain",
      body_b64: btoa("pay once"),
      idempotency_key: "pay-idem-1",
    });
    expect(replay.status).toBe(201); // NOT 402: replay short-circuits payment
    const replayBody = (await replay.json()) as { message_id: string };
    expect(replayBody.message_id).toBe("lm_seedpaid1");
  });

  it("receipt_vault: distinct product, flat $0.02, fixed 365d (#767.1)", async () => {
    const res = await send(PAY(), addr(), {
      content_type: "application/json",
      body_b64: bodyB64(1000),
      product: "receipt_vault",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ amount: string }> };
    expect(body.accepts[0]!.amount).toBe("20000");
    // wrong ttl for vault rejected before payment
    const bad = await send(PAY(), addr(), {
      content_type: "application/json", body_b64: bodyB64(1000),
      product: "receipt_vault", ttl_days: 30,
    });
    expect(bad.status).toBe(400);
  });

  it("credit top-up demands payment on the paid instance (§12.19)", async () => {
    const res = await fetch(`${PAY()}/v1/mb/${addr()}/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_microusd: 2_000_000 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<{ amount: string }> };
    expect(body.accepts[0]!.amount).toBe("2000000");
  });
});
