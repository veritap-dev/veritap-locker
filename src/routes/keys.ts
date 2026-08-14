/**
 * §5 key registration + directory. "We can't read your mail, and can prove
 * it": the wallet-signed registration record is the proof the enc key belongs
 * to the address. Directory 404s for unregistered addresses so it leaks
 * nothing about who has mail.
 */

import { Hono } from "hono";
import { recoverMessageAddress, getAddress } from "viem";

import { canonicalAddress, verifySigned } from "../auth.ts";
import { err } from "../codes.ts";
import type { Env } from "../types.ts";
import { nowS, transition } from "../types.ts";

export const keys = new Hono<{ Bindings: Env }>();

// POST /v1/mb/:address/keys  { nonce, signature, enc_pubkey, key_sig, require_e2e? }
//   signature: auth (over nonce). key_sig: wallet signature over the
//   registration statement binding enc_pubkey — retained as the public proof.
keys.post("/:address/keys", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const body = (await c.req.json().catch(() => null)) as
    | { nonce?: string; signature?: string; enc_pubkey?: string; key_sig?: string; require_e2e?: boolean }
    | null;
  if (!body?.nonce || !body.signature || !body.enc_pubkey || !body.key_sig)
    return err("VALIDATION_ERROR", "nonce, signature, enc_pubkey, key_sig required.", 400);
  if (!/^[A-Za-z0-9+/=]{40,64}$/.test(body.enc_pubkey))
    return err("VALIDATION_ERROR", "enc_pubkey must be a base64 X25519 public key (32 bytes).", 400);

  const auth = await verifySigned(c.env, address, body.nonce, body.signature);
  if (!auth.ok) return err(auth.code, auth.message, auth.code === "RATE_LIMITED" ? 429 : 401);

  // The registration statement the wallet must have signed (public proof).
  const registeredAt = nowS();
  const statement = `veritap-locker:register-key:${address}:${body.enc_pubkey}`;
  let recovered: string | null = null;
  try {
    recovered = await recoverMessageAddress({ message: statement, signature: body.key_sig as `0x${string}` });
  } catch {
    recovered = null;
  }
  if (!recovered || getAddress(recovered) !== address)
    return err("INVALID_SIGNATURE", "key_sig must be the wallet's signature over the registration statement.", 401, {
      statement,
    });

  await c.env.DB.prepare(`UPDATE keys SET superseded_at=? WHERE address=? AND superseded_at IS NULL`)
    .bind(registeredAt, address)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO keys (address, enc_pubkey, wallet_sig, require_e2e, registered_at) VALUES (?,?,?,?,?)`,
  )
    .bind(address, body.enc_pubkey, body.key_sig, body.require_e2e ? 1 : 0, registeredAt)
    .run();
  await transition(c.env, "key", address, null, "registered", body.require_e2e ? "require_e2e" : "optional");
  return c.json({ registered_at: new Date(registeredAt * 1000).toISOString(), require_e2e: Boolean(body.require_e2e) });
});

// GET /v1/directory/:address — public; 404 pre-registration (no existence leak).
export const directory = new Hono<{ Bindings: Env }>().get("/:address", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const row = await c.env.DB.prepare(
    `SELECT enc_pubkey, wallet_sig, require_e2e, registered_at FROM keys WHERE address=? AND superseded_at IS NULL ORDER BY registered_at DESC LIMIT 1`,
  )
    .bind(address)
    .first<{ enc_pubkey: string; wallet_sig: string; require_e2e: number; registered_at: number }>();
  if (!row) return err("NOT_FOUND", "No key registered for this address.", 404);
  return c.json({
    address,
    enc_pubkey: row.enc_pubkey,
    sig: row.wallet_sig,
    statement: `veritap-locker:register-key:${address}:${row.enc_pubkey}`,
    require_e2e: Boolean(row.require_e2e),
    registered_at: new Date(row.registered_at * 1000).toISOString(),
  });
});
