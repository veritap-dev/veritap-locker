/**
 * §7 scheduled sweeps — idempotent and safe to double-run (§12.26): TTL expiry,
 * daily credit burn (guarded once-per-UTC-day, M2), grace transitions, nonce
 * GC, R2 orphan GC (cursor-rotated, M5).
 */

import { err as _err, LIMITS } from "./codes.ts";
import { assertStorageMargin, dailyStorageBurnMicrousd } from "./cost.ts";
import type { Env } from "./types.ts";
import { nowS, transition } from "./types.ts";

/**
 * #773-B4 mass-delete tripwire: a sweep that would remove a suspiciously large
 * slice of live data ABORTS and tickets instead. A bug in TTL math must fail
 * loud, not empty the lockers. Absolute floor of 50 so small-corpus churn
 * (10 rows, all legitimately expiring) never trips it.
 */
export const tripwireExceeded = (candidates: number, live: number): boolean =>
  candidates > 50 && candidates > live * 0.05;

async function tripwireAbort(env: Env, sweep: string, candidates: number, live: number): Promise<boolean> {
  if (!tripwireExceeded(candidates, live) || env.TRIPWIRE_OVERRIDE === "true") return false;
  console.error("TRIPWIRE", { sweep, candidates, live });
  await transition(env, "tripwire", sweep, "armed", "tripped", `${candidates} of ${live} live rows`);
  await env.DB.prepare(
    `INSERT INTO tickets (wallet, kind, description, created_at) VALUES ('system', 'ops', ?, ?)`,
  )
    .bind(
      `mass-delete tripwire: ${sweep} wanted to remove ${candidates} of ${live} live rows — aborted; verify TTL math, then set TRIPWIRE_OVERRIDE=true for one approved run`,
      nowS(),
    )
    .run()
    .catch(() => {});
  return true;
}

