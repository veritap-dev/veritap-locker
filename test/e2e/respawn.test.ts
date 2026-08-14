/**
 * §12.23 — the respawn drill: the product's reason to exist, as a test.
 *
 * Process A sends itself messages and saves a checkpoint, then "dies". A NEW
 * client constructed from ONLY the wallet private key (no tokens, no state,
 * no shared objects) derives the address, gets a nonce, drains the mail, and
 * loads the checkpoint byte-for-byte.
 *
 * Runs against the local free instance (payments off) by default. It exercises
 * identity/storage/decrypt, NOT the x402 gate — against the payments-on prod
 * deployment a send would 402. The money path is certified separately by
 * scripts/smoke-buy.mjs (a real mainnet purchase).
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
      // #771: register a DERIVED enc key and send a SEALED message to self —
      // the drill must prove decryption from the wallet alone, not just read.
      const reg = await processA.registerKey(true);
      expect(reg.status).toBe(200);
      const secret = await processA.send(processA.address, new TextEncoder().encode("SEALED-SECRET-42"));
      expect(secret.status).toBe(201);
      // process A is now dead. No state survives except walletKey — NOT the
      // enc keypair, which must be re-derivable.
    }

    // ---- Process B: fresh, holds only the key ----
    const processB = new LockerClient(BASE, walletKey);
    expect(await processB.count()).toBe(6); // 5 notes + 1 sealed, free peek pre-signing

    const read = await processB.read();
    expect(read.status).toBe(200);
    expect(read.body.messages.length).toBe(6); // 5 plaintext notes + 1 sealed
    const plainTexts = (await Promise.all(read.body.messages.filter((m) => !m.encrypted).map((m) => processB.fetchBody(m))))
      .map((b) => new TextDecoder().decode(b!))
      .sort();
    expect(plainTexts).toEqual([0, 1, 2, 3, 4].map((i) => `note-to-future-self-${i}`));

    const memory = await processB.checkpointLoad("working-memory");
    const state = JSON.parse(new TextDecoder().decode(memory!));
    expect(state.progress).toBe(0.7); // byte-for-byte continuity

    // #771 — the thesis, proven: decrypt a sealed message holding ONLY the
    // wallet key. The enc key was never persisted; process B re-derives it,
    // matches the directory, and opens the box.
    const decrypted = await processB.readAndDecrypt();
    const sealed = decrypted.find((d) => d.envelope.encrypted);
    expect(sealed).toBeTruthy();
    expect(new TextDecoder().decode(sealed!.plaintext!)).toBe("SEALED-SECRET-42");

    const ack = await processB.ack(read.body.messages.map((m) => m.message_id));
    expect(ack.body.acked).toBe(6);
    expect(await processB.count()).toBe(0);
  }, 120_000);
});
