/** §12 B/C/E/F against real workerd (wrangler dev, fresh state per run). */

import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import fc from "fast-check";

import { LockerClient } from "../../client/index.ts";

const BASE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";
const newClient = () => new LockerClient(BASE(), generatePrivateKey());
const bytes = (s: string) => new TextEncoder().encode(s);
const rand = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};

let sender: LockerClient;

beforeAll(() => {
  sender = newClient();
});

describe("auth (§12.3-4)", () => {
  it("wrong key's signature → 401, nonce burned", async () => {
    const owner = newClient();
    const attacker = privateKeyToAccount(generatePrivateKey());
    const { body } = await (await fetch(`${BASE()}/v1/nonce?address=${owner.address}`)).json().then((b) => ({ body: b as { nonce: string } }));
    const sig = await attacker.signMessage({ message: body.nonce });
    const res = await fetch(`${BASE()}/v1/mb/${owner.address}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: body.nonce, signature: sig }),
    });
    expect(res.status).toBe(401);
    // Nonce is burned even on failure: the real owner can't reuse it.
    const ownSig = await owner.account.signMessage({ message: body.nonce });
    const res2 = await fetch(`${BASE()}/v1/mb/${owner.address}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: body.nonce, signature: ownSig }),
    });
    expect(res2.status).toBe(401);
    expect(((await res2.json()) as { error: string }).error).toBe("NONCE_USED");
  });

  it("cross-address nonce replay rejected", async () => {
    const a = newClient();
    const b = newClient();
    const { nonce } = (await (await fetch(`${BASE()}/v1/nonce?address=${a.address}`)).json()) as { nonce: string };
    const sig = await b.account.signMessage({ message: nonce });
    const res = await fetch(`${BASE()}/v1/mb/${b.address}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, signature: sig }),
    });
    expect(res.status).toBe(401);
  });

  it("concurrent use of one nonce: exactly one wins (§12.22)", async () => {
    const owner = newClient();
    const { nonce, signature } = await owner.challenge();
    const mk = () =>
      fetch(`${BASE()}/v1/mb/${owner.address}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, signature }),
      });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 401]);
  });
});

describe("message lifecycle (§12.7-14)", () => {
  it("inline send → read returns body; read is non-destructive; ack deletes", async () => {
    const owner = newClient();
    const send = await sender.send(owner.address, bytes("hello future self"), {
      producer: "test-suite",
      tag: "greeting",
      content_type: "text/plain",
    });
    expect(send.status).toBe(201);

    const read1 = await owner.read();
    expect(read1.status).toBe(200);
    expect(read1.body.messages.length).toBe(1);
    const body1 = await owner.fetchBody(read1.body.messages[0]!);
    expect(new TextDecoder().decode(body1!)).toBe("hello future self");

    // §12.14: crash without ack → re-read returns the same message.
    const read2 = await owner.read();
    expect(read2.body.messages.length).toBe(1);

    const ack = await owner.ack([read1.body.messages[0]!.message_id]);
    expect(ack.body.acked).toBe(1);
    const read3 = await owner.read();
    expect(read3.body.messages.length).toBe(0);

    // §12.10: ack idempotent + foreign ids don't leak.
    const ack2 = await owner.ack([read1.body.messages[0]!.message_id, "lm_doesnotexist"]);
    expect(ack2.body.acked).toBe(0);
  });

  it("oversized inline routed to upload; >10MB → 413 (§12.7-8)", async () => {
    const owner = newClient();
    const res = await fetch(`${BASE()}/v1/mb/${owner.address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "application/octet-stream", body_upload: true, size_bytes: 100_000 }),
    });
    expect(res.status).toBe(201);
    const { upload_url, message_id } = (await res.json()) as { upload_url: string; message_id: string };
    expect(upload_url).toBeTruthy();
    const payload = rand(100_000);
    const up = await fetch(upload_url, { method: "PUT", body: payload });
    expect(up.status).toBe(201);
    const read = await owner.read();
    const env = read.body.messages.find((m) => m.message_id === message_id)!;
    expect(env.body_url).toBeTruthy();
    const fetched = await owner.fetchBody(env);
    expect(fetched!.byteLength).toBe(100_000);
    expect(Buffer.from(fetched!).equals(Buffer.from(payload))).toBe(true);

    const too = await fetch(`${BASE()}/v1/mb/${owner.address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "x", body_upload: true, size_bytes: 10 * 1024 * 1024 + 1 }),
    });
    expect(too.status).toBe(413);
  });

  it("idempotency: same key → same message_id (§12.9)", async () => {
    const owner = newClient();
    const a = await sender.send(owner.address, bytes("once"), { idempotency_key: "idem-1" });
    const b = await sender.send(owner.address, bytes("once"), { idempotency_key: "idem-1" });
    expect(a.body.message_id).toBe(b.body.message_id);
    expect((await owner.count())).toBe(1);
  });

  it("same body-hash within 24h dedupes without a key", async () => {
    const owner = newClient();
    const payload = rand(64);
    const a = await sender.send(owner.address, payload);
    const b = await sender.send(owner.address, payload);
    expect(a.body.message_id).toBe(b.body.message_id);
  });

  it("pagination: 120 messages page cleanly, no dupes or gaps (§12.13)", async () => {
    const owner = newClient();
    for (let i = 0; i < 120; i++) {
      await sender.send(owner.address, bytes(`m${i}-${owner.address}`));
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await owner.read(undefined, cursor, 50);
      for (const m of res.body.messages) {
        expect(seen.has(m.message_id)).toBe(false);
        seen.add(m.message_id);
      }
      if (!res.body.next_cursor) break;
      cursor = res.body.next_cursor;
    }
    expect(seen.size).toBe(120);
  }, 120_000);

  it("tolerant send: unknown fields are ignored, stringified numbers coerced (Postel's law)", async () => {
    // Previously .strict() rejected these and dumped real senders into the
    // probe bucket / a 400. Now we accept a slightly-loose but valid body.
    const extra = await fetch(`${BASE()}/v1/mb/${newClient().address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "text/plain", body_b64: "aGk=", memo: "ignored" }),
    });
    expect(extra.status).toBe(201); // free instance: unknown field stripped, message stored

    const coerced = await fetch(`${BASE()}/v1/mb/${newClient().address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "text/plain", body_b64: "aGk=", ttl_days: "45" }),
    });
    expect(coerced.status).toBe(201); // "45" coerced to 45, not rejected
  });
});

