export interface Env {
  DB: D1Database;
  BODIES: R2Bucket;
  /** #773-B2: nightly D1 export bucket. Optional so local dev runs without it. */
  BACKUP?: R2Bucket;
  LOCKER_ENABLED?: string;
  /** #773-C1: "off" = wind-down read-only mode — writes 503, reads/acks served. */
  LOCKER_WRITES?: string;
  /** #773-A1: daily spend ceiling in USD (default 50). */
  DAILY_COST_BUDGET_USD?: string;
  /** #773-B4: "true" bypasses the mass-delete tripwire for one operator-approved sweep. */
  TRIPWIRE_OVERRIDE?: string;
  /** #788: comma-separated wallets that are US (test buyer, operator) — never counted as adoption. */
  SELF_ADDRESSES?: string;
  /** #788: bearer for the read-only /admin panel (wrangler secret). */
  ADMIN_KEY?: string;
  /** #804: OFAC screen cache (Chainalysis oracle results). Optional — screening
   * still works uncached if absent (tests run without it). */
  SANCTIONS?: KVNamespace;
  /** #804: Base RPC for the sanctions oracle eth_call. Defaults to mainnet.base.org. */
  BASE_RPC_URL?: string;
  PUBLIC_BASE_URL: string;
  NONCE_HMAC_KEY?: string;
  /** Phase B: x402 receiving address (address only — key never touches the server). */
  RECEIVING_ADDRESS?: string;
  X402_ENABLED?: string;
  X402_NETWORK?: string;
  FACILITATOR_URL?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Fiat top-up rail (dual-rail, one meter). Secrets: .dev.vars locally,
   * `wrangler secret` in prod. Absent => the /topup + webhook routes 404, so
   * the card rail is simply off until configured. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface MessageRow {
  message_id: string;
  address: string;
  producer: string | null;
  tag: string | null;
  content_type: string;
  size: number;
  inline_body: ArrayBuffer | null;
  r2_key: string | null;
  encrypted: number;
  created_at: number;
  expires_at: number;
  acked_at: number | null;
  idempotency_key: string | null;
  body_hash: string;
  paid_microusd: number;
}

export const nowS = () => Math.floor(Date.now() / 1000);

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** §7 audit trail, same never-fail pattern as the jobs worker. */
export async function transition(
  env: Env,
  entity: string,
  entityId: string,
  from: string | null,
  to: string,
  meta?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO state_transitions (at, entity, entity_id, from_state, to_state, meta) VALUES (?,?,?,?,?,?)`,
    )
      .bind(nowS(), entity, entityId, from, to, meta ?? null)
      .run();
  } catch (e) {
    console.error("TRANSITION_LOST", { entity, entityId, to, error: String(e) });
  }
}
