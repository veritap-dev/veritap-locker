export interface Env {
  DB: D1Database;
  BODIES: R2Bucket;
  LOCKER_ENABLED?: string;
  PUBLIC_BASE_URL: string;
  NONCE_HMAC_KEY?: string;
  /** Phase B: x402 receiving address (address only — key never touches the server). */
  RECEIVING_ADDRESS?: string;
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
