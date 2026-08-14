/**
 * #768 — pricing must ALWAYS clear cost, enforced as an invariant.
 *
 * Single cost model: Cloudflare unit rates as dated constants. Numbers are
 * deliberately rounded UP where ambiguous — overstating cost tightens the
 * floor, which is the safe direction for a guard.
 *
 * Sources (as of 2026-08-14 — quarterly review chore: re-verify each rate):
 *   R2:      https://developers.cloudflare.com/r2/pricing/
 *   D1:      https://developers.cloudflare.com/d1/platform/pricing/
 *   Workers: https://developers.cloudflare.com/workers/platform/pricing/
 * Facilitator: Coinbase CDP x402, currently fee-free for USDC on Base.
 */

import { PRICE } from "./codes.ts";
import type { Env } from "./types.ts";
import { nowS, transition } from "./types.ts";

export const COST_RATES = {
  as_of: "2026-08-14",
  r2_storage_gb_month_usd: 0.015,
  r2_class_a_per_million_usd: 4.5, // writes
  r2_class_b_per_million_usd: 0.36, // reads
  d1_rows_written_per_million_usd: 1.0,
  d1_rows_read_per_million_usd: 0.25,
  worker_req_per_million_usd: 0.3,
  /** Parameterized so a Coinbase fee change recomputes every floor. */
  facilitator_fee_pct: 0.0,
} as const;

/** Policy floor: quotes must clear MIN_MARGIN × marginal cost. 10× trips on
 * config mistakes and upstream repricing long before actual inversion —
 * current real margins are 100×+. Adjustable by operator decision. */
export const MIN_MARGIN = 10;

const usdToMicro = (usd: number) => usd * 1_000_000;

/**
 * Marginal cost (microusd) to deliver one quotable offer, including the ops
 * overhead of send + read + ack + sweep touching it.
 */
export function costFloorMicrousd(
  sizeBytes: number,
  ttlDays: number,
  product: "message" | "receipt_vault" | "credit" = "message",
): number {
  // Ops: ~4 worker requests (send, read, ack, blob/upload) + generous D1 row
  // budget (~40 writes incl. transitions/counters, ~60 reads) per message.
  const workerReqs = 4 * (COST_RATES.worker_req_per_million_usd / 1e6);
  const d1 =
    40 * (COST_RATES.d1_rows_written_per_million_usd / 1e6) +
    60 * (COST_RATES.d1_rows_read_per_million_usd / 1e6);

  let r2 = 0;
  if (product !== "credit" && sizeBytes > 32 * 1024) {
    const gbMonths = (sizeBytes / 1e9) * (ttlDays / 30);
    r2 =
      gbMonths * COST_RATES.r2_storage_gb_month_usd +
      2 * (COST_RATES.r2_class_a_per_million_usd / 1e6) + // put + delete
      2 * (COST_RATES.r2_class_b_per_million_usd / 1e6); // read + sweep list share
  }
  // Inline bodies ride D1: charge their bytes as D1-adjacent storage at the
  // R2 rate as a conservative stand-in (D1 storage is billed too).
  if (product !== "credit" && sizeBytes <= 32 * 1024) {
    r2 = (sizeBytes / 1e9) * (ttlDays / 30) * COST_RATES.r2_storage_gb_month_usd;
  }

  return usdToMicro(workerReqs + d1 + r2);
}

export interface GuardedQuote {
  priceMicrousd: number;
  clamped: boolean;
}

/**
 * Runtime guard on every 402 quote: never serve an underwater price, never
 * 500 on one. Violations clamp UP to the floor, log a transition, and
 * auto-file an internal ticket. Facilitator fee is netted off the price side.
 */
export async function guardQuote(
  env: Env,
  priceMicrousd: number,
  sizeBytes: number,
  ttlDays: number,
  product: "message" | "receipt_vault" | "credit",
  entityForAudit: string,
): Promise<GuardedQuote> {
  const floor = MIN_MARGIN * costFloorMicrousd(sizeBytes, ttlDays, product);
  const net = priceMicrousd * (1 - COST_RATES.facilitator_fee_pct);
  if (net >= floor) return { priceMicrousd, clamped: false };

  const clampedPrice = Math.ceil(floor / (1 - COST_RATES.facilitator_fee_pct));
  console.error("PRICE_FLOOR_CLAMP", { product, sizeBytes, ttlDays, quoted: priceMicrousd, clampedPrice });
  await transition(env, "pricing", entityForAudit, null, "clamped",
    `quoted ${priceMicrousd}µ$ below ${MIN_MARGIN}x floor; served ${clampedPrice}µ$`);
  try {
    await env.DB.prepare(
      `INSERT INTO tickets (kind, description, created_at) VALUES ('feature', ?, ?)`,
    )
      .bind(
        `INTERNAL pricing floor violation: ${product} ${sizeBytes}B/${ttlDays}d quoted ${priceMicrousd}µ$ < ${MIN_MARGIN}x cost floor — check codes.ts prices vs cost.ts rates`,
        nowS(),
      )
      .run();
  } catch (e) {
    console.error("FLOOR_TICKET_LOST", { error: String(e) });
  }
  return { priceMicrousd: clampedPrice, clamped: true };
}

/**
 * #768.3 — storage burn invariant: our $/GB-month must clear MIN_MARGIN × the
 * R2 storage(+ops) cost for the same GB-month. Called from the daily cron;
 * logs + tickets once per run when violated, never blocks the burn.
 */
export async function assertStorageMargin(env: Env): Promise<boolean> {
  const costPerGbMonth = usdToMicro(
    COST_RATES.r2_storage_gb_month_usd +
      // ops share: a version's put/delete amortized over a month
      2 * (COST_RATES.r2_class_a_per_million_usd / 1e6),
  );
  const ok = PRICE.storage_gb_month_microusd >= MIN_MARGIN * costPerGbMonth;
  if (!ok) {
    console.error("STORAGE_MARGIN_VIOLATION", {
      price: PRICE.storage_gb_month_microusd,
      floor: MIN_MARGIN * costPerGbMonth,
    });
    await transition(env, "pricing", "storage", null, "margin_violation",
      `storage ${PRICE.storage_gb_month_microusd}µ$/GB-mo below ${MIN_MARGIN}x cost`);
    try {
      await env.DB.prepare(
        `INSERT INTO tickets (kind, description, created_at) VALUES ('feature', ?, ?)`,
      )
        .bind("INTERNAL storage margin violation — see cost.ts rates vs codes.ts storage price", nowS())
        .run();
    } catch {}
  }
  return ok;
}
