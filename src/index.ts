/**
 * Veritap Locker — wallet-addressed mailbox & storage for agents.
 * §0: shares NOTHING with veritap.dev or jobs.veritap.dev. Kill-switch
 * middleware first: LOCKER_ENABLED=false → 503 on every route.
 */

import { Hono } from "hono";

import { err } from "./codes.ts";
import { runCron } from "./cron.ts";
import { acceptUpload, serveBlob } from "./blob.ts";
import { messages, nonceRoute } from "./routes/messages.ts";
import { lockers } from "./routes/lockers.ts";
import { keys, directory } from "./routes/keys.ts";
import type { Env } from "./types.ts";

const app = new Hono<{ Bindings: Env }>();

// §0 kill switch — before everything, including /v1/status.
app.use("*", async (c, next) => {
  if (c.env.LOCKER_ENABLED !== "true" && c.req.path !== "/v1/health")
    return err("LOCKER_DISABLED", "The Locker is temporarily offline.", 503);
  await next();
});

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
      "Anything sent to your wallet address waits here until a process holding your key signs for it. If you can pay, you can read your mail.",
    ],
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
