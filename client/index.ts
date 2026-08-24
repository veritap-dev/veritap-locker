/**
 * @veritap/locker-client — §10 reference implementation (~200 lines).
 * nonce→sign→read/ack, sealed-box encrypt/decrypt (libsodium-compatible
 * crypto_box_seal: nonce = blake2b(epk ‖ recipient_pk, 24)), checkpoint
 * save/load. Doubles as the e2e test harness and the doc example.
 *
 * The respawn story, executable: construct with ONLY the wallet private key
 * and the base URL — no tokens, no state — and you can drain your mail.
 */

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import nacl from "tweetnacl";
import { blake2b } from "blakejs";

export interface Envelope {
  message_id: string;
  producer: string | null;
  tag: string | null;
  content_type: string;
  size: number;
  encrypted: boolean;
  created_at: string;
  expires_at: string;
  body_b64?: string;
  body_url?: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** libsodium-compatible sealed box. */
export function sealedBoxSeal(message: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  const eph = nacl.box.keyPair();
  const nonceInput = new Uint8Array(64);
  nonceInput.set(eph.publicKey);
  nonceInput.set(recipientPk, 32);
  const nonce = blake2b(nonceInput, undefined, 24);
  const boxed = nacl.box(message, nonce, recipientPk, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey);
  out.set(boxed, 32);
  return out;
}

export function sealedBoxOpen(sealed: Uint8Array, pk: Uint8Array, sk: Uint8Array): Uint8Array | null {
  if (sealed.length < 48) return null;
  const epk = sealed.slice(0, 32);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk);
  nonceInput.set(pk, 32);
  const nonce = blake2b(nonceInput, undefined, 24);
  return nacl.box.open(sealed.slice(32), nonce, epk, sk);
}

/** Current enc-key derivation version. Old messages stay openable with old
 * versions; a rotation bumps this and re-registers. */
export const ENC_KEY_VERSION = "v1" as const;

/**
 * #771 mandate — the enc keypair is DERIVED from the wallet, not a second
 * secret. EIP-191 is deterministic (RFC 6979), so signing a fixed
 * domain-separated statement is reproducible; HKDF-SHA256 over that signature
 * yields the X25519 seed. A respawned agent holding ONLY its wallet key
 * regenerates the same keypair — the one-secret property the whole thesis
 * rests on. Agents with a non-deterministic signer must instead persist the
 * seed (documented fallback, not built).
 */
