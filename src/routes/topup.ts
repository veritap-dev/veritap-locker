/**
 * Fiat top-up rail routes (dual-rail, one meter):
 *   GET  /topup            — human funding page (address + amount → Stripe Checkout)
 *   GET  /topup/done       — post-payment confirmation
 *   POST /v1/stripe/webhook — checkout.session.completed → credit the address
 *
 * The card-funded credit lands in the SAME `credits` ledger as x402 (kind='topup').
 * Idempotency + reconciliation via the stripe_topups table (session_id PK).
 * If STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are unset, these routes 404 — the
 * rail is simply off until configured. The x402 path is untouched either way.
 */

import { Hono } from "hono";

import { canonicalAddress } from "../auth.ts";
import { err, PRICE } from "../codes.ts";
import { isSanctioned } from "../sanctions.ts";
import { tick } from "../metrics.ts";
import { nowS } from "../types.ts";
import type { Env } from "../types.ts";
import {
  createTopupSession,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  parseStripeWebhook,
} from "../stripe.ts";

export const topup = new Hono<{ Bindings: Env }>();

const page = (title: string, body: string) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" type="image/png" href="/favicon.ico">
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#111318;color:#e6e9f0;max-width:560px;margin:3rem auto;padding:0 1.2rem}
 h1{font-size:1.5rem} .amber{color:#f5a623} label{display:block;margin:1.2rem 0 .3rem;color:#8a93a5}
 input,select{width:100%;box-sizing:border-box;background:#171a21;border:1px solid #262b36;border-radius:8px;color:#e6e9f0;padding:.7rem;font:inherit}
 button{margin-top:1.6rem;background:#f5a623;color:#111318;border:0;border-radius:8px;padding:.75rem 1.2rem;font-weight:700;font-size:1rem;cursor:pointer;width:100%}
 .dim{color:#8a93a5;font-size:.9rem} .mono{font-family:ui-monospace,Menlo,monospace} a{color:#6ab0f3}
</style>${body}`;

// ---- GET /topup — funding page / redirect to Checkout ----
topup.get("/topup", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.notFound();
  const rawAddr = c.req.query("address") ?? "";
  const usd = c.req.query("usd");

  // With an address + amount, create a session and redirect to Stripe.
  if (rawAddr && usd) {
    const address = canonicalAddress(rawAddr);
    if (!address) return c.html(page("Top up", `<h1>Invalid address</h1><p class="dim">Expected a 0x… wallet address.</p>`), 400);
    const cents = Math.round(Number(usd) * 100);
    if (!Number.isFinite(cents) || cents < MIN_TOPUP_CENTS || cents > MAX_TOPUP_CENTS)
      return c.html(page("Top up", `<h1>Invalid amount</h1><p class="dim">Choose between $${MIN_TOPUP_CENTS / 100} and $${MAX_TOPUP_CENTS / 100}.</p>`), 400);
    if (await isSanctioned(c.env, address, "topup"))
      return c.html(page("Top up", `<h1>Unavailable</h1><p class="dim">This address cannot be funded.</p>`), 403);

    // Respect the per-address liability cap at session-creation time. (A race
    // between creation and completion is possible but bounded — same-owner
    // top-ups are serial in practice; the cap is a soft prepaid-liability limit.)
    const cur = await c.env.DB.prepare(`SELECT balance_microusd FROM credits WHERE address=?`)
      .bind(address)
      .first<{ balance_microusd: number }>();
    const headroomMicro = PRICE.credit_cap_microusd - (cur?.balance_microusd ?? 0);
    if (headroomMicro < cents * 10_000)
      return c.html(page("Top up", `<h1>Near the cap</h1><p class="dim">This address is close to the $${PRICE.credit_cap_microusd / 1_000_000} prepaid-credit cap. Try a smaller amount.</p>`), 400);

    const session = await createTopupSession({
      secretKey: c.env.STRIPE_SECRET_KEY,
      address,
      amountCents: cents,
      baseUrl: c.env.PUBLIC_BASE_URL,
    });
    if ("error" in session) {
      await tick(c.env, `topup:err:${session.error}`);
      return c.html(page("Top up", `<h1>Couldn't start checkout</h1><p class="dim">${session.error}. Please try again.</p>`), 502);
    }
    await tick(c.env, "topup:session");
    return c.redirect(session.url, 303);
  }

  // No params: render a minimal funding form.
  const prefill = rawAddr ? ` value="${rawAddr.replace(/"/g, "")}"` : "";
  const canceled = c.req.query("canceled") ? `<p class="dim">Checkout canceled — nothing was charged.</p>` : "";
  return c.html(
    page(
      "Top up your Locker",
      `<h1>Top up your <span class="amber">Locker</span></h1>
<p class="dim">Add prepaid storage credit to a wallet address by card — no account. Credit is non-transferable and spendable only on Locker storage and delivery.</p>
${canceled}
<form method="get" action="/topup">
  <label for="address">Wallet address</label>
  <input class="mono" id="address" name="address" placeholder="0x…"${prefill} required>
  <label for="usd">Amount (USD)</label>
  <select id="usd" name="usd">
    <option value="5">$5</option><option value="10">$10</option>
    <option value="25">$25</option><option value="50">$50</option><option value="100">$100</option>
  </select>
  <button type="submit">Continue to secure checkout →</button>
</form>
<p class="dim" style="margin-top:1.4rem">Prefer machine-native payment? Agents can fund autonomously with x402 (USDC on Base) — see <a href="/docs">the docs</a>.</p>`,
    ),
  );
});

