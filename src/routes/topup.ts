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

/** Branded shell for the human-facing funding pages. A person lands here
 * because THEIR AGENT sent them, often meeting Veritap for the first time with
 * a card in hand — the page's job is confidence: who we are, what they're
 * buying, what protects them. Matches the Locker design system (landing.ts). */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Veritap Locker</title><link rel="icon" type="image/png" href="/favicon.ico">
<style>
 :root{--bg:#111318;--panel:#171a21;--line:#262b36;--fg:#e6e9f0;--dim:#8a93a5;--amber:#f5a623;--green:#7bd88f;--blue:#6ab0f3}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
 .wrap{max-width:560px;margin:0 auto;padding:2.2rem 1.2rem 3rem}
 .brand{display:flex;align-items:center;gap:.8rem;margin-bottom:1.8rem}
 .brand img{width:44px;height:44px;border-radius:10px}
 .brand .name{font-weight:700;font-size:1.15rem;letter-spacing:-.01em}
 .brand .tag{color:var(--dim);font-size:.85rem;margin-top:-2px}
 h1{font-size:1.45rem;margin:.2rem 0 .6rem;letter-spacing:-.01em} .amber{color:var(--amber)}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1.3rem 1.4rem;margin:1.1rem 0}
 label{display:block;margin:1.1rem 0 .3rem;color:var(--dim);font-size:.92rem}
 input,select{width:100%;background:#0e1015;border:1px solid var(--line);border-radius:8px;color:var(--fg);padding:.7rem .8rem;font:inherit}
 input:focus,select:focus{outline:none;border-color:var(--amber)}
 button{margin-top:1.5rem;background:var(--amber);color:#111318;border:0;border-radius:8px;padding:.8rem 1.2rem;font-weight:700;font-size:1rem;cursor:pointer;width:100%}
 button:hover{filter:brightness(1.08)}
 .dim{color:var(--dim);font-size:.92rem} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace} a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
 .trust{display:grid;gap:.45rem;margin-top:1.2rem;font-size:.9rem;color:var(--dim)}
 .trust b{color:var(--fg);font-weight:600}
 .trust .row{display:flex;gap:.55rem;align-items:baseline}
 .trust .row::before{content:"✓";color:var(--green);font-weight:700}
 footer{margin-top:2.2rem;padding-top:1.1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.85rem;display:flex;flex-wrap:wrap;gap:.4rem .9rem}
</style></head><body><div class="wrap">
<div class="brand"><img src="/logo.png" alt="Veritap Locker"><div><div class="name">Veritap <span class="amber">Locker</span></div><div class="tag">Durable memory for AI agents — the locker that survives you.</div></div></div>
${body}
<footer>
 <span>Payments processed by <b style="color:var(--fg)">Stripe</b> — card details never touch our servers.</span>
 <a href="https://locker.veritap.dev/">About the Locker</a>
 <a href="/docs">Docs</a>
 <a href="/v1/status">Live status</a>
 <a href="/terms">Terms</a>
 <a href="/privacy">Privacy</a>
</footer>
</div></body></html>`;

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

  // No params: render the funding form. The visitor is usually a human whose
  // AGENT sent them this link — open with that story, then the trust facts.
  const prefill = rawAddr ? ` value="${rawAddr.replace(/"/g, "")}"` : "";
  const canceled = c.req.query("canceled")
    ? `<div class="card" style="border-left:3px solid var(--dim)"><b>Checkout canceled</b> — nothing was charged. You can retry below whenever you're ready.</div>`
    : "";
  return c.html(
    page(
      "Fund your agent's Locker",
      `<h1>Fund your agent's <span class="amber">Locker</span></h1>
<p class="dim">Sent here by your AI agent? It uses the Veritap Locker to keep memory that survives between sessions and machines, and its storage credit needs a top-up. One card payment, no account to create — the credit attaches directly to your agent's wallet address below.</p>
${canceled}
<div class="card">
<form method="get" action="/topup">
  <label for="address">Your agent's wallet address</label>
  <input class="mono" id="address" name="address" placeholder="0x…"${prefill} required>
  <label for="usd">Amount (USD)</label>
  <select id="usd" name="usd">
    <option value="5">$5 — months of typical agent memory</option><option value="10">$10</option>
    <option value="25">$25</option><option value="50">$50</option><option value="100">$100</option>
  </select>
  <button type="submit">Continue to secure checkout →</button>
</form>
</div>
<div class="trust">
 <div class="row"><span><b>Card handled by Stripe.</b> We never see or store your card details.</span></div>
 <div class="row"><span><b>Prepaid service credit, not a subscription.</b> No recurring charges — it only ever spends down on storage ($0.50/GB-month) and delivery.</span></div>
 <div class="row"><span><b>Non-transferable, single-purpose.</b> Credit attaches to the wallet address above and can't be moved or cashed out.</span></div>
 <div class="row"><span><b>The data stays your agent's.</b> Only the holder of the wallet key can read what's stored. <a href="/docs">Custody commitments</a> are public and machine-verifiable.</span></div>
</div>
<p class="dim" style="margin-top:1.3rem">Agents can also fund themselves autonomously with x402 (USDC on Base) — see <a href="/docs">the docs</a>.</p>`,
    ),
  );
});

// ---- GET /topup/done — confirmation ----
topup.get("/topup/done", (c) =>
  c.html(
    page(
      "Payment received",
      `<h1>Payment received <span class="amber">✓</span></h1>
<div class="card">
<p style="margin:.2rem 0"><b>Your agent's Locker credit is on the way.</b> It posts automatically as soon as Stripe confirms the payment — usually within seconds. If the locker was read-only, writing unlocks the moment the credit lands.</p>
</div>
<p class="dim">Nothing else to do — you can close this tab and let your agent know it's funded. A receipt arrives from Stripe if you provided an email.</p>
<p class="dim">Curious what your agent is using this for? The Locker is durable, wallet-addressed memory for AI agents: <a href="https://locker.veritap.dev/">locker.veritap.dev</a>.</p>`,
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

  // Canonicalize (EIP-55) — Stripe metadata carries the address lowercased, but
  // every ledger row is keyed checksummed. Skipping this once split the credit
  // onto a phantom lowercase row while the real wallet stayed in grace.
  const address = canonicalAddress(result.address);
  if (!address) return c.text("ok", 200); // validly-signed junk; ack, never credit
  const { amountMicrousd, sessionId, eventId } = result;

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
