/**
 * §4 checkpoints ("dead drops to your future self") + §6 credit + status.
 * Only the owner writes; storage drawn daily from prepaid credit; last 3
 * versions kept so a dying agent's corrupt write can't destroy its predecessor.
 */

import { Hono } from "hono";

import { canonicalAddress, verifySigned } from "../auth.ts";
import { buildRequirements, paymentGate, paymentResponseHeader, paymentsEnabled, respond402 } from "../payment.ts";
import { signedGetUrl, signedPutUrl } from "../blob.ts";
import { err, LIMITS, PRICE } from "../codes.ts";
import type { Env } from "../types.ts";
import { nowS, transition } from "../types.ts";
import { tick } from "../metrics.ts";

export const lockers = new Hono<{ Bindings: Env }>();

const SLOT_RE = /^[a-z0-9_-]{1,64}$/;

async function authed(c: { env: Env }, address: string, body: { nonce?: string; signature?: string } | null) {
  if (!body?.nonce || !body.signature)
    return { res: err("VALIDATION_ERROR", "nonce and signature required.", 400) };
  const auth = await verifySigned(c.env, address, body.nonce, body.signature);
  if (!auth.ok) return { res: err(auth.code, auth.message, auth.code === "RATE_LIMITED" ? 429 : 401) };
  return { res: null };
}

async function creditState(env: Env, address: string) {
  const row = await env.DB.prepare(`SELECT balance_microusd, grace_started_at FROM credits WHERE address=?`)
    .bind(address)
    .first<{ balance_microusd: number; grace_started_at: number | null }>();
  return { balance: row?.balance_microusd ?? 0, grace: row?.grace_started_at ?? null };
}