// ---- GET /topup/done — confirmation ----
topup.get("/topup/done", (c) =>
  c.html(
    page(
      "Credit added",
      `<h1>Credit on the way <span class="amber">✓</span></h1>
<p>Your payment succeeded. The credit posts to your address as soon as Stripe confirms it (usually seconds).</p>
<p class="dim">Check your balance any time: <span class="mono">GET /v1/mb/{address}/status</span>. You can close this tab.</p>`,
    ),
  ),
);

// ---- POST /v1/stripe/webhook — the crediting event ----
// Mounted at "/" so this full path resolves. Reads the RAW body before parsing
// (signature is computed over the exact bytes).
topup.post("/v1/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return c.notFound();
  const raw = await c.req.text();
  const result = await parseStripeWebhook(raw, c.req.header("stripe-signature") ?? null, c.env.STRIPE_WEBHOOK_SECRET);

  if (result.kind === "bad") return c.text("bad signature", 400); // Stripe retries
  if (result.kind === "ignore") return c.text("ok", 200);

  const { address, amountMicrousd, sessionId, eventId } = result;

  // Sanctions screen (same as the x402 path). Fail-closed: don't credit.
  if (await isSanctioned(c.env, address, "topup-webhook")) {
    console.warn("STRIPE_TOPUP_SANCTIONED", { address, sessionId });
    await tick(c.env, "topup:sanctioned");
    return c.text("ok", 200); // ack; a refund is handled out of band
  }

  // Idempotency: first writer wins. A replayed webhook => changes==0 => no credit.
  const claim = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_topups (session_id, event_id, address, amount_microusd, at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(sessionId, eventId, address, amountMicrousd, nowS())
    .run();
  if (!claim.meta.changes) {
    await tick(c.env, "topup:duplicate");
    return c.text("ok", 200); // already processed
  }

  // Apply to the SAME ledger the x402 path uses (kind='topup'); clears grace.
  await c.env.DB.prepare(
    `INSERT INTO credits (address, balance_microusd, grace_started_at, updated_at) VALUES (?1,?2,NULL,?3)
     ON CONFLICT(address) DO UPDATE SET balance_microusd = balance_microusd + ?2, grace_started_at = NULL, updated_at = ?3`,
  )
    .bind(address, amountMicrousd, nowS())
    .run();
  await c.env.DB.prepare(
    `INSERT INTO credit_events (address, kind, amount_microusd, at, note) VALUES (?, 'topup', ?, ?, 'stripe')`,
  )
    .bind(address, amountMicrousd, nowS())
    .run();

  await tick(c.env, "topup:card");
  console.log("STRIPE_TOPUP_CREDITED", { address, amountMicrousd, sessionId });
  return c.text("ok", 200);
});