describe("keys + require_e2e (§12.5-6a)", () => {
  it("directory 404 pre-registration; registration; e2e enforcement", async () => {
    const owner = newClient();
    const pre = await fetch(`${BASE()}/v1/directory/${owner.address}`);
    expect(pre.status).toBe(404);

    const reg = await owner.registerKey(true);
    expect(reg.status).toBe(200);

    const dir = await fetch(`${BASE()}/v1/directory/${owner.address}`);
    expect(dir.status).toBe(200);
    const dirBody = (await dir.json()) as { require_e2e: boolean; enc_pubkey: string };
    expect(dirBody.require_e2e).toBe(true);

    // Plaintext to a require_e2e mailbox → E2E_REQUIRED, no message stored.
    const plain = await fetch(`${BASE()}/v1/mb/${owner.address}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content_type: "application/json",
        body_b64: btoa(JSON.stringify({ hello: "world", filler: "y".repeat(120) })),
        encrypted: false,
      }),
    });
    expect(plain.status).toBe(400);
    expect(((await plain.json()) as { error: string }).error).toBe("E2E_REQUIRED");
    expect(await owner.count()).toBe(0);

    // Client auto-seals → accepted → decrypts to the original.
    const secret = bytes("the verdict you paid for");
    const sent = await sender.send(owner.address, secret, { content_type: "application/octet-stream" });
    expect(sent.status).toBe(201);
    const read = await owner.read();
    const sealed = await owner.fetchBody(read.body.messages[0]!);
    const { sealedBoxOpen } = await import("../../client/index.ts");
    const opened = sealedBoxOpen(sealed!, reg.keyPair.publicKey, reg.keyPair.secretKey);
    expect(new TextDecoder().decode(opened!)).toBe("the verdict you paid for");
  });

  it("private_count: opted-in mailbox answers like a never-used address (#767.3)", async () => {
    const owner = newClient();
    const auth = await owner.challenge();
    const kp = (await import("tweetnacl")).default.box.keyPair();
    const encPubkey = btoa(String.fromCharCode(...kp.publicKey));
    const keySig = await owner.account.signMessage({
      message: `veritap-locker:register-key:${owner.address}:${encPubkey}`,
    });
    const reg = await fetch(`${BASE()}/v1/mb/${owner.address}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...auth, enc_pubkey: encPubkey, key_sig: keySig, private_count: true }),
    });
    expect(reg.status).toBe(200);
    await sender.send(owner.address, bytes(`private-${owner.address}`), { encrypt: true });
    const count = (await (await fetch(`${BASE()}/v1/mb/${owner.address}/count`)).json()) as { unacked: number };
    expect(count.unacked).toBe(0); // hidden
    const read = await owner.read(); // owner still sees it
    expect(read.body.messages.length).toBe(1);
  });

  it("invalid key_sig rejected (§12.6)", async () => {
    const owner = newClient();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const kpB64 = btoa(String.fromCharCode(...rand(32)));
    const badSig = await stranger.signMessage({
      message: `veritap-locker:register-key:${owner.address}:${kpB64}`,
    });
    const auth = await owner.challenge();
    const res = await fetch(`${BASE()}/v1/mb/${owner.address}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...auth, enc_pubkey: kpB64, key_sig: badSig }),
    });
    expect(res.status).toBe(401);
  });
});

describe("checkpoints + credit (§12.15-18)", () => {
  it("versioning keeps last 3; latest and pinned load (§12.15)", async () => {
    const owner = newClient();
    await fetch(`${BASE()}/v1/mb/${owner.address}/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_microusd: 1_000_000 }),
    });
    for (const v of ["one", "two", "three", "four"]) {
      const r = await owner.checkpointSave("brain", bytes(`state-${v}`));
      expect(r.status).toBe(200);
    }
    const latest = await owner.checkpointLoad("brain");
    expect(new TextDecoder().decode(latest!)).toBe("state-four");
    const v2 = await owner.checkpointLoad("brain", 2);
    expect(new TextDecoder().decode(v2!)).toBe("state-two");
    const v1 = await owner.challenge().then((auth) =>
      fetch(`${BASE()}/v1/mb/${owner.address}/locker/brain/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...auth, version: 1 }),
      }),
    );
    expect(v1.status).toBe(404); // evicted
  });

  it("credit status projects burn (§12.17)", async () => {
    const owner = newClient();
    await fetch(`${BASE()}/v1/mb/${owner.address}/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_microusd: 2_000_000 }),
    });
    await owner.checkpointSave("s", rand(1024 * 1024));
    const status = (await (await fetch(`${BASE()}/v1/mb/${owner.address}/status`)).json()) as {
      balance_microusd: number;
      stored_bytes: number;
      daily_burn_microusd: number;
    };
    expect(status.balance_microusd).toBe(2_000_000);
    expect(status.stored_bytes).toBe(1024 * 1024);
    // 1 MiB at $0.50/GB-mo ≈ 17.5 microusd/day, ceil → 18.
    expect(status.daily_burn_microusd).toBeGreaterThan(15);
    expect(status.daily_burn_microusd).toBeLessThan(25);
  });

  it("slot-name validation + concurrent saves strictly ordered (§12.16, 18)", async () => {
    const owner = newClient();
    await fetch(`${BASE()}/v1/mb/${owner.address}/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_microusd: 1_000_000 }),
    });
    const bad = await owner.challenge().then((auth) =>
      fetch(`${BASE()}/v1/mb/${owner.address}/locker/Bad!Slot`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...auth, size_bytes: 10 }),
      }),
    );
    expect(bad.status).toBe(400);

    const [s1, s2] = await Promise.all([
      owner.checkpointSave("race", bytes("a")),
      owner.checkpointSave("race", bytes("b")),
    ]);
    const versions = [
      (s1.body as { version: number }).version,
      (s2.body as { version: number }).version,
    ].sort();
    expect(versions).toEqual([1, 2]); // no lost writes
  });
});

describe("cron + fuzz + burst (§12.26-28)", () => {
  it("scheduled sweeps are idempotent and safe to double-run (§12.26)", async () => {
    const r1 = await fetch(`${BASE()}/__scheduled?cron=*/15+*+*+*+*`);
    const r2 = await fetch(`${BASE()}/__scheduled?cron=*/15+*+*+*+*`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("schema fuzz: no 500s, only 4xx with machine-readable errors (§12.27)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.json({ maxDepth: 3 }), async (body) => {
        const res = await fetch(`${BASE()}/v1/mb/${sender.address}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        expect(res.status).toBeLessThan(500);
        if (res.status >= 400) {
          const parsed = (await res.json()) as { error?: string };
          expect(parsed.error).toBeTruthy();
        }
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  it("burst: 100 sends all durable, count correct (§12.28 scaled)", async () => {
    const owner = newClient();
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => sender.send(owner.address, bytes(`burst-${i}-${owner.address}`))),
    );
    console.log(`burst: 100 sends in ${Date.now() - t0}ms`);
    expect(await owner.count()).toBe(100);
  }, 120_000);
});
