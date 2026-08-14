/**
 * §7 scheduled sweeps — all idempotent and safe to double-run (§12.26):
 * TTL expiry, daily credit burn + grace transitions, nonce GC, R2 orphan GC.
 */

import { err as _err, LIMITS, PRICE } from "./codes.ts";
import { assertStorageMargin } from "./cost.ts";
import type { Env } from "./types.ts";
import { nowS, transition } from "./types.ts";

export async function sweepExpired(env: Env): Promise<number> {
  const t = nowS();
  const { results } = await env.DB.prepare(
    `SELECT message_id, r2_key FROM messages WHERE acked_at IS NULL AND expires_at < ? LIMIT 500`,
  )
    .bind(t)
    .all<{ message_id: string; r2_key: string | null }>();
  for (const m of results ?? []) {
    if (m.r2_key) await env.BODIES.delete(m.r2_key).catch(() => {});
    await env.DB.prepare(`UPDATE messages SET acked_at=?, inline_body=NULL WHERE message_id=? AND acked_at IS NULL`)
      .bind(t, m.message_id)
      .run();
    await transition(env, "message", m.message_id, "stored", "expired");
  }
  return results?.length ?? 0;
}

export async function nonceGc(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM nonces WHERE expires_at < ?`).bind(nowS() - 3600).run();
  await env.DB.prepare(`DELETE FROM rate_counters WHERE window_start < ?`).bind(nowS() - 7200).run();
}

/** Daily: burn credit for stored checkpoint bytes; manage grace → expiry. */
export async function creditBurn(env: Env): Promise<void> {
  await assertStorageMargin(env); // #768.3 — logs + tickets, never blocks
  const t = nowS();
  const { results } = await env.DB.prepare(
    `SELECT address, COALESCE(sum(size),0) AS bytes FROM checkpoints GROUP BY address`,
  ).all<{ address: string; bytes: number }>();
  for (const r of results ?? []) {
    if (!r.bytes) continue;
    const burn = Math.ceil((r.bytes / 1e9) * (PRICE.storage_gb_month_microusd / 30));
    const cur = await env.DB.prepare(`SELECT balance_microusd, grace_started_at FROM credits WHERE address=?`)
      .bind(r.address)
      .first<{ balance_microusd: number; grace_started_at: number | null }>();
    const balance = cur?.balance_microusd ?? 0;

    if (balance >= burn) {
      await env.DB.prepare(
        `UPDATE credits SET balance_microusd = balance_microusd - ?, grace_started_at = NULL, updated_at=? WHERE address=?`,
      )
        .bind(burn, t, r.address)
        .run();
      await env.DB.prepare(
        `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'burn', ?, ?, ?)`,
      )
        .bind(r.address, burn, t, `${r.bytes} bytes`)
        .run();
      continue;
    }

    // Not enough credit: enter/continue grace (read-only) — 30 days, then expiry.
    if (!cur?.grace_started_at) {
      await env.DB.prepare(
        `INSERT INTO credits (address, balance_microusd, grace_started_at, updated_at) VALUES (?1, 0, ?2, ?2)
         ON CONFLICT(address) DO UPDATE SET grace_started_at = COALESCE(grace_started_at, ?2), updated_at = ?2`,
      )
        .bind(r.address, t)
        .run();
      await env.DB.prepare(
        `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'grace', 0, ?, 'credit exhausted; read-only')`,
      )
        .bind(r.address, t)
        .run();
    } else if (t - cur.grace_started_at > LIMITS.grace_days * 86_400) {
      const { results: cps } = await env.DB.prepare(`SELECT r2_key FROM checkpoints WHERE address=?`)
        .bind(r.address)
        .all<{ r2_key: string }>();
      for (const cp of cps ?? []) await env.BODIES.delete(cp.r2_key).catch(() => {});
      await env.DB.prepare(`DELETE FROM checkpoints WHERE address=?`).bind(r.address).run();
      await env.DB.prepare(
        `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'expire', 0, ?, 'grace period ended; checkpoints expired')`,
      )
        .bind(r.address, t)
        .run();
      await transition(env, "credit", r.address, "grace", "expired");
    }
  }
}

/** R2 orphan GC: bodies whose D1 rows are gone (bounded scan). */
export async function orphanGc(env: Env): Promise<void> {
  const list = await env.BODIES.list({ limit: 100 });
  for (const obj of list.objects) {
    const isMsg = obj.key.startsWith("msg/");
    const row = isMsg
      ? await env.DB.prepare(`SELECT 1 AS ok FROM messages WHERE r2_key=? AND acked_at IS NULL`).bind(obj.key).first()
      : await env.DB.prepare(`SELECT 1 AS ok FROM checkpoints WHERE r2_key=?`).bind(obj.key).first();
    // Skip very fresh objects: upload may precede row commit.
    if (!row && Date.now() - obj.uploaded.getTime() > 3600_000) {
      await env.BODIES.delete(obj.key).catch(() => {});
    }
  }
}

export async function runCron(env: Env, cron: string): Promise<void> {
  if (cron === "10 5 * * *") {
    await creditBurn(env);
  }
  await sweepExpired(env);
  await nonceGc(env);
  await orphanGc(env);
}
