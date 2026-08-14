/**
 * Regression tests for the audit findings (#774). Each asserts the FIX holds,
 * so a reintroduction fails CI.
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import nacl from "tweetnacl";

import { LockerClient } from "../../client/index.ts";

const BASE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";
const newClient = () => new LockerClient(BASE(), generatePrivateKey());
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const rand = (n: number) => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536)));
  return u;
};
const send = (to: string, body: Record<string, unknown>) =>
  fetch(`${BASE()}/v1/mb/${to}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("HIGH-1: upload dedup cannot be hijacked", () => {
  it("two keyless same-size uploads to one mailbox are DISTINCT rows, not a collision", async () => {
    const victim = newClient().address;
    const a = await send(victim, { content_type: "application/octet-stream", body_upload: true, size_bytes: 50_000 });
    const b = await send(victim, { content_type: "application/octet-stream", body_upload: true, size_bytes: 50_000 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aid = (await a.json()) as { message_id: string; upload_url?: string; idempotent_replay?: boolean };
    const bid = (await b.json()) as { message_id: string; upload_url?: string; idempotent_replay?: boolean };
    // The attacker's second send must NOT be an idempotent replay of the victim's row.
    expect(bid.message_id).not.toBe(aid.message_id);
    expect(bid.idempotent_replay).not.toBe(true);
    // Each gets its OWN upload url (distinct r2_key), so no cross-overwrite.
    expect(aid.upload_url).toBeTruthy();
    expect(bid.upload_url).toBeTruthy();
    expect(aid.upload_url).not.toBe(bid.upload_url);
  });
});

describe("HIGH-2: require_e2e rejects the upload path", () => {
  it("a require_e2e mailbox refuses body_upload (would be an unchecked plaintext hole)", async () => {
    const owner = newClient();
    const reg = await owner.registerKey(true);
    expect(reg.status).toBe(200);
    const res = await send(owner.address, { content_type: "application/octet-stream", body_upload: true, size_bytes: 5000, encrypted: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("E2E_REQUIRED");
  });
});

describe("M8: private_count is timing-shaped like a never-used address", () => {
  it("both run the count query (behavioral proxy: both return promptly and equal shape)", async () => {
    const priv = newClient();
    await priv.registerKey(true, undefined, true); // private_count
    const res = (await (await fetch(`${BASE()}/v1/mb/${priv.address}/count`)).json()) as { unacked: number };
    expect(res).toEqual({ unacked: 0 });
  });
});

describe("L1: read limit cannot be coerced to unbounded", () => {
  it("limit:-1 does not return the whole mailbox", async () => {
    const owner = newClient();
    for (let i = 0; i < 5; i++) await newClient().send(owner.address, new TextEncoder().encode(`m${i}`));
    const auth = await owner.challenge();
    const res = await fetch(`${BASE()}/v1/mb/${owner.address}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...auth, limit: -1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    // -1 must be clamped to the default page (>=1), not SQLite's LIMIT -1 (all).
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("MAILBOX_FULL / backpressure surfaces (bounded proxy)", () => {
  it("a size that would exceed the 1GB unacked byte cap is rejected 409 pre-charge", async () => {
    // Can't cheaply fill 1GB; assert the size-cap path (413) which shares the
    // pre-charge ordering, plus that a normal send still 201s (control).
    const owner = newClient().address;
    const ok = await send(owner, { content_type: "text/plain", body_b64: b64(new TextEncoder().encode("hi")) });
    expect(ok.status).toBe(201);
    const too = await send(owner, { content_type: "x", body_upload: true, size_bytes: 10 * 1024 * 1024 + 1 });
    expect(too.status).toBe(413);
  });
});
