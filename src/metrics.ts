/**
 * #788 adoption instrumentation. Never-fail, never-block: a metrics write
 * failing must not affect the request. Durable daily counters in `metrics`
 * (rate_counters is GC'd) + per-wallet first/last-seen in `addresses_seen`.
 *
 * SELF-TRAFFIC RULE (non-negotiable per #788): our own wallets are tagged at
 * query time from SELF_ADDRESSES (env, comma-separated; receiving + buyer test
 * wallet at minimum) so the adoption view is structurally incapable of
 * counting us as a customer.
 */

import type { Env } from "./types.ts";
import { nowS } from "./types.ts";

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Bump a durable daily counter. Fire-and-forget safe. */
export async function tick(env: Env, k: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO metrics (k, day, n) VALUES (?1, ?2, 1)
       ON CONFLICT(k, day) DO UPDATE SET n = n + 1`,
    )
      .bind(k, utcDay())
      .run();
  } catch (e) {
    console.warn("METRIC_LOST", { k, error: String(e) });
  }
}

/** Record a wallet interaction (first/last seen per kind). */
export async function sawAddress(env: Env, address: string, kind: string): Promise<void> {
  try {
    const t = nowS();
    await env.DB.prepare(
      `INSERT INTO addresses_seen (address, kind, first_seen, last_seen, n) VALUES (?1, ?2, ?3, ?3, 1)
       ON CONFLICT(address, kind) DO UPDATE SET last_seen = ?3, n = n + 1`,
    )
      .bind(address, kind, t)
      .run();
  } catch (e) {
    console.warn("ADDRESS_SEEN_LOST", { kind, error: String(e) });
  }
}

/** Known self wallets, lowercased. Receiving address is always included. */
export function selfAddresses(env: Env): string[] {
  const configured = (env.SELF_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const receiving = env.RECEIVING_ADDRESS?.toLowerCase();
  return [...new Set([...(receiving ? [receiving] : []), ...configured])];
}
