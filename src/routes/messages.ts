/**
 * §3 message API: send (producer, metered), read/ack (owner, signed, free),
 * count (free peek, privacy-bounded).
 */

import { Hono } from "hono";
import { z } from "zod";

import { canonicalAddress, issueNonce, rateLimited, verifySigned } from "../auth.ts";
import { paymentGate } from "../payment.ts";
import { signedGetUrl, signedPutUrl } from "../blob.ts";
import { err, LIMITS, priceForMessage } from "../codes.ts";
import { e2eGate } from "../entropy.ts";
import type { Env, MessageRow } from "../types.ts";
import { nowS, sha256Hex, transition } from "../types.ts";

export const messages = new Hono<{ Bindings: Env }>();

const b64ToBytes = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const newMessageId = () =>
  `lm_${Date.now().toString(36)}${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => (b % 36).toString(36)).join("")}`;

const SendSchema = z
  .object({
    producer: z.string().max(200).optional(),
    tag: z.string().max(64).optional(),
    content_type: z.string().max(120),
    body_b64: z.string().optional(),
    body_upload: z.boolean().optional(),
    size_bytes: z.number().int().positive().optional(),
    encrypted: z.boolean().optional(),
    ttl_days: z.number().int().min(1).max(LIMITS.ttl_max_days).optional(),
    idempotency_key: z.string().max(128).optional(),
  })
  .strict(); // unknown fields rejected (§3)

/** GET /v1/nonce?address=0x… (mounted at app level but lives with auth flows) */
export const nonceRoute = new Hono<{ Bindings: Env }>().get("/", async (c) => {
  const address = canonicalAddress(c.req.query("address") ?? "");
  if (!address) return err("VALIDATION_ERROR", "address must be a valid EVM address.", 400);
  const ip = c.req.header("cf-connecting-ip") ?? "?";
  if (await rateLimited(c.env, `nonce:${address}:${ip}`, LIMITS.rate_nonce_hr))
    return err("RATE_LIMITED", "Nonce issuance limit reached.", 429);
  return c.json(await issueNonce(c.env, address));
});