export async function sweepExpired(env: Env): Promise<number> {
  const t = nowS();
  const counts = await env.DB.prepare(
    `SELECT count(*) AS live, sum(CASE WHEN expires_at < ?1 THEN 1 ELSE 0 END) AS cand FROM messages WHERE acked_at IS NULL`,
  )
    .bind(t)
    .first<{ live: number; cand: number | null }>();
  if (await tripwireAbort(env, "sweepExpired", counts?.cand ?? 0, counts?.live ?? 0)) return 0;
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
  // Persistent buckets are exempt: the orphangc cursor (window_start=0) was
  // being wiped HERE every run — resetting the M5 scan to the first 100 keys —
  // and spendday counters live a whole UTC day.
  await env.DB.prepare(
    `DELETE FROM rate_counters WHERE window_start < ? AND bucket NOT LIKE 'orphangc:%' AND bucket NOT LIKE 'spendday:%'`,
  )
    .bind(nowS() - 7200)
    .run();
  await env.DB.prepare(`DELETE FROM rate_counters WHERE bucket LIKE 'spendday:%' AND window_start < ?`)
    .bind(nowS() - 3 * 86_400)
    .run();
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
    const burn = dailyStorageBurnMicrousd(r.bytes);
    // Within the free tier (burn 0): never rent, never read-only. Also clear
    // any stale grace if this wallet shrank back under the free allowance,
    // so a formerly-over-quota locker becomes writable again on its own.
    if (burn === 0) {
      await env.DB.prepare(
        `UPDATE credits SET grace_started_at = NULL, updated_at = ? WHERE address = ? AND grace_started_at IS NOT NULL`,
      )
        .bind(t, r.address)
        .run();
      continue;
    }
    const cur = await env.DB.prepare(`SELECT balance_microusd, grace_started_at FROM credits WHERE address=?`)
      .bind(r.address)
      .first<{ balance_microusd: number; grace_started_at: number | null }>();
    const balance = cur?.balance_microusd ?? 0;

    if (balance >= burn) {
      // M2: cron is at-least-once. Guard the decrement with a once-per-UTC-day
      // marker so a retried/overlapping run is a no-op, not a double debit.
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      const already = await env.DB.prepare(
        `SELECT 1 AS x FROM credit_events WHERE address=? AND kind='burn' AND note LIKE ?||'%' LIMIT 1`,
      )
        .bind(r.address, `day:${day}`)
        .first();
      if (already) continue;
      await env.DB.prepare(
        `UPDATE credits SET balance_microusd = balance_microusd - ?, grace_started_at = NULL, updated_at=? WHERE address=?`,
      )
        .bind(burn, t, r.address)
        .run();
      await env.DB.prepare(
        `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'burn', ?, ?, ?)`,
      )
        .bind(r.address, burn, t, `day:${day} ${r.bytes} bytes`)
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
      // #773-B4: even a by-the-rules grace expiry aborts if it would delete a
      // large slice of ALL checkpoints at once — that pattern smells like a
      // grace-clock bug, and a ticket costs a day while a bad delete is forever.
      const total = await env.DB.prepare(`SELECT count(*) AS n FROM checkpoints`).first<{ n: number }>();
      if (await tripwireAbort(env, `graceExpiry:${r.address}`, cps?.length ?? 0, total?.n ?? 0)) continue;
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

/** R2 orphan GC: bodies whose D1 rows are gone. M5: rotate a persisted cursor
 * across runs so the scan window advances past the first 100 keys at scale. */
export async function orphanGc(env: Env): Promise<void> {
  const cur = await env.DB.prepare(`SELECT bucket FROM rate_counters WHERE bucket LIKE 'orphangc:%' LIMIT 1`)
    .first<{ bucket: string }>();
  const cursor = cur?.bucket?.slice("orphangc:".length) || undefined;
  const list = await env.BODIES.list({ limit: 100, cursor });
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
  // Advance (or reset) the cursor for the next run.
  await env.DB.prepare(`DELETE FROM rate_counters WHERE bucket LIKE 'orphangc:%'`).run();
  const next = list.truncated ? (list as { cursor?: string }).cursor : undefined;
  if (next)
    await env.DB.prepare(`INSERT INTO rate_counters (bucket, window_start, n) VALUES (?, 0, 0)`)
      .bind(`orphangc:${next}`)
      .run();
}

/** #773-B2: nightly D1 export to the separate backup bucket, 30-day rotation.
 * BLOB columns exported as hex so the dump is plain JSON. Optional binding —
 * local dev and tests run without it. */
export async function backupExport(env: Env): Promise<void> {
  if (!env.BACKUP) return;
  const day = new Date(nowS() * 1000).toISOString().slice(0, 10);
  const dump: Record<string, unknown[]> = {};
  const tables: Array<[string, string]> = [
    ["keys", `SELECT * FROM keys`],
    ["messages", `SELECT message_id, address, producer, tag, content_type, size, hex(inline_body) AS inline_body_hex, r2_key, encrypted, created_at, expires_at, acked_at, idempotency_key, body_hash, paid_microusd, product FROM messages`],
    ["checkpoints", `SELECT * FROM checkpoints`],
    ["credits", `SELECT * FROM credits`],
    ["credit_events", `SELECT * FROM credit_events`],
    ["tickets", `SELECT * FROM tickets`],
    ["state_transitions", `SELECT * FROM state_transitions`],
  ];
  for (const [name, sql] of tables) {
    const { results } = await env.DB.prepare(sql).all();
    dump[name] = results ?? [];
  }
  await env.BACKUP.put(`d1/${day}.json`, JSON.stringify({ exported_at: nowS(), tables: dump }), {
    httpMetadata: { contentType: "application/json" },
  });
  // Rotate: drop dumps older than 30 days (date is in the key).
  const cutoff = new Date((nowS() - 30 * 86_400) * 1000).toISOString().slice(0, 10);
  const list = await env.BACKUP.list({ prefix: "d1/" });
  for (const obj of list.objects) {
    const d = obj.key.slice(3, 13);
    if (d < cutoff) await env.BACKUP.delete(obj.key).catch(() => {});
  }
  await transition(env, "backup", "d1", null, "exported", `d1/${day}.json`);
}

/** L3: superseded keys stay 30 days for audit, then prune. */
export async function pruneSupersededKeys(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM keys WHERE superseded_at IS NOT NULL AND superseded_at < ?`)
    .bind(nowS() - 30 * 86_400)
    .run();
}

export async function runCron(env: Env, cron: string): Promise<void> {
  if (cron === "10 5 * * *") {
    await creditBurn(env);
    await backupExport(env).catch((e) => console.error("BACKUP_FAILED", { error: String(e) }));
    await pruneSupersededKeys(env);
  }
  await sweepExpired(env);
  await nonceGc(env);
  await orphanGc(env);
}
