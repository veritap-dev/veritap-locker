/**
 * §12.23 — the respawn drill: the product's reason to exist, as a test.
 *
 * Process A sends itself messages and saves a checkpoint, then "dies". A NEW
 * client constructed from ONLY the wallet private key (no tokens, no state,
 * no shared objects) derives the address, gets a nonce, drains the mail, and
 * loads the checkpoint byte-for-byte.
 *
 * Set LOCKER_BASE to a deployed URL to run this drill against production —
 * the §12 exit criteria require it to pass against the deployed target, not
 * just local.
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { LockerClient } from "../../client/index.ts";

describe("respawn drill (§12.23)", () => {
  it("a fresh process holding only the key IS the owner", async () => {
    const BASE = process.env.LOCKER_BASE ?? "http://localhost:8788";
    const walletKey = generatePrivateKey(); // the ONE secret that survives death

    // ---- Process A: lives, works, dies ----
    {
      const processA = new LockerClient(BASE, walletKey);
      await fetch(`${BASE}/v1/mb/${processA.address}/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_microusd: 1_000_000 }),
      });
      for (let i = 0; i < 5; i++) {
        const r = await processA.send(processA.address, new TextEncoder().encode(`note-to-future-self-${i}`), {
          producer: "process-a",
          tag: "memo",
        });
        expect(r.status).toBe(201);
      }
      const ckpt = await processA.checkpointSave(
        "working-memory",
        new TextEncoder().encode(JSON.stringify({ task: "verify listings", progress: 0.7, learned: ["cl fetchable", "fb not"] })),
        "application/json",
      );
      expect(ckpt.status).toBe(200);
      // process A is now dead. No state survives except walletKey.
    }

    // ---- Process B: fresh, holds only the key ----
    const processB = new LockerClient(BASE, walletKey);
    expect(await processB.count()).toBe(5); // free peek before signing anything

    const read = await processB.read();
    expect(read.status).toBe(200);
    expect(read.body.messages.length).toBe(5);
    const bodies = await Promise.all(read.body.messages.map((m) => processB.fetchBody(m)));
    const texts = bodies.map((b) => new TextDecoder().decode(b!)).sort();
    expect(texts).toEqual([0, 1, 2, 3, 4].map((i) => `note-to-future-self-${i}`));

    const memory = await processB.checkpointLoad("working-memory");
    const state = JSON.parse(new TextDecoder().decode(memory!));
    expect(state.progress).toBe(0.7); // byte-for-byte continuity

    const ack = await processB.ack(read.body.messages.map((m) => m.message_id));
    expect(ack.body.acked).toBe(5);
    expect(await processB.count()).toBe(0);
  }, 120_000);
});
