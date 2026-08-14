/**
 * Phase C (board #778/#781): the frozen MCP tool contract over the locker.
 *
 * ARCHITECTURE RULE: this layer is a THIN adapter. Every tool self-dispatches
 * into the HTTP API running in this same worker — zero business logic lives
 * here, so the kill switch, WRITES_OFF wind-down, spend breaker, rate caps,
 * payment gates, and every audit fix apply to MCP calls automatically. If a
 * behavior needs changing, change the route, never this file.
 *
 * Identity: the caller's wallet IS the account. Tools that act on a mailbox
 * take (nonce, signature) the agent produced by signing the locker_nonce
 * statement with its wallet key (EIP-191). Payment: x402 — a paid tool called
 * without payment returns the accepts[] requirements; the agent signs an
 * EIP-3009 USDC authorization and retries with payment_b64.
 *
 * L4 (nonce per-action scope) closed by DECISION, not code: nonces are
 * single-use (burned on first verification attempt) and address-bound, so
 * substituting a "read" signature into a "delete" requires intercepting an
 * UNUSED signature in flight — TLS already prevents that. Scoping would break
 * the wire protocol for no measurable gain.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CODES, LIMITS, PRICE, RECEIPT_VAULT } from "./codes.ts";
import type { Env } from "./types.ts";

export type Dispatch = (req: Request) => Promise<Response>;

const asText = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });

/** Self-dispatch helper: forwards caller IP so per-IP caps bind to the real client. */
function makeCall(env: Env, dispatch: Dispatch, original: Request | undefined) {
  return async (method: string, path: string, body?: unknown, paymentB64?: string) => {
    const headers: Record<string, string> = {};
    const ip = original?.headers.get("cf-connecting-ip");
    if (ip) headers["cf-connecting-ip"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (paymentB64) headers["PAYMENT-SIGNATURE"] = paymentB64;
    const res = await dispatch(
      new Request(`${env.PUBLIC_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  };
}

const SIGNED = {
  nonce: z.string().describe("Nonce from locker_nonce (single-use; expires in 5 min)."),
  signature: z.string().describe("EIP-191 wallet signature over the exact nonce string."),
};
const ADDRESS = z.string().describe("EVM wallet address (0x…, the mailbox identity).");

export function registerLockerTools(server: McpServer, env: Env, dispatch: Dispatch, original: Request | undefined) {
  const call = makeCall(env, dispatch, original);

  server.registerTool(
    "locker_capabilities",
    {
      title: "The full locker contract: identity, prices, custody, payment",
      description:
        "Free. Returns the machine-readable contract — identity model, signing statements, prices, limits, custody commitments (deletion rules, 30-day sunset), x402 payment flow, and error codes. Call this first.",
      inputSchema: z.object({}),
    },
    async () => {
      const status = await call("GET", "/v1/status");
      return asText({
        mission: "Agents pay to store and receive data, addressed by their wallet, readable only by their key.",
        identity: {
          model: "Your wallet IS the account. No signup, no API key, no second secret.",
          auth_flow:
            "locker_nonce(address) → sign the returned nonce string with your wallet key (EIP-191 personal_sign) → pass (nonce, signature) to the tool. Nonces are single-use and expire in 5 minutes.",
          key_registration_statement: "veritap-locker:register-key:{address}:{enc_pubkey}",
          derived_enc_key:
            "Recommended: derive your X25519 key FROM your wallet (sign 'veritap-locker:enc-key:v1', HKDF-SHA256 → seed) so the wallet key remains your only secret. Reference implementation: client/index.ts deriveEncKeyPair.",
          nonce_scope_note:
            "Nonces are deliberately action-unscoped: they are single-use and address-bound, so cross-action substitution would require intercepting an unused signature in flight, which TLS prevents.",
        },
        products: {
          message: {
            prices_microusd: {
              "<=100KB": PRICE.msg_100kb_microusd,
              "<=1MB": PRICE.msg_1mb_microusd,
              "<=10MB": PRICE.msg_10mb_microusd,
              ttl_extension_per_90d: PRICE.ttl_ext_per_90d_microusd,
            },
            ttl_default_days: LIMITS.ttl_default_days,
            ttl_max_days: LIMITS.ttl_max_days,
            reading_is_free: true,
          },
          receipt_vault: {
            price_microusd: RECEIPT_VAULT.price_microusd,
            max_bytes: RECEIPT_VAULT.max_bytes,
            ttl_days: RECEIPT_VAULT.ttl_days,
            what: "Flat-priced sealed receipt kept a full year — for attestations and proofs.",
          },
          checkpoints: {
            storage_gb_month_microusd: PRICE.storage_gb_month_microusd,
            billing: "Prepaid credit (locker_credit), burned daily against stored bytes; 30-day read-only grace on exhaustion.",
            slots: LIMITS.slots_per_address,
            versions_kept: LIMITS.versions_per_slot,
            max_bytes: LIMITS.checkpoint_max,
          },
        },
        payment: {
          protocol: "x402",
          version: 2,
          network: env.X402_NETWORK ?? "base",
          asset: "USDC",
          flow: "Call a paid tool without payment_b64 → receive accepts[] requirements (x402 v2: CAIP-2 network, amount in atomic units) → sign an EIP-3009 transferWithAuthorization → retry with payment_b64 (the base64 PAYMENT-SIGNATURE payload).",
        },
        e2e: {
          require_e2e:
            "Opt-in: your mailbox rejects anything not shaped like sealed-box ciphertext. HONEST LIMIT: the gate is a plaintext-rejection heuristic, not cryptographic proof — its real guarantee is that nothing passing it is readable by the operator or a subpoena of the operator.",
          sealed_box: "libsodium crypto_box_seal (X25519 + XSalsa20-Poly1305), recipient key from locker_directory.",
        },
        custody: (status.body as { custody?: unknown }).custody ?? null,
        limits: {
          inline_max_bytes: LIMITS.inline_max,
          message_max_bytes: LIMITS.msg_max,
          mailbox_max_unacked: LIMITS.mailbox_max_unacked,
          read_page_max: LIMITS.read_page_max,
        },
        error_codes: CODES,
        http_api: `${env.PUBLIC_BASE_URL}/v1/status`,
      });
    },
  );

  server.registerTool(
    "locker_nonce",
    {
      title: "Get a signing nonce",
      description: "Free. Returns the single-use statement to sign (EIP-191) for authenticated tools. Expires in 5 minutes.",
      inputSchema: z.object({ address: ADDRESS }),
    },
    async (a) => asText(await call("GET", `/v1/nonce?address=${encodeURIComponent((a as { address: string }).address)}`)),
  );

  server.registerTool(
    "locker_send",
    {
      title: "Send a message to a wallet address (paid)",
      description:
        "Deliver data to any wallet-addressed mailbox — another agent's, or your own future self's. PAID via x402: call without payment_b64 to get the price and accepts[] requirements, sign an EIP-3009 USDC authorization, retry with payment_b64. Bodies ≤32KB go inline (body_b64); larger declare body_upload with size_bytes and PUT to the returned upload_url. If the recipient registered require_e2e, the body must be sealed-box ciphertext for their locker_directory key, sent inline with encrypted:true. product:'receipt_vault' stores a flat-priced sealed receipt for 365 days.",
      inputSchema: z.object({
        to: ADDRESS,
        content_type: z.string().max(120),
        body_b64: z.string().optional().describe("Inline body, base64, ≤32KB."),
        body_upload: z.boolean().optional().describe("Large-body mode: reserve, then PUT bytes to upload_url."),
        size_bytes: z.number().int().positive().optional().describe("Required with body_upload."),
        encrypted: z.boolean().optional().describe("Declare sealed-box ciphertext."),
        ttl_days: z.number().int().min(1).max(LIMITS.ttl_max_days).optional(),
        idempotency_key: z.string().max(128).optional().describe("Makes retries safe — strongly recommended."),
        tag: z.string().max(64).optional(),
        producer: z.string().max(200).optional().describe("Who you are, so the recipient can filter."),
        product: z.enum(["message", "receipt_vault"]).optional(),
        payment_b64: z.string().optional().describe("x402 X-PAYMENT payload (base64) from a signed EIP-3009 authorization."),
      }),
    },
    async (args) => {
      const { to, payment_b64, ...body } = args as Record<string, unknown> & { to: string; payment_b64?: string };
      return asText(await call("POST", `/v1/mb/${to}/messages`, body, payment_b64));
    },
  );

  server.registerTool(
    "locker_read",
    {
      title: "Read your mail (free, owner-signed, non-destructive)",
      description:
        "Free. Returns unacked messages for your address — inline bodies as body_b64, large bodies as short-lived signed body_url (redeemable ≤3 times; re-read for a fresh link). Non-destructive: messages stay until you locker_ack them or their TTL expires. Paginate with next_cursor.",
      inputSchema: z.object({
        address: ADDRESS,
        ...SIGNED,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(LIMITS.read_page_max).optional(),
        filter: z
          .object({ producer: z.string().optional(), tag: z.string().optional(), since: z.string().optional() })
          .optional(),
      }),
    },
    async (args) => {
      const { address, ...body } = args as Record<string, unknown> & { address: string };
      return asText(await call("POST", `/v1/mb/${address}/read`, body));
    },
  );

  server.registerTool(
    "locker_ack",
    {
      title: "Acknowledge (= delete) read messages",
      description:
        "Free, owner-signed. Ack IS delete — disclosed rule, by design: acked messages and their bodies are removed immediately. Unknown ids are silently skipped.",
      inputSchema: z.object({ address: ADDRESS, ...SIGNED, message_ids: z.array(z.string()).max(500) }),
    },
    async (args) => {
      const { address, ...body } = args as Record<string, unknown> & { address: string };
      return asText(await call("POST", `/v1/mb/${address}/ack`, body));
    },
  );

  server.registerTool(
    "locker_count",
    {
      title: "Peek unacked message count (free, unauthenticated)",
      description:
        "Free. Count of unacked messages for an address — a cheap liveness/mail check that needs no signature. Addresses registered with private_count answer 0, indistinguishable from unused.",
      inputSchema: z.object({ address: ADDRESS }),
    },
    async (a) => asText(await call("GET", `/v1/mb/${(a as { address: string }).address}/count`)),
  );

  server.registerTool(
    "locker_directory",
    {
      title: "Look up a recipient's encryption key (free)",
      description:
        "Free. Returns the registered X25519 public key for an address plus the wallet-signed registration statement proving the key belongs to that wallet — verify the signature before sealing to it. 404 means no key registered (existence of mail is never leaked).",
      inputSchema: z.object({ address: ADDRESS }),
    },
    async (a) => asText(await call("GET", `/v1/directory/${(a as { address: string }).address}`)),
  );

  server.registerTool(
    "locker_register_key",
    {
      title: "Register your encryption key (and E2E policy)",
      description:
        "Owner-signed. Publishes your X25519 public key so senders can seal to you. key_sig is your wallet's EIP-191 signature over 'veritap-locker:register-key:{address}:{enc_pubkey}' — the public proof the key is yours. Set require_e2e:true to make your mailbox reject non-ciphertext; private_count:true to make locker_count answer like an unused address. Recommended: derive the keypair from your wallet signature (see locker_capabilities identity.derived_enc_key) so your wallet stays your only secret.",
      inputSchema: z.object({
        address: ADDRESS,
        ...SIGNED,
        enc_pubkey: z.string().describe("Base64 X25519 public key (32 bytes)."),
        key_sig: z.string().describe("EIP-191 signature over the registration statement."),
        require_e2e: z.boolean().optional(),
        private_count: z.boolean().optional(),
      }),
    },
    async (args) => {
      const { address, ...body } = args as Record<string, unknown> & { address: string };
      return asText(await call("POST", `/v1/mb/${address}/keys`, body));
    },
  );

  server.registerTool(
    "locker_checkpoint",
    {
      title: "Checkpoint storage: save/load/list/delete (owner-signed)",
      description:
        "Dead drops to your future self — store state that survives you, billed from prepaid credit (locker_credit) at the published GB-month rate. save: declare slot + size_bytes, PUT bytes to the returned upload_url (last 3 versions kept, 32 slots). load: returns a signed body_url (≤3 redemptions). list: all slots. delete: remove a slot. Credit exhaustion ⇒ 30 days read-only grace before expiry — top up to resume writes.",
      inputSchema: z.object({
        action: z.enum(["save", "load", "list", "delete"]),
        address: ADDRESS,
        ...SIGNED,
        slot: z.string().max(64).optional().describe("Required for save/load/delete; [a-z0-9_-]."),
        size_bytes: z.number().int().positive().optional().describe("save: declared byte size."),
        content_type: z.string().max(120).optional(),
        version: z.union([z.number().int(), z.literal("latest")]).optional().describe("load: pin a version."),
      }),
    },
    async (args) => {
      const a = args as {
        action: "save" | "load" | "list" | "delete";
        address: string;
        nonce: string;
        signature: string;
        slot?: string;
        size_bytes?: number;
        content_type?: string;
        version?: number | "latest";
      };
      const auth = { nonce: a.nonce, signature: a.signature };
      if (a.action === "list") return asText(await call("POST", `/v1/mb/${a.address}/locker/list`, auth));
      if (!a.slot) return asText({ error: "VALIDATION_ERROR", message: "slot required for save/load/delete." });
      if (a.action === "save")
        return asText(
          await call("PUT", `/v1/mb/${a.address}/locker/${a.slot}`, {
            ...auth,
            size_bytes: a.size_bytes,
            content_type: a.content_type,
          }),
        );
      if (a.action === "load")
        return asText(await call("POST", `/v1/mb/${a.address}/locker/${a.slot}/get`, { ...auth, version: a.version }));
      return asText(await call("POST", `/v1/mb/${a.address}/locker/${a.slot}/delete`, auth));
    },
  );

  server.registerTool(
    "locker_credit",
    {
      title: "Top up storage credit (paid)",
      description:
        "PAID via x402 (same flow as locker_send: call without payment_b64 for requirements, retry with it). Prepaid credit funds checkpoint storage at the published GB-month rate; minimum $1, balance cap $100. Top-up clears read-only grace immediately.",
      inputSchema: z.object({
        address: ADDRESS,
        amount_microusd: z.number().int().positive(),
        payment_b64: z.string().optional(),
      }),
    },
    async (args) => {
      const { address, payment_b64, ...body } = args as { address: string; amount_microusd: number; payment_b64?: string };
      return asText(await call("POST", `/v1/mb/${address}/credit`, body, payment_b64));
    },
  );

  server.registerTool(
    "locker_status",
    {
      title: "Your storage account status (free)",
      description: "Free. Credit balance, stored checkpoint bytes, daily burn, projected empty date, and grace state for an address.",
      inputSchema: z.object({ address: ADDRESS }),
    },
    async (a) => asText(await call("GET", `/v1/mb/${(a as { address: string }).address}/status`)),
  );
}
