/** §14.5 — error enum. Versioned, never renamed, only added. */

export const CODES = [
  "VALIDATION_ERROR",
  "INVALID_SIGNATURE",
  "NONCE_EXPIRED",
  "NONCE_USED",
  "E2E_REQUIRED",
  "MAILBOX_FULL",
  "PAYLOAD_TOO_LARGE",
  "SLOT_LIMIT",
  "INSUFFICIENT_CREDIT", // reserved: exhaustion currently surfaces as GRACE_READONLY
  "GRACE_READONLY",
  "RATE_LIMITED",
  "LOCKER_DISABLED",
  "WRITES_OFF",
  "NOT_FOUND",
] as const;
export type Code = (typeof CODES)[number];

export const err = (code: Code, message: string, status: number, extra?: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      error: code,
      message,
      docs: `https://locker.veritap.dev/docs#${code}`,
      ...extra,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );

/** Pricing (§6). Prices live ONLY here + capabilities/402 bodies — repricing is config. */
export const PRICE = {
  msg_100kb_microusd: 10_000, // $0.01
  msg_1mb_microusd: 20_000, // $0.02
  msg_10mb_microusd: 50_000, // $0.05
  ttl_ext_per_90d_microusd: 10_000,
  storage_gb_month_microusd: 500_000, // $0.50
  credit_min_topup_microusd: 1_000_000,
  credit_cap_microusd: 100_000_000, // $100 liability cap
} as const;

export const LIMITS = {
  inline_max: 32 * 1024,
  msg_max: 10 * 1024 * 1024,
  ttl_default_days: 30,
  ttl_max_days: 365,
  mailbox_max_unacked: 10_000,
  mailbox_max_bytes: 1024 * 1024 * 1024,
  slots_per_address: 32,
  versions_per_slot: 3,
  checkpoint_max: 50 * 1024 * 1024,
  read_page_max: 100,
  grace_days: 30,
  nonce_ttl_seconds: 300,
  signed_url_seconds: 900,
  rate_nonce_hr: 60,
  rate_read_hr: 600,
  rate_count_hr: 60,
  sig_fail_backoff_after: 5,
  sig_fail_cooldown_seconds: 900,
  /** #773-A3: a signed GET link is redeemable a handful of times within its
   * 15-min window, not millions — kills the free-amplification path. */
  blob_get_redemptions: 3,
  /** #773-A4 / M6: coarse per-IP ceiling on free GETs — the per-(address,IP)
   * caps are bypassable by rotating addresses; this one is not. */
  rate_ip_free_hr: 3600,
  /** #773-A1: per-request cost estimate for the spend breaker. ~$3/M covers
   * the worker request + its D1 ops at CF list prices; precision not required
   * — the breaker is a ceiling, not a meter. */
  breaker_est_req_cost_microusd: 3,
} as const;

/** #767.1: receipt-vault — $0.02 flat, ≤32KB, kept 365d. Distinct product
 * code so the ledger separates vault demand from generic sends. */
export const RECEIPT_VAULT = {
  price_microusd: 20_000,
  max_bytes: 32 * 1024,
  ttl_days: 365,
} as const;

export function priceForMessage(size: number, ttlDays: number): number {
  let base: number;
  if (size <= 100 * 1024) base = PRICE.msg_100kb_microusd;
  else if (size <= 1024 * 1024) base = PRICE.msg_1mb_microusd;
  else base = PRICE.msg_10mb_microusd;
  const extraDays = Math.max(0, ttlDays - LIMITS.ttl_default_days);
  return base + Math.ceil(extraDays / 90) * PRICE.ttl_ext_per_90d_microusd;
}
