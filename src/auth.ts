/**
 * §1 identity: the wallet IS the account.
 *
 * Nonce format: veritap-locker:auth:{address}:{random}:{expiry}
 * — human-readable prefix so wallet UIs show what is being signed, and so the
 * signature can never replay as a transaction or another service's login.
 *
 * Nonces are stored HMAC-hashed (NONCE_HMAC_KEY): a leaked D1 dump yields
 * nothing signable. Single-use: burned on FIRST verification attempt, success
 * or failure. Bound to the address that requested them.
 */

import { getAddress, recoverMessageAddress, isAddress } from "viem";
import type { Env } from "./types.ts";
import { LIMITS } from "./codes.ts";
import { sawAddress } from "./metrics.ts";

const enc = new TextEncoder();

export async function hmacHex(env: Env, data: string): Promise<string> {
  // HIGH-3: this HMAC is the trust root for nonces AND every blob/upload signed
  // URL. A missing secret must FAIL CLOSED — a hardcoded fallback would let
  // anyone forge cross-tenant blob read/write. No usable default, ever.
  if (!env.NONCE_HMAC_KEY || env.NONCE_HMAC_KEY.length < 16)
    throw new Error("NONCE_HMAC_KEY is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.NONCE_HMAC_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** EIP-55 canonicalization; throws on garbage. */
export function canonicalAddress(input: string): string | null {
  try {
    if (!isAddress(input, { strict: false })) return null;
    return getAddress(input.toLowerCase() as `0x${string}`);
  } catch {
    return null;
  }
}

export async function issueNonce(env: Env, address: string): Promise<{ nonce: string; expires_at: string }> {
  const expiry = Math.floor(Date.now() / 1000) + LIMITS.nonce_ttl_seconds;
  const rand = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const nonce = `veritap-locker:auth:${address}:${rand}:${expiry}`;
  await env.DB.prepare(`INSERT INTO nonces (nonce_hash, address, expires_at) VALUES (?,?,?)`)
    .bind(await hmacHex(env, nonce), address, expiry)
    .run();
  return { nonce, expires_at: new Date(expiry * 1000).toISOString() };
}

export type AuthResult =
  | { ok: true; address: string }
  | { ok: false; code: "INVALID_SIGNATURE" | "NONCE_EXPIRED" | "NONCE_USED" | "RATE_LIMITED"; message: string };

/**
 * Verify signature over nonce for address. Burn-on-first-attempt is atomic:
 * the conditional UPDATE marks used_at, and exactly one concurrent caller
 * wins (§12 test 22).
 */
export async function verifySigned(
  env: Env,
  address: string,
  nonce: string,
  signature: string,
): Promise<AuthResult> {
  // Backoff check before any work (§8: 5 fails -> 15-min cooldown).
  const coolBucket = `sigfail:${address}`;
  const nowS = Math.floor(Date.now() / 1000);
  const cool = await env.DB.prepare(
    `SELECT n, window_start FROM rate_counters WHERE bucket=? ORDER BY window_start DESC LIMIT 1`,
  )
    .bind(coolBucket)
    .first<{ n: number; window_start: number }>();
  if (
    cool &&
    cool.n >= LIMITS.sig_fail_backoff_after &&
    nowS - cool.window_start < LIMITS.sig_fail_cooldown_seconds
  )
    return { ok: false, code: "RATE_LIMITED", message: "Too many failed signatures; cool down." };

  // Prefix binding: a signature over some other service's string never lands here.
  if (!nonce.startsWith(`veritap-locker:auth:${address}:`))
    return { ok: false, code: "INVALID_SIGNATURE", message: "Nonce is not bound to this address/service." };

  const hash = await hmacHex(env, nonce);
  const row = await env.DB.prepare(`SELECT address, expires_at, used_at FROM nonces WHERE nonce_hash=?`)
    .bind(hash)
    .first<{ address: string; expires_at: number; used_at: number | null }>();
  if (!row) return { ok: false, code: "INVALID_SIGNATURE", message: "Unknown nonce." };
  if (row.address !== address)
    return { ok: false, code: "INVALID_SIGNATURE", message: "Nonce bound to a different address." };

  // Burn atomically — exactly one attempt (success OR failure) consumes it.
  const burn = await env.DB.prepare(`UPDATE nonces SET used_at=? WHERE nonce_hash=? AND used_at IS NULL`)
    .bind(nowS, hash)
    .run();
  if (!burn.meta.changes) return { ok: false, code: "NONCE_USED", message: "Nonce already used." };
  if (row.expires_at < nowS) return { ok: false, code: "NONCE_EXPIRED", message: "Nonce expired." };

  let recovered: string | null = null;
  try {
    recovered = await recoverMessageAddress({
      message: nonce,
      signature: signature as `0x${string}`,
    });
  } catch {
    recovered = null;
  }
  if (!recovered || getAddress(recovered) !== address) {
    await bumpCounter(env, coolBucket, nowS);
    return { ok: false, code: "INVALID_SIGNATURE", message: "Signature does not recover to this address." };
  }
  await sawAddress(env, address, "auth"); // #788: a wallet proved itself — adoption signal
  return { ok: true, address };
}

export async function bumpCounter(env: Env, bucket: string, nowS: number): Promise<number> {
  // Hour-window counters for §8 limits; sigfail uses a rolling 15-min-ish
  // window; the spend breaker (#773-A1) counts whole UTC days.
  const window = bucket.startsWith("sigfail:")
    ? nowS - (nowS % LIMITS.sig_fail_cooldown_seconds)
    : bucket.startsWith("spendday:")
      ? nowS - (nowS % 86_400)
      : nowS - (nowS % 3600);
  const r = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, window_start, n) VALUES (?,?,1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET n = n + 1
     RETURNING n`,
  )
    .bind(bucket, window)
    .first<{ n: number }>();
  return r?.n ?? 1;
}

export async function rateLimited(env: Env, bucket: string, maxPerHour: number): Promise<boolean> {
  const nowS = Math.floor(Date.now() / 1000);
  return (await bumpCounter(env, bucket, nowS)) > maxPerHour;
}