// ---- send: POST /v1/mb/:address/messages (x402-metered; Phase A pass-through) ----
messages.post("/:address/messages", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Mailbox address must be a valid EVM address.", 400);

  const parsed = SendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return err("VALIDATION_ERROR", "Invalid send body.", 400, {
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  const p = parsed.data;

  // Body: inline XOR upload.
  let bytes: Uint8Array | null = null;
  let size: number;
  if (p.body_b64 !== undefined && !p.body_upload) {
    bytes = b64ToBytes(p.body_b64);
    if (!bytes) return err("VALIDATION_ERROR", "body_b64 is not valid base64.", 400);
    size = bytes.byteLength;
  } else if (p.body_upload && p.size_bytes) {
    size = p.size_bytes;
  } else {
    return err("VALIDATION_ERROR", "Provide body_b64, or body_upload:true with size_bytes.", 400);
  }

  // Size caps BEFORE payment (§3): oversize → 413, no charge.
  if (size > LIMITS.msg_max)
    return err("PAYLOAD_TOO_LARGE", `Max message size is ${LIMITS.msg_max} bytes.`, 413);
  if (bytes && size > LIMITS.inline_max)
    return err("VALIDATION_ERROR", `Inline bodies cap at ${LIMITS.inline_max} bytes; use body_upload.`, 400);

  // Mailbox-full backpressure BEFORE payment (§3).
  const load = await c.env.DB.prepare(
    `SELECT count(*) AS n, COALESCE(sum(size),0) AS bytes FROM messages WHERE address=? AND acked_at IS NULL`,
  )
    .bind(address)
    .first<{ n: number; bytes: number }>();
  if ((load?.n ?? 0) >= LIMITS.mailbox_max_unacked || (load?.bytes ?? 0) + size > LIMITS.mailbox_max_bytes)
    return err("MAILBOX_FULL", "Recipient mailbox is at capacity; not charged.", 409);

  // §5 server-enforced E2E, checked BEFORE payment: no charge on rejection.
  const keyRow = await c.env.DB.prepare(
    `SELECT require_e2e FROM keys WHERE address=? AND superseded_at IS NULL ORDER BY registered_at DESC LIMIT 1`,
  )
    .bind(address)
    .first<{ require_e2e: number }>();
  if (keyRow?.require_e2e) {
    if (!p.encrypted)
      return err("E2E_REQUIRED", "This mailbox only accepts sealed-box ciphertext (declare encrypted: true).", 400, {
        directory: `${c.env.PUBLIC_BASE_URL}/v1/directory/${address}`,
      });
    if (bytes) {
      const gate = e2eGate(bytes);
      if (!gate.pass)
        return err("E2E_REQUIRED", `Body rejected by ciphertext gate: ${gate.reason}`, 400, {
          directory: `${c.env.PUBLIC_BASE_URL}/v1/directory/${address}`,
        });
    }
    // Upload path: gate re-checked at read time is not possible (we never read
    // R2 bodies) — the honest structural limit; documented.
  }

  const ttlDays = p.ttl_days ?? LIMITS.ttl_default_days;
  const priceMicro = priceForMessage(size, ttlDays);
  // Phase A: x402 middleware stubbed to pass-through; price recorded as owed.

  const bodyHash = bytes ? await sha256Hex(bytes) : await sha256Hex(`upload:${address}:${size}:${p.idempotency_key ?? ""}`);

  // §3 idempotency: same key, or same body-hash within 24h → same message, no double charge.
  const dayAgo = nowS() - 86_400;
  const existing = await c.env.DB.prepare(
    p.idempotency_key
      ? `SELECT message_id, expires_at, r2_key FROM messages WHERE address=?1 AND idempotency_key=?2 LIMIT 1`
      : `SELECT message_id, expires_at, r2_key FROM messages WHERE address=?1 AND body_hash=?2 AND created_at>?3 LIMIT 1`,
  )
    .bind(...(p.idempotency_key ? [address, p.idempotency_key] : [address, bodyHash, dayAgo]))
    .first<{ message_id: string; expires_at: number; r2_key: string | null }>();
  if (existing) {
    return c.json(
      {
        message_id: existing.message_id,
        expires_at: new Date(existing.expires_at * 1000).toISOString(),
        ...(existing.r2_key && !bytes
          ? { upload_url: await signedPutUrl(c.env, existing.r2_key, size) }
          : {}),
        idempotent_replay: true,
      },
      201,
    );
  }

  // §6 x402 gate — after free rejections and idempotency replay, before any
  // row exists. Settle-before-create: see payment.ts ordering rationale.
  const gate = await paymentGate(
    c.env,
    c.req.raw,
    priceMicro,
    `${c.env.PUBLIC_BASE_URL}/v1/mb/${address}/messages`,
    `Deliver a ${size}-byte message (${ttlDays}d retention) to the wallet-addressed mailbox ${address}.`,
    `send:${address}`,
  );
  if (!gate.ok) return gate.response!;

  const id = newMessageId();
  const created = nowS();
  const expires = created + ttlDays * 86_400;
  const r2key = bytes ? null : `msg/${address}/${id}`;

  if (bytes && r2key === null) {
    await c.env.DB.prepare(
      `INSERT INTO messages (message_id, address, producer, tag, content_type, size, inline_body, r2_key,
         encrypted, created_at, expires_at, idempotency_key, body_hash, paid_microusd)
       VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)`,
    )
      .bind(
        id, address, p.producer ?? null, p.tag ?? null, p.content_type, size,
        bytes as unknown as ArrayBuffer, p.encrypted ? 1 : 0, created, expires,
        p.idempotency_key ?? null, bodyHash, priceMicro,
      )
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO messages (message_id, address, producer, tag, content_type, size, inline_body, r2_key,
         encrypted, created_at, expires_at, idempotency_key, body_hash, paid_microusd)
       VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
    )
      .bind(
        id, address, p.producer ?? null, p.tag ?? null, p.content_type, size, r2key,
        p.encrypted ? 1 : 0, created, expires, p.idempotency_key ?? null, bodyHash, priceMicro,
      )
      .run();
  }
  await transition(c.env, "message", id, null, "stored", `${size}b ttl${ttlDays}d $${priceMicro / 1e6}`);

  return c.json(
    {
      message_id: id,
      expires_at: new Date(expires * 1000).toISOString(),
      ...(r2key ? { upload_url: await signedPutUrl(c.env, r2key, size) } : {}),
    },
    201,
  );
});