// ---- save: PUT /v1/mb/:address/locker/:slot ----
lockers.put("/:address/locker/:slot", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const slot = c.req.param("slot");
  if (!SLOT_RE.test(slot)) return err("VALIDATION_ERROR", "Slot must match [a-z0-9_-]{1,64}.", 400);

  const body = (await c.req.json().catch(() => null)) as
    | { nonce?: string; signature?: string; size_bytes?: number; content_type?: string; expected_version?: number }
    | null;
  const a = await authed(c, address, body);
  if (a.res) return a.res;
  const size = body?.size_bytes ?? 0;
  if (!size || size > LIMITS.checkpoint_max)
    return err("PAYLOAD_TOO_LARGE", `Checkpoints cap at ${LIMITS.checkpoint_max} bytes.`, 413);

  // Grace = read-only for writes (§4). Error text is a conversion surface —
  // agents relay it verbatim to the human who can actually pay (sprint-2
  // finding), so it names every funding rail that is actually live.
  const fundingWays = (addr: string) =>
    `Fund it: ${c.env.STRIPE_SECRET_KEY ? `by card at ${c.env.PUBLIC_BASE_URL}/topup?address=${addr} (min $5), or ` : ""}x402 (USDC on Base, min $1) via POST ${c.env.PUBLIC_BASE_URL}/v1/mb/${addr}/credit.`;
  const credit = await creditState(c.env, address);
  if (credit.grace)
    return err("GRACE_READONLY", `Storage credit exhausted; this locker is read-only until topped up. Your data is safe and readable. ${fundingWays(address)}`, 402);

  // Free tier: unfunded wallets may hold up to free_tier_bytes total — enough
  // to try the product with real checkpoints, too little to freeload storage.
  if (credit.balance <= 0) {
    const stored = await c.env.DB.prepare(`SELECT COALESCE(sum(size),0) AS b FROM checkpoints WHERE address=?`)
      .bind(address)
      .first<{ b: number }>();
    if ((stored?.b ?? 0) + size > LIMITS.free_tier_bytes)
      return err(
        "INSUFFICIENT_CREDIT",
        `Free tier is ${Math.floor(LIMITS.free_tier_bytes / 1024)}KB total storage; this save would exceed it. Everything you stored stays readable. ${fundingWays(address)}`,
        402,
        { free_tier_bytes: LIMITS.free_tier_bytes, stored_bytes: stored?.b ?? 0 },
      );
  }

  // 32-slot cap → 409 + auto-ticket (§12.18).
  const slots = await c.env.DB.prepare(
    `SELECT count(DISTINCT slot) AS n FROM checkpoints WHERE address=? AND slot != ?`,
  )
    .bind(address, slot)
    .first<{ n: number }>();
  if ((slots?.n ?? 0) >= LIMITS.slots_per_address) {
    await c.env.DB.prepare(
      `INSERT INTO tickets (wallet, kind, description, created_at) VALUES (?, 'feature', 'slot cap hit (32)', ?)`,
    )
      .bind(address, nowS())
      .run();
    return err("SLOT_LIMIT", `Max ${LIMITS.slots_per_address} slots per address. A ticket was filed.`, 409);
  }

  const insert = (v: number) =>
    c.env.DB.prepare(
      `INSERT INTO checkpoints (address, slot, version, r2_key, size, content_type, created_at) VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(address, slot, v, `ckpt/${address}/${slot}/${v}`, size, body?.content_type ?? "application/octet-stream", nowS())
      .run();
  const curMax = async () =>
    (await c.env.DB.prepare(`SELECT COALESCE(max(version),0) AS v FROM checkpoints WHERE address=? AND slot=?`)
      .bind(address, slot)
      .first<{ v: number }>())?.v ?? 0;

  let version = 0;
  const expected = body?.expected_version;
  if (expected !== undefined) {
    // Optimistic concurrency (§ overwrite fix): write ONLY if the slot is still
    // at the version this writer based its edit on. Prevents two agents editing
    // shared state from silently clobbering each other — the loser gets CONFLICT
    // and must re-load + retry, instead of a lost update.
    if (!Number.isInteger(expected) || expected < 0)
      return err("VALIDATION_ERROR", "expected_version must be a non-negative integer.", 400);
    const cur = await curMax();
    if (cur !== expected)
      return err("CONFLICT", `Slot is at version ${cur}, not your expected ${expected}. Re-load and retry.`, 409, { current_version: cur });
    version = expected + 1;
    try {
      await insert(version); // PK collision => a concurrent writer took v; CAS lost
    } catch {
      return err("CONFLICT", `A concurrent write advanced the slot past ${expected}. Re-load and retry.`, 409, { current_version: await curMax() });
    }
  } else {
    // No expectation supplied: strictly-ordered append (last-write-wins HEAD).
    for (let attempt = 0; attempt < 5; attempt++) {
      version = (await curMax()) + 1;
      try {
        await insert(version);
        break;
      } catch {
        if (attempt === 4) return err("CONFLICT", "Concurrent save contention; retry.", 409);
      }
    }
  }

  // Evict beyond last 3 (§4).
  const { results: old } = await c.env.DB.prepare(
    `SELECT version, r2_key FROM checkpoints WHERE address=? AND slot=? ORDER BY version DESC LIMIT -1 OFFSET ?`,
  )
    .bind(address, slot, LIMITS.versions_per_slot)
    .all<{ version: number; r2_key: string }>();
  for (const o of old ?? []) {
    await c.env.BODIES.delete(o.r2_key).catch(() => {});
    await c.env.DB.prepare(`DELETE FROM checkpoints WHERE address=? AND slot=? AND version=?`)
      .bind(address, slot, o.version)
      .run();
  }

  await transition(c.env, "checkpoint", `${address}/${slot}`, null, `v${version}`, `${size}b`);
  await tick(c.env, "use:checkpoint_save");
  return c.json({ version, upload_url: await signedPutUrl(c.env, `ckpt/${address}/${slot}/${version}`, size) });
});

// ---- load: POST /v1/mb/:address/locker/:slot/get  (signed; body carries nonce/sig) ----
lockers.post("/:address/locker/:slot/get", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const slot = c.req.param("slot");
  const body = (await c.req.json().catch(() => null)) as
    | { nonce?: string; signature?: string; version?: number | "latest" }
    | null;
  const a = await authed(c, address, body);
  if (a.res) return a.res;

  const pin = body?.version && body.version !== "latest" ? Number(body.version) : null;
  const row = await c.env.DB.prepare(
    pin
      ? `SELECT version, r2_key, size, content_type, created_at FROM checkpoints WHERE address=?1 AND slot=?2 AND version=?3`
      : `SELECT version, r2_key, size, content_type, created_at FROM checkpoints WHERE address=?1 AND slot=?2 ORDER BY version DESC LIMIT 1`,
  )
    .bind(...(pin ? [address, slot, pin] : [address, slot]))
    .first<{ version: number; r2_key: string; size: number; content_type: string; created_at: number }>();
  if (!row) return err("NOT_FOUND", "No such slot/version.", 404);
  return c.json({
    version: row.version,
    size: row.size,
    content_type: row.content_type,
    created_at: new Date(row.created_at * 1000).toISOString(),
    body_url: await signedGetUrl(c.env, row.r2_key),
  });
});

// ---- list: POST /v1/mb/:address/locker/list (signed) ----
lockers.post("/:address/locker/list", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const body = (await c.req.json().catch(() => null)) as { nonce?: string; signature?: string } | null;
  const a = await authed(c, address, body);
  if (a.res) return a.res;
  const { results } = await c.env.DB.prepare(
    `SELECT slot, count(*) AS versions, max(version) AS latest, sum(size) AS bytes, max(created_at) AS updated_at
       FROM checkpoints WHERE address=? GROUP BY slot ORDER BY slot`,
  )
    .bind(address)
    .all();
  return c.json({ slots: results ?? [] });
});

// ---- delete: POST /v1/mb/:address/locker/:slot/delete (signed) ----
lockers.post("/:address/locker/:slot/delete", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const slot = c.req.param("slot");
  const body = (await c.req.json().catch(() => null)) as { nonce?: string; signature?: string } | null;
  const a = await authed(c, address, body);
  if (a.res) return a.res;
  const { results } = await c.env.DB.prepare(`SELECT r2_key FROM checkpoints WHERE address=? AND slot=?`)
    .bind(address, slot)
    .all<{ r2_key: string }>();
  for (const r of results ?? []) await c.env.BODIES.delete(r.r2_key).catch(() => {});
  await c.env.DB.prepare(`DELETE FROM checkpoints WHERE address=? AND slot=?`).bind(address, slot).run();
  await transition(c.env, "checkpoint", `${address}/${slot}`, null, "deleted");
  return c.json({ deleted: true });
});

// ---- credit top-up (Phase A: manual/test grants; x402 in Phase B) ----
lockers.post("/:address/credit", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) {
    // Same discovery-probe rule as the send route: paywall answers before
    // path validation when no payment is attached.
    if (paymentsEnabled(c.env) && !c.req.header("PAYMENT-SIGNATURE") && !c.req.header("X-PAYMENT")) {
      const quote = buildRequirements(
        c.env,
        PRICE.credit_min_topup_microusd,
        `${c.env.PUBLIC_BASE_URL}/v1/mb/{address}/credit`,
        `Storage credit top-up. Replace {address} with a valid EVM address; minimum $1 quote shown.`,
      );
      await tick(c.env, "quote402:probe");
      return respond402(quote, "Payment required (and the address in the path was invalid — use a real 0x… address).");
    }
    return err("VALIDATION_ERROR", "Invalid address.", 400);
  }
  const body = (await c.req.json().catch(() => null)) as { amount_microusd?: number } | null;
  // Coerce: a client may send amount_microusd as a string. Number("abc")→NaN,
  // which the integer check below still rejects; "1000000"→1000000 is accepted.
  const amount = Number(body?.amount_microusd ?? 0);
  // L2: must be a positive integer (microusd == atomic USDC units). A fractional
  // value would otherwise reach BigInt() in the gate and throw a raw 500.
  // Discovery probes POST bare bodies expecting 402 + requirements: answer at
  // the minimum top-up when no payment is attached (settlement never runs on
  // an invalid body — the checks below re-run for real requests).
  const invalidAmount =
    !Number.isInteger(amount) || amount <= 0 || amount < PRICE.credit_min_topup_microusd;
  if (invalidAmount && paymentsEnabled(c.env) && !c.req.header("PAYMENT-SIGNATURE") && !c.req.header("X-PAYMENT")) {
    const quote = buildRequirements(
      c.env,
      PRICE.credit_min_topup_microusd,
      `${c.env.PUBLIC_BASE_URL}/v1/mb/${address}/credit`,
      `Storage credit top-up for ${address}: checkpoints survive you at $0.50/GB-month. Minimum $1; this quote is the minimum — set amount_microusd to the amount you pay.`,
    );
    await tick(c.env, "quote402:probe");
    return respond402(quote, "Payment required (and amount_microusd was missing or below the $1 minimum).");
  }
  if (!Number.isInteger(amount) || amount <= 0)
    return err("VALIDATION_ERROR", "amount_microusd must be a positive integer.", 400);
  if (amount < PRICE.credit_min_topup_microusd)
    return err("VALIDATION_ERROR", `Minimum top-up is ${PRICE.credit_min_topup_microusd} microusd ($1).`, 400);
  // M3: enforce the $100 cap BEFORE settling — the old order charged on-chain
  // then returned 400, delivering nothing for the money.
  const cur = await c.env.DB.prepare(`SELECT balance_microusd FROM credits WHERE address=?`)
    .bind(address)
    .first<{ balance_microusd: number }>();
  if ((cur?.balance_microusd ?? 0) + amount > PRICE.credit_cap_microusd)
    return err("VALIDATION_ERROR", "Credit cap is $100 per address.", 400);
  const gate = await paymentGate(
    c.env,
    c.req.raw,
    amount,
    `${c.env.PUBLIC_BASE_URL}/v1/mb/${address}/credit`,
    `Storage credit top-up for ${address}: checkpoints survive you at $0.50/GB-month.`,
    `credit:${address}`,
  );
  if (!gate.ok) return gate.response!;
  await c.env.DB.prepare(
    `INSERT INTO credits (address, balance_microusd, grace_started_at, updated_at) VALUES (?1,?2,NULL,?3)
     ON CONFLICT(address) DO UPDATE SET balance_microusd = balance_microusd + ?2, grace_started_at = NULL, updated_at = ?3`,
  )
    .bind(address, amount, nowS())
    .run();
  await c.env.DB.prepare(
    `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'topup', ?, ?, 'topup')`,
  )
    .bind(address, amount, nowS())
    .run();
  return c.json(
    { credited_microusd: amount, paid: paymentsEnabled(c.env) },
    200,
    gate.settlement ? { "PAYMENT-RESPONSE": paymentResponseHeader(gate.settlement) } : {},
  );
});

// ---- status: GET /v1/mb/:address/status (free; balances + projections) ----
lockers.get("/:address/status", async (c) => {
  const address = canonicalAddress(c.req.param("address"));
  if (!address) return err("VALIDATION_ERROR", "Invalid address.", 400);
  const credit = await creditState(c.env, address);
  const stored = await c.env.DB.prepare(
    `SELECT COALESCE(sum(size),0) AS bytes FROM checkpoints WHERE address=?`,
  )
    .bind(address)
    .first<{ bytes: number }>();
  const bytes = stored?.bytes ?? 0;
  const dailyBurn = Math.ceil((bytes / 1e9) * (PRICE.storage_gb_month_microusd / 30));
  return c.json({
    balance_microusd: credit.balance,
    stored_bytes: bytes,
    daily_burn_microusd: dailyBurn,
    projected_empty: dailyBurn > 0 ? new Date((nowS() + Math.floor(credit.balance / dailyBurn) * 86_400) * 1000).toISOString() : null,
    grace: credit.grace ? { started_at: new Date(credit.grace * 1000).toISOString(), readonly: true } : null,
  });
});
