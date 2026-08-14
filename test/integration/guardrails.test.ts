/**
 * #773 guardrails, live against the dev worker: single-use signed GETs and the
 * credit-exhaustion → grace → top-up → recovery lifecycle (the functional
 * audit's biggest untested surface).
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { LockerClient } from "../../client/index.ts";

const BASE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";
const newClient = () => new LockerClient(BASE(), generatePrivateKey());

describe("single-use signed GET urls (#773-A3)", () => {
  it("a body_url stops serving after 3 redemptions", async () => {
    const owner = newClient();
    // Upload-path message so the body lands in R2 (inline bodies have no URL).
    const create = await fetch(`${BASE()}/v1/mb/${owner.address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "application/octet-stream", body_upload: true, size_bytes: 5000 }),
    });
    expect(create.status).toBe(201);
    const { upload_url } = (await create.json()) as { upload_url: string };
    const put = await fetch(upload_url, { method: "PUT", body: new Uint8Array(5000) });
    expect(put.status).toBe(201);

    const page = await owner.read();
    const url = (page.body as { messages: Array<{ body_url?: string }> }).messages[0]?.body_url;
    expect(url).toBeTruthy();
    for (let i = 0; i < 3; i++) expect((await fetch(url!)).status).toBe(200);
    expect((await fetch(url!)).status).toBe(404); // 4th redemption refused
  });
});

describe("grace lifecycle (#773 / functional-audit gap)", () => {
  const cronDaily = () =>
    fetch(`${BASE()}/__scheduled?cron=${encodeURIComponent("10 5 * * *")}`);

  it("exhaustion → GRACE_READONLY → top-up → writable again", async () => {
    const owner = newClient();
    // Store a checkpoint with ZERO credit balance.
    const save = await owner.checkpointSave("state", new TextEncoder().encode("x".repeat(2000)));
    expect(save.status).toBe(200);

    // Nightly burn runs: balance(0) < burn(≥1µ$) ⇒ grace begins.
    expect((await cronDaily()).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // scheduled handler is waitUntil'd

    const st1 = (await (await fetch(`${BASE()}/v1/mb/${owner.address}/status`)).json()) as {
      grace: { readonly: boolean } | null;
    };
    expect(st1.grace?.readonly).toBe(true);

    // Writes are refused, reads still work.
    const blocked = await owner.checkpointSave("state2", new Uint8Array(100));
    expect(blocked.status).toBe(402);
    expect((blocked.body as unknown as { error: string }).error).toBe("GRACE_READONLY");
    expect(await owner.checkpointLoad("state")).not.toBeNull();

    // Top-up clears grace (payments disabled on this instance ⇒ pass-through).
    const topup = await fetch(`${BASE()}/v1/mb/${owner.address}/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_microusd: 1_000_000 }),
    });
    expect(topup.status).toBe(200);
    const st2 = (await (await fetch(`${BASE()}/v1/mb/${owner.address}/status`)).json()) as {
      grace: unknown; balance_microusd: number;
    };
    expect(st2.grace).toBeNull();
    expect(st2.balance_microusd).toBe(1_000_000);
    expect((await owner.checkpointSave("state2", new Uint8Array(100))).status).toBe(200);
  });
});