// ---- read: POST /v1/mb/:address/read (signed, free, non-destructive) ----
messages.post("/:address/read", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  if (await rateLimited(c.env, `read:${address}`, LIMITS.rate_read_hr))
    return err("RATE_LIMITED", "Read limit reached.", 429);

  const body = (await c.req.json().catch(() => null)) as {
    nonce?: string; signature?: string; cursor?: string; limit?: number;
    filter?: { producer?: string; tag?: string; since?: string };
  } | null;
  if (!body?.nonce || !body.signature) return err("VALIDATION_ERROR", "nonce and signature required.", 400);
  const auth = await verifySigned(c.env, address, body.nonce, body.signature);
  if (!auth.ok) return err(auth.code, auth.message, auth.code === "RATE_LIMITED" ? 429 : 401);

  const limit = Math.min(body.limit ?? 50, LIMITS.read_page_max);
  // Keyset pagination on (created_at, message_id): timestamps are seconds, so
  // a burst lands many messages in one second — a created_at-only cursor
  // stalls after the first page (caught by §12.13).
  const [curTs, curId] = body.cursor ? (body.cursor.split("|") as [string, string?]) : ["0", ""];
  const conds: string[] = [
    "address=?1",
    "acked_at IS NULL",
    "expires_at>?2",
    "(created_at>?3 OR (created_at=?3 AND message_id>?4))",
  ];
  const binds: unknown[] = [address, nowS(), Number(curTs), curId ?? ""];
  if (body.filter?.producer) { conds.push(`producer=?${binds.length + 1}`); binds.push(body.filter.producer); }
  if (body.filter?.tag) { conds.push(`tag=?${binds.length + 1}`); binds.push(body.filter.tag); }
  if (body.filter?.since) { conds.push(`created_at>=?${binds.length + 1}`); binds.push(Math.floor(Date.parse(body.filter.since) / 1000)); }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE ${conds.join(" AND ")} ORDER BY created_at, message_id LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<MessageRow>();

  const out = [];
  for (const m of results ?? []) {
    out.push({
      message_id: m.message_id,
      producer: m.producer,
      tag: m.tag,
      content_type: m.content_type,
      size: m.size,
      encrypted: Boolean(m.encrypted),
      created_at: new Date(m.created_at * 1000).toISOString(),
      expires_at: new Date(m.expires_at * 1000).toISOString(),
      ...(m.inline_body
        ? { body_b64: btoa(String.fromCharCode(...new Uint8Array(m.inline_body))) }
        : m.r2_key
          ? { body_url: await signedGetUrl(c.env, m.r2_key) }
          : {}),
    });
  }
  const last = (results ?? [])[results!.length - 1];
  return c.json({
    messages: out,
    next_cursor: out.length === limit && last ? `${last.created_at}|${last.message_id}` : null,
  });
});

// ---- ack: POST /v1/mb/:address/ack (signed; ack = delete) ----
messages.post("/:address/ack", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const body = (await c.req.json().catch(() => null)) as
    | { nonce?: string; signature?: string; message_ids?: string[] }
    | null;
  if (!body?.nonce || !body.signature || !Array.isArray(body.message_ids))
    return err("VALIDATION_ERROR", "nonce, signature, message_ids required.", 400);
  const auth = await verifySigned(c.env, address, body.nonce, body.signature);
  if (!auth.ok) return err(auth.code, auth.message, auth.code === "RATE_LIMITED" ? 429 : 401);

  let acked = 0;
  for (const id of body.message_ids.slice(0, 500)) {
    const row = await c.env.DB.prepare(
      `SELECT r2_key FROM messages WHERE message_id=? AND address=? AND acked_at IS NULL`,
    )
      .bind(id, address)
      .first<{ r2_key: string | null }>();
    if (!row) continue; // foreign/unknown ids: silent skip — no existence leak (§12.10)
    await c.env.DB.prepare(`UPDATE messages SET acked_at=?, inline_body=NULL WHERE message_id=?`)
      .bind(nowS(), id)
      .run();
    if (row.r2_key) await c.env.BODIES.delete(row.r2_key).catch(() => {});
    acked++;
  }
  await transition(c.env, "mailbox", address, null, "acked", `${acked} messages`);
  return c.json({ acked });
});

// ---- count: GET /v1/mb/:address/count (free, unauthenticated, count only) ----
messages.get("/:address/count", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const ip = c.req.header("cf-connecting-ip") ?? "?";
  if (await rateLimited(c.env, `count:${address}:${ip}`, LIMITS.rate_count_hr))
    return err("RATE_LIMITED", "Count limit reached.", 429);
  const row = await c.env.DB.prepare(
    `SELECT count(*) AS n FROM messages WHERE address=? AND acked_at IS NULL AND expires_at>?`,
  )
    .bind(address, nowS())
    .first<{ n: number }>();
  return c.json({ unacked: row?.n ?? 0 });
});
