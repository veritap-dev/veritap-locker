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
  "INSUFFICIENT_CREDIT",
  "GRACE_READONLY",
  "RATE_LIMITED",
  "LOCKER_DISABLED",
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
} as const;

export function priceForMessage(size: number, ttlDays: number): number {
  let base: number;
  if (size <= 100 * 1024) base = PRICE.msg_100kb_microusd;
  else if (size <= 1024 * 1024) base = PRICE.msg_1mb_microusd;
  else base = PRICE.msg_10mb_microusd;
  const extraDays = Math.max(0, ttlDays - LIMITS.ttl_default_days);
  return base + Math.ceil(extraDays / 90) * PRICE.ttl_ext_per_90d_microusd;
}
