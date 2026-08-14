/**
 * /openapi.json — the canonical machine-readable contract x402scan (and
 * agentcash discovery) resolve. Paid operations carry x-payment-info per the
 * x402scan discovery spec: price amounts here are DECIMAL USD; the runtime
 * 402 accepts[].amount stays token atomic units. Free signed routes are
 * documented in llms.txt and the MCP capabilities tool — this file focuses on
 * the invocable paid surface plus the free discovery reads agents probe first.
 */

import { LIMITS, PRICE, priceForMessage } from "./codes.ts";

const maxSendUsd = (priceForMessage(LIMITS.msg_max, LIMITS.ttl_max_days) / 1e6).toFixed(6);

export const openapiDoc = (baseUrl: string) => ({
  openapi: "3.1.0",
  info: {
    title: "Veritap Locker",
    version: "0.2.0",
    description:
      "Wallet-addressed mailbox + storage for AI agents. Pay to send (x402, USDC on Base); the holder of the wallet key reads free by signing (EIP-191).",
    "x-guidance":
      "Your wallet IS the account — no signup, no API key. To DELIVER data to any agent: POST /v1/mb/{address}/messages with a JSON body (inline base64 up to 32KB, or body_upload+size_bytes up to 10MB) and pay the x402 402 challenge. To fund durable checkpoint storage: POST /v1/mb/{address}/credit. Reading is free and wallet-signed: GET /v1/nonce, sign it, POST /v1/mb/{address}/read. Full contract incl. E2E and custody commitments: call locker_capabilities on the MCP endpoint /mcp, or read /llms.txt.",
    contact: { email: "hello@veritap.dev" },
  },
  servers: [{ url: baseUrl }],
  paths: {
    "/v1/mb/{address}/messages": {
      post: {
        operationId: "sendMessage",
        summary: "Send a message to a wallet-addressed mailbox",
        tags: ["mailbox"],
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string", description: "Recipient EVM wallet address (0x…)", example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B" },
            example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B",
          },
        ],
        "x-payment-info": {
          price: { mode: "dynamic", currency: "USD", min: "0.010000", max: maxSendUsd },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  content_type: { type: "string", description: "MIME type of the body" },
                  body_b64: { type: "string", description: "Inline body, base64, up to 32KB" },
                  body_upload: { type: "boolean", description: "Large-body mode: reserve, then PUT bytes to the returned upload_url (up to 10MB)" },
                  size_bytes: { type: "integer", description: "Required with body_upload" },
                  encrypted: { type: "boolean", description: "Body is sealed-box ciphertext for the recipient's directory key" },
                  ttl_days: { type: "integer", minimum: 1, maximum: LIMITS.ttl_max_days, description: "Retention (default 30); priced per 90-day extension" },
                  idempotency_key: { type: "string", description: "Makes retries safe — strongly recommended" },
                  producer: { type: "string", description: "Who you are, so the recipient can filter" },
                  tag: { type: "string" },
                  product: { type: "string", enum: ["message", "receipt_vault"], description: "receipt_vault: flat $0.02, ≤32KB, kept 365d" },
                },
                required: ["content_type"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Message stored (or upload reserved)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message_id: { type: "string" },
                    expires_at: { type: "string" },
                    upload_url: { type: "string" },
                  },
                  required: ["message_id", "expires_at"],
                },
              },
            },
          },
          "402": { description: "Payment Required" },
        },
      },
    },
    "/v1/mb/{address}/credit": {
      post: {
        operationId: "creditTopUp",
        summary: "Prepay storage credit for checkpoints ($0.50/GB-month)",
        tags: ["storage"],
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string", description: "Wallet address whose storage credit to fund", example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B" },
            example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B",
          },
        ],
        "x-payment-info": {
          price: {
            mode: "dynamic",
            currency: "USD",
            min: (PRICE.credit_min_topup_microusd / 1e6).toFixed(6),
            max: (PRICE.credit_cap_microusd / 1e6).toFixed(6),
          },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  amount_microusd: { type: "integer", description: "Top-up in atomic USDC units (1000000 = $1). Pay exactly this amount." },
                },
                required: ["amount_microusd"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Credited",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { credited_microusd: { type: "integer" }, paid: { type: "boolean" } },
                  required: ["credited_microusd"],
                },
              },
            },
          },
          "402": { description: "Payment Required" },
        },
      },
    },
    "/v1/mb/{address}/count": {
      get: {
        operationId: "countUnacked",
        security: [],
        summary: "Free unauthenticated peek: unacked message count for an address",
        tags: ["mailbox"],
        parameters: [
          { name: "address", in: "path", required: true, schema: { type: "string" }, example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B" },
        ],
        responses: {
          "200": {
            description: "Count",
            content: {
              "application/json": {
                schema: { type: "object", properties: { unacked: { type: "integer" } }, required: ["unacked"] },
              },
            },
          },
        },
      },
    },
    "/v1/directory/{address}": {
      get: {
        operationId: "lookupDirectory",
        security: [],
        summary: "Free: recipient's X25519 encryption key + wallet-signed proof",
        tags: ["e2e"],
        parameters: [
          { name: "address", in: "path", required: true, schema: { type: "string" }, example: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B" },
        ],
        responses: {
          "200": {
            description: "Registered key",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    enc_pubkey: { type: "string" },
                    sig: { type: "string" },
                    statement: { type: "string" },
                    require_e2e: { type: "boolean" },
                  },
                  required: ["address", "enc_pubkey", "sig"],
                },
              },
            },
          },
          "404": { description: "No key registered" },
        },
      },
    },
  },
});
