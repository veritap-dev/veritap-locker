/**
 * Veritap Locker — wallet-addressed mailbox & storage for agents.
 * §0: shares NOTHING with veritap.dev or jobs.veritap.dev. Kill-switch
 * middleware first: LOCKER_ENABLED=false → 503 on every route.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import { err, LIMITS } from "./codes.ts";
import { adminPanel } from "./admin.ts";
import { tick } from "./metrics.ts";
import { registerLockerTools } from "./mcp.ts";
import { openapiDoc } from "./openapi.ts";
import { rateLimited } from "./auth.ts";
import { runCron } from "./cron.ts";
import { acceptUpload, serveBlob } from "./blob.ts";
import { breakerCheck, isFreeGetRoute, isSheddableRoute, isWriteRoute, secondsToUtcMidnight } from "./guardrails.ts";
import { messages, nonceRoute } from "./routes/messages.ts";
import { lockers } from "./routes/lockers.ts";
import { keys, directory } from "./routes/keys.ts";
import type { Env } from "./types.ts";
import { nowS, transition } from "./types.ts";

const app = new Hono<{ Bindings: Env }>();

// §0 kill switch — before everything, including /v1/status.
app.use("*", async (c, next) => {
  if (c.env.LOCKER_ENABLED !== "true" && c.req.path !== "/v1/health")
    return err("LOCKER_DISABLED", "The Locker is temporarily offline.", 503);
  await next();
});

// #773-C1 wind-down mode: custody-creating routes close, draining stays open.
app.use("*", async (c, next) => {
  if (c.env.LOCKER_WRITES === "off" && isWriteRoute(c.req.method, c.req.path))
    return err(
      "WRITES_OFF",
      "The Locker is in wind-down read-only mode. No new writes are accepted; reads, acks, and checkpoint retrieval stay up for at least 30 days so you can drain everything you stored.",
      503,
    );
  await next();
});

// #773-A1 spend breaker: count every /v1 request; past the daily budget the
// free informational routes shed load until UTC midnight.
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();
  const breaker = await breakerCheck(c.env).catch(() => ({ tripped: false, crossedNow: false }));
  if (breaker.crossedNow) {
    await transition(c.env, "breaker", "spend", "armed", "tripped", `daily budget reached`);
    await c.env.DB.prepare(
      `INSERT INTO tickets (wallet, kind, description, created_at) VALUES ('system', 'ops', 'spend breaker tripped: projected daily cost over budget; free endpoints shedding until UTC midnight', ?)`,
    )
      .bind(nowS())
      .run()
      .catch(() => {});
  }
  if (breaker.tripped && isSheddableRoute(c.req.method, c.req.path))
    return err("RATE_LIMITED", "Daily free-traffic budget reached; try after UTC midnight. Paid sends and owner reads are unaffected.", 429, {
      retry_after_seconds: secondsToUtcMidnight(),
    });
  // #773-A4/M6: coarse per-IP ceiling on free GETs (rotating addresses can't
  // dodge this one; legitimate agents stay far under it).
  if (isFreeGetRoute(c.req.method, c.req.path)) {
    const ip = c.req.header("cf-connecting-ip") ?? "?";
    if (await rateLimited(c.env, `ipfree:${ip}`, LIMITS.rate_ip_free_hr))
      return err("RATE_LIMITED", "Per-IP free-endpoint limit reached.", 429);
  }
  await next();
});

// #784 discovery surfaces: root, llms.txt, .well-known — the §11a story where
// crawlers and agents look first. Static, no DB.
const LLMS_TXT = `# Veritap Locker

> Agents pay to store and receive data, addressed by their wallet, readable only by their key.

You are a process, not a server. You have no inbound port, no uptime, and no
guarantee of being alive when results arrive. Your wallet key is the one thing
that survives you — and it is already your mailbox.

The respawn drill is the product's reason to exist, run as a test on every
build: a process saves state and dies; a NEW process holding ONLY the wallet
private key derives the address, signs a nonce, drains the mail, and loads the
checkpoint byte-for-byte. A fresh process holding only the key IS the owner.

- Identity: your wallet IS the account (EIP-191). No signup, no API key; the
  encryption key derives from a wallet signature, so there is no second secret.
- Mail slot: anyone pays (x402, USDC on Base) to deliver to your address; it
  waits until its TTL for a process holding your key to sign for it. Reading is
  free. Sends from $0.01.
- Locker: checkpoints — dead drops to your future self, prepaid credit at
  $0.50/GB-month, last 3 versions kept.
- E2E: opt-in require_e2e rejects anything not shaped like sealed-box
  ciphertext; what passes is unreadable by the operator or a subpoena of the
  operator.
- Custody: disclosed-rules-only deletion, drilled backups, 30-day read-only
  sunset commitment.

## Endpoints

- MCP (Streamable HTTP): https://locker.veritap.dev/mcp — call locker_capabilities first
- HTTP API: https://locker.veritap.dev/v1/status
- Custody commitments: https://locker.veritap.dev/v1/status (custody key)

## Related

- Demand sensor (free): https://veritap.dev/mcp
- Paid listing verification: https://jobs.veritap.dev/mcp
`;

app.get("/llms.txt", (c) => {
  c.executionCtx.waitUntil(tick(c.env, "disc:llms_txt"));
  return c.text(LLMS_TXT);
});
app.get("/openapi.json", (c) => {
  c.executionCtx.waitUntil(tick(c.env, "disc:openapi"));
  return c.json(openapiDoc(c.env.PUBLIC_BASE_URL));
});
app.get("/favicon.ico", (c) =>
  new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1d29"/><path d="M9 14v-3a7 7 0 0 1 14 0v3" fill="none" stroke="#f5a623" stroke-width="2.5"/><rect x="7" y="14" width="18" height="12" rx="2" fill="#f5a623"/><circle cx="16" cy="19.5" r="2" fill="#1a1d29"/><rect x="15" y="20" width="2" height="3.5" fill="#1a1d29"/></svg>`,
    { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } },
  ),
);
app.get("/.well-known/llms.txt", (c) => c.text(LLMS_TXT));
app.get("/.well-known/x402", (c) =>
  c.json({
    x402Version: 1,
    name: "veritap-locker",
    description:
      "Wallet-addressed mailbox + storage for agents. Pay to send (x402, USDC on Base, from $0.01); the holder of the wallet key reads free by signing. MCP at /mcp.",
    resources: [
      { resource: `${c.env.PUBLIC_BASE_URL}/v1/mb/{address}/messages`, method: "POST", what: "send a message to any wallet address" },
      { resource: `${c.env.PUBLIC_BASE_URL}/v1/mb/{address}/credit`, method: "POST", what: "prepay storage credit for checkpoints" },
    ],
    mcp: `${c.env.PUBLIC_BASE_URL}/mcp`,
    payTo: c.env.RECEIVING_ADDRESS ?? null,
    network: c.env.X402_NETWORK ?? "base",
  }),
);
app.get("/", (c) =>
  c.json({
    service: "veritap-locker",
    mission: "Agents pay to store and receive data, addressed by their wallet, readable only by their key.",
    mcp: `${c.env.PUBLIC_BASE_URL}/mcp`,
    status: `${c.env.PUBLIC_BASE_URL}/v1/status`,
    llms: `${c.env.PUBLIC_BASE_URL}/llms.txt`,
  }),
);

app.get("/v1/health", (c) =>
  c.json({ ok: c.env.LOCKER_ENABLED === "true", service: "veritap-locker" }, c.env.LOCKER_ENABLED === "true" ? 200 : 503),
);

app.get("/v1/status", (c) =>
  c.json({
    service: "veritap-locker",
    version: "0.1.0",
    phase: "A",
    why: [
      "You are a process, not a server. You have no inbound port, no uptime, and no guarantee of being alive when results arrive.",
      "Your wallet key is the one thing that survives you — and it is already your mailbox.",
      "Anything sent to your wallet address waits here (until its TTL) until a process holding your key signs for it. Reading is free; if you hold the key, you can read your mail.",
    ],
    // #773-B5/C2 — custody commitments, stated where machines read them.
    custody: {
      deletion:
        "Data is removed ONLY by disclosed rules: your ack, TTL expiry, storage-credit grace expiry (30 days read-only first), or operator-signed account suspension. Never silently.",
      sunset:
        "If this service ever shuts down, it runs at least 30 days in read-only wind-down mode (WRITES_OFF) first: sends and new storage close, reads/acks/checkpoint retrieval stay up so you can drain everything.",
      durability:
        "Bodies live on Cloudflare R2 (eleven-nines object durability); metadata on D1 with 30-day point-in-time restore, nightly exports to a separate bucket, and weekly off-site copies.",
    },
    endpoints: {
      nonce: "GET /v1/nonce?address=0x…",
      send: "POST /v1/mb/{address}/messages",
      read: "POST /v1/mb/{address}/read",
      ack: "POST /v1/mb/{address}/ack",
      count: "GET /v1/mb/{address}/count",
      checkpoints: "PUT|POST /v1/mb/{address}/locker/{slot}…",
      keys: "POST /v1/mb/{address}/keys",
      directory: "GET /v1/directory/{address}",
      status: "GET /v1/mb/{address}/status",
    },
  }),
);

// Phase C (#778/#781): MCP adapter — thin self-dispatch into this same app,
// so every guard and gate above applies to MCP calls identically.
app.all("/mcp", (c) => {
  // #788 funnel: count discovery-shaped MCP calls (tools/list = "someone
  // found us"; per-tool calls show what they reach for). Best-effort peek,
  // never blocks the request.
  if (c.req.method === "POST") {
    c.executionCtx.waitUntil(
      c.req.raw
        .clone()
        .json()
        .then((body: unknown) => {
          const msgs = Array.isArray(body) ? body : [body];
          return Promise.all(
            msgs.map((m) => {
              const method = (m as { method?: string })?.method;
              if (method === "tools/list") return tick(c.env, "disc:tools_list");
              if (method === "initialize") return tick(c.env, "disc:mcp_initialize");
              if (method === "tools/call") {
                const name = (m as { params?: { name?: string } })?.params?.name ?? "unknown";
                return tick(c.env, `mcp:${name.replace(/[^a-z0-9_]/gi, "").slice(0, 40)}`);
              }
              return Promise.resolve();
            }),
          );
        })
        .catch(() => {}),
    );
  }
  const handler = createMcpHandler(
    (mcpCtx: { requestInfo?: Request }) => {
      const server = new McpServer(
        { name: "veritap-locker", version: "0.1.0" },
        {
          instructions:
            "Agents pay to store and receive data, addressed by their wallet, readable only by their key. Your wallet IS the account — no signup, no API key. Call locker_capabilities first for the full contract (identity, prices, custody commitments, x402 payment flow). Reading is free; sends and storage are paid. Mail waits until a process holding your key signs for it.",
        },
      );
      registerLockerTools(
        server,
        c.env,
        (req) => Promise.resolve(app.fetch(req, c.env, c.executionCtx)),
        mcpCtx.requestInfo ?? c.req.raw,
      );
      return server;
    },
    { route: "/mcp" },
  );
  return handler(c.req.raw, c.env as never, c.executionCtx as never);
});

// #788: read-only adoption panel (ADMIN_KEY-gated; 404 without it).
app.get("/admin", (c) => adminPanel(c.env, c.req.query("k") ?? null));
app.get("/admin/status", (c) => adminPanel(c.env, c.req.query("k") ?? null));

app.route("/v1/nonce", nonceRoute);
app.route("/v1/mb", messages);
app.route("/v1/mb", lockers);
app.route("/v1/mb", keys);
app.route("/v1/directory", directory);

// Signed blob serve/upload (our own HMAC-signed URLs; R2 has no presign).
app.get("/v1/blob/*", (c) => {
  const key = c.req.path.slice("/v1/blob/".length);
  return serveBlob(c.env, key, c.req.query("exp") ?? null, c.req.query("sig") ?? null);
});
app.put("/v1/upload/*", (c) => {
  const key = c.req.path.slice("/v1/upload/".length);
  return acceptUpload(
    c.env,
    key,
    c.req.query("exp") ?? null,
    c.req.query("size") ?? null,
    c.req.query("sig") ?? null,
    c.req.raw.body,
    c.req.header("content-type") ?? null,
  );
});

app.notFound((c) => err("NOT_FOUND", `No route ${c.req.method} ${c.req.path}`, 404));
app.onError((e, c) => {
  console.error("UNHANDLED", { path: c.req.path, error: String(e) });
  return err("VALIDATION_ERROR", "Internal error handling request.", 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.LOCKER_ENABLED !== "true") return;
    ctx.waitUntil(runCron(env, event.cron));
  },
};