export async function deriveEncKeyPair(
  signMessage: (m: string) => Promise<`0x${string}`>,
  version: string = ENC_KEY_VERSION,
): Promise<nacl.BoxKeyPair> {
  const statement = `veritap-locker:enc-key:${version}`;
  const sig = await signMessage(statement);
  const sigBytes = Uint8Array.from((sig.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const hk = await crypto.subtle.importKey("raw", sigBytes as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(statement), info: new Uint8Array() },
    hk,
    256,
  );
  return nacl.box.keyPair.fromSecretKey(new Uint8Array(bits));
}

export class LockerClient {
  readonly baseUrl: string;
  readonly account: PrivateKeyAccount;
  // No TS parameter properties: keeps the file runnable under Node's native
  // type-stripping (strip-only mode rejects them).
  constructor(baseUrl: string, privateKey: `0x${string}`) {
    this.baseUrl = baseUrl;
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): string {
    return this.account.address;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** nonce → sign. One nonce authorizes one request. */
  async challenge(): Promise<{ nonce: string; signature: string }> {
    const { body } = await this.json<{ nonce: string }>(`/v1/nonce?address=${this.address}`);
    const signature = await this.account.signMessage({ message: body.nonce });
    return { nonce: body.nonce, signature };
  }

  async count(): Promise<number> {
    const { body } = await this.json<{ unacked: number }>(`/v1/mb/${this.address}/count`);
    return body.unacked;
  }

  async read(filter?: { producer?: string; tag?: string; since?: string }, cursor?: string, limit?: number) {
    const auth = await this.challenge();
    return this.json<{ messages: Envelope[]; next_cursor: string | null }>(`/v1/mb/${this.address}/read`, {
      method: "POST",
      body: JSON.stringify({ ...auth, filter, cursor, limit }),
    });
  }

  async ack(messageIds: string[]) {
    const auth = await this.challenge();
    return this.json<{ acked: number }>(`/v1/mb/${this.address}/ack`, {
      method: "POST",
      body: JSON.stringify({ ...auth, message_ids: messageIds }),
    });
  }

  /** Producer-side send. Auto-seals when the directory demands E2E. */
  async send(
    to: string,
    bodyBytes: Uint8Array,
    opts?: { producer?: string; tag?: string; content_type?: string; ttl_days?: number; idempotency_key?: string; encrypt?: boolean },
  ) {
    let bytes = bodyBytes;
    let encrypted = false;
    const dir = await this.json<{ enc_pubkey?: string; require_e2e?: boolean }>(`/v1/directory/${to}`);
    if (dir.status === 200 && dir.body.enc_pubkey && (opts?.encrypt || dir.body.require_e2e)) {
      bytes = sealedBoxSeal(bodyBytes, unb64(dir.body.enc_pubkey));
      encrypted = true;
    }
    return this.json<{ message_id: string; expires_at: string; upload_url?: string }>(`/v1/mb/${to}/messages`, {
      method: "POST",
      body: JSON.stringify({
        producer: opts?.producer,
        tag: opts?.tag,
        content_type: opts?.content_type ?? "application/octet-stream",
        body_b64: b64(bytes),
        encrypted,
        ttl_days: opts?.ttl_days,
        idempotency_key: opts?.idempotency_key,
      }),
    });
  }

  /**
   * Register an X25519 key. By default DERIVES it from the wallet (#771), so
   * a respawned agent regenerates the same key with no stored secret. Pass an
   * explicit keyPair only for the non-deterministic-signer fallback.
   */
  async registerKey(requireE2e: boolean, keyPair?: nacl.BoxKeyPair, privateCount = false) {
    const kp = keyPair ?? (await deriveEncKeyPair((m) => this.account.signMessage({ message: m })));
    const encPubkey = b64(kp.publicKey);
    const statement = `veritap-locker:register-key:${this.address}:${encPubkey}`;
    const keySig = await this.account.signMessage({ message: statement });
    const auth = await this.challenge();
    const res = await this.json(`/v1/mb/${this.address}/keys`, {
      method: "POST",
      body: JSON.stringify({ ...auth, enc_pubkey: encPubkey, key_sig: keySig, require_e2e: requireE2e, private_count: privateCount }),
    });
    return { ...res, keyPair: kp };
  }

  /**
   * Save a checkpoint. Pass `expectedVersion` for optimistic concurrency: the
   * write lands only if the slot is still at that version (else status 409
   * CONFLICT with { current_version }), so two agents editing shared state can't
   * silently clobber each other. Omit it for last-write-wins append.
   */
  async checkpointSave(slot: string, bytes: Uint8Array, contentType = "application/octet-stream", expectedVersion?: number) {
    const auth = await this.challenge();
    const res = await this.json<{ version: number; upload_url: string; current_version?: number }>(`/v1/mb/${this.address}/locker/${slot}`, {
      method: "PUT",
      body: JSON.stringify({ ...auth, size_bytes: bytes.byteLength, content_type: contentType, ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}) }),
    });
    if (res.status !== 200) return res;
    const up = await fetch(res.body.upload_url, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
      headers: { "Content-Type": contentType },
    });
    if (up.status !== 201) throw new Error(`upload failed: ${up.status}`);
    return res;
  }

  async checkpointLoad(slot: string, version: number | "latest" = "latest"): Promise<Uint8Array | null> {
    const m = await this.checkpointLoadMeta(slot, version);
    return m ? m.bytes : null;
  }

  /** Like checkpointLoad but also returns the version loaded — pass that version
   * back as `expectedVersion` to checkpointSave for a safe read-modify-write. */
  async checkpointLoadMeta(slot: string, version: number | "latest" = "latest"): Promise<{ bytes: Uint8Array; version: number } | null> {
    const auth = await this.challenge();
    const res = await this.json<{ body_url?: string; version?: number }>(`/v1/mb/${this.address}/locker/${slot}/get`, {
      method: "POST",
      body: JSON.stringify({ ...auth, version }),
    });
    if (res.status !== 200 || !res.body.body_url) return null;
    const blob = await fetch(res.body.body_url);
    if (!blob.ok) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), version: res.body.version ?? 0 };
  }

  /**
   * #771 — the respawn-proof read: derive the enc key from the wallet, confirm
   * it matches the registered directory entry (else a clear error, not a
   * silent decrypt failure), open every sealed body. Requires ONLY the wallet.
   */
  async readAndDecrypt(): Promise<Array<{ envelope: Envelope; plaintext: Uint8Array | null }>> {
    const kp = await deriveEncKeyPair((m) => this.account.signMessage({ message: m }));
    const derivedPub = b64(kp.publicKey);
    const dir = await this.json<{ enc_pubkey?: string }>(`/v1/directory/${this.address}`);
    if (dir.status === 200 && dir.body.enc_pubkey && dir.body.enc_pubkey !== derivedPub)
      throw new Error(
        `derived enc key (${derivedPub.slice(0, 12)}…) does not match the registered directory key ` +
          `(${dir.body.enc_pubkey.slice(0, 12)}…) — this mailbox was registered with a different key ` +
          `(non-deterministic signer? wrong version? persist the seed).`,
      );
    const read = await this.read();
    const out = [];
    for (const env of read.body.messages) {
      const bytes = await this.fetchBody(env);
      let plaintext: Uint8Array | null = bytes;
      if (env.encrypted && bytes) plaintext = sealedBoxOpen(bytes, kp.publicKey, kp.secretKey);
      out.push({ envelope: env, plaintext });
    }
    return out;
  }

  async fetchBody(env: Envelope): Promise<Uint8Array | null> {
    if (env.body_b64) return unb64(env.body_b64);
    if (env.body_url) {
      const res = await fetch(env.body_url);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    }
    return null;
  }
}
