/**
 * Compliance pages + abuse intake (board #804). /abuse, /privacy, /terms are
 * static HTML; POST /abuse files an ABUSE_REPORT ticket so every report lands
 * in the ledger with a timestamp (responsiveness needs a paper trail).
 *
 * Plain, honest language throughout — a verification brand's terms must not
 * overclaim. The load-bearing honesty: we CANNOT read E2E (require_e2e)
 * contents, and the terms say exactly that; we CAN read plaintext-tier bodies,
 * and the CSAM/abuse duties attach only where knowledge is possible.
 */

import { err } from "./codes.ts";
import { rateLimited } from "./auth.ts";
import type { Env } from "./types.ts";
import { nowS } from "./types.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STYLE = `<style>
 body{font:15px/1.65 ui-monospace,Menlo,monospace;background:#111318;color:#d8dbe2;max-width:820px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.35rem} h2{color:#f5a623;font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #2a2f3a;padding-bottom:.3rem}
 a{color:#6ab0f3} code{background:#1b1e27;border-radius:4px;padding:.1rem .35rem}
 .dim{color:#8a93a5} label{display:block;margin:.8rem 0 .2rem} input,textarea{width:100%;background:#171a21;color:#e6e9f0;border:1px solid #2a2f3a;border-radius:6px;padding:.5rem;font:inherit}
 button{margin-top:1rem;background:#f5a623;color:#111318;border:0;border-radius:6px;padding:.6rem 1.2rem;font:inherit;font-weight:700;cursor:pointer}
 footer{border-top:1px solid #2a2f3a;margin-top:2.5rem;padding-top:1rem;color:#8a93a5;font-size:.9rem}
</style>`;

const foot = (baseUrl: string) =>
  `<footer><a href="/">home</a> · <a href="/docs">docs</a> · <a href="/abuse">abuse</a> · <a href="/privacy">privacy</a> · <a href="/terms">terms</a> · <span class="dim">${esc(baseUrl.replace(/^https?:\/\//, ""))}</span></footer>`;

const page = (baseUrl: string, title: string, inner: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${STYLE}${inner}${foot(baseUrl)}`;

export function abusePage(baseUrl: string): string {
  return page(baseUrl, "Veritap Locker — report abuse", `
<h1>Report abuse</h1>
<p>Email <a href="mailto:abuse@veritap.dev">abuse@veritap.dev</a> or use the form below. We log every report with a timestamp and reply.</p>

<h2>What to include</h2>
<p>A <code>message_id</code> (<code>lm_…</code>) or a wallet <code>address</code> (<code>0x…</code>), and what's wrong. That's what lets us act.</p>

<h2>What we can and can't see</h2>
<p>Messages sent to a mailbox that opted into <b>require_e2e</b> are sealed-box ciphertext — we <b>cannot</b> read them, and neither can a subpoena of us. This is provable: the recipient's key registration is signed and public (<code>/v1/directory/{address}</code>). For those, we can act on <i>metadata</i> (which address, when) but not content.</p>
<p>Plaintext-tier messages (not marked encrypted) are readable by us. Abuse and legal duties that require knowledge of content attach only here.</p>

<h2>What we can do</h2>
<p>Our action space is deliberately narrow: <b>whole-address suspension</b> (operator-signed, logged in the audit ledger). We do not surgically alter mailboxes. Suspension stops new sends to/from an address; disclosed deletion rules (ack, TTL, grace) still govern existing data.</p>

<h2>Response time</h2>
<p>We aim to acknowledge reports within <b>72 hours</b> and act on clear violations promptly. Child-safety reports (CSAM) are escalated immediately — see our process in the repository's ABUSE-RUNBOOK.</p>

<h2>Submit a report</h2>
<form method="POST" action="/abuse">
 <label>Subject — a message_id or 0x address</label>
 <input name="subject" maxlength="128" placeholder="lm_… or 0x…" required>
 <label>What's wrong</label>
 <textarea name="reason" rows="4" maxlength="4000" placeholder="Describe the issue." required></textarea>
 <label>Your contact (optional, so we can reply)</label>
 <input name="contact" maxlength="200" placeholder="email">
 <button type="submit">File report</button>
</form>
<p class="dim">Reports are stored with a timestamp for our records. Don't include more personal data than necessary.</p>`);
}

export function privacyPage(baseUrl: string): string {
  return page(baseUrl, "Veritap Locker — privacy", `
<h1>Privacy</h1>
<p class="dim">Plain version. Last updated 2026-08-15.</p>
<p>Veritap Locker ("we") is a wallet-addressed mailbox and storage service for software agents. Your wallet is your account; we ask for no name, email, or other identity.</p>

<h2>What we store</h2>
<ul>
 <li><b>Message envelopes</b>: sender-provided producer/tag, content type, size, timestamps, TTL, the recipient wallet address.</li>
 <li><b>Message bodies</b>: as you send them. If you use <b>require_e2e</b>, this is sealed-box ciphertext we cannot read. Otherwise it is stored as sent.</li>
 <li><b>Encryption keys</b>: the public X25519 key and wallet signature you register (public by design, so senders can seal to you).</li>
 <li><b>Payment records</b>: the paying wallet address, amount, and on-chain transaction hash for paid actions.</li>
 <li><b>Operational logs</b>: rate-limit counters, audit state-transitions, abuse reports.</li>
</ul>

<h2>What we never see</h2>
<p>The contents of <b>require_e2e</b> messages. They are encrypted to your key before they reach us; the registration proof is public at <code>/v1/directory/{address}</code>. We hold ciphertext and cannot decrypt it.</p>

<h2>Retention &amp; deletion</h2>
<p>Data is removed <b>only</b> by disclosed rules: your acknowledgement (ack = delete), the TTL you set and paid for, storage-credit grace expiry (30 days read-only first), or an operator-signed account suspension for abuse. Never silently. Backups are retained on a rolling basis and drilled.</p>

<h2>Sunset covenant</h2>
<p>If the service ever winds down, it runs a <b>minimum of 30 days in read-only mode</b> first, so you can drain your mail and checkpoints before anything is deleted.</p>

<h2>Legal disclosure</h2>
<p>We may disclose stored data if required by valid legal process, but we can only ever disclose what we hold — which, for E2E messages, is ciphertext. We screen paying and reading wallets against the public OFAC sanctions oracle and refuse sanctioned addresses.</p>

<h2>Child safety</h2>
<p>If we obtain <b>actual knowledge</b> of child sexual abuse material in a plaintext-tier body (e.g. via an abuse report), we preserve evidence, report to the NCMEC CyberTipline as U.S. law requires, and suspend the address. We <b>cannot</b> have knowledge of require_e2e contents and make no representation that we monitor them.</p>

<h2>Contact &amp; law</h2>
<p>Abuse: <a href="mailto:abuse@veritap.dev">abuse@veritap.dev</a> · General: <a href="mailto:hello@veritap.dev">hello@veritap.dev</a>. Governed by the laws of the State of Tennessee, USA.</p>`);
}

export function termsPage(baseUrl: string): string {
  return page(baseUrl, "Veritap Locker — terms", `
<h1>Terms of Service</h1>
<p class="dim">Plain version. Last updated 2026-08-15.</p>

<h2>The service</h2>
<p>Veritap Locker delivers data to wallet-addressed mailboxes and stores checkpoints for software agents. Anyone may pay (x402, USDC on Base) to send to an address; the holder of that wallet's key reads for free by signing. Receiving costs nothing.</p>

<h2>Acceptable use</h2>
<p>You may not use the Locker to store or transmit content that is illegal to possess or distribute, to facilitate sanctioned transactions, or to abuse, defraud, or harm others. We screen paying and reading wallets against the OFAC sanctions oracle and refuse sanctioned addresses (<code>SANCTIONED_ADDRESS</code>). Report abuse at <a href="/abuse">/abuse</a>.</p>

<h2>Payments</h2>
<p>Paid actions settle on-chain via x402 before delivery. Prices are published in <code>/v1/status</code> and the payment challenge. Because settlement is on-chain and delivery is immediate, payments are non-refundable except where we fail to deliver a paid action (we reconcile those; see the payment-ambiguity handling in the open-source code).</p>

<h2>Custody &amp; deletion</h2>
<p>Data is deleted <b>only</b> by disclosed rules — your ack, TTL expiry, credit-grace expiry, or operator-signed suspension. If the service winds down, it runs a <b>minimum 30 days read-only</b> first so you can drain everything. These commitments are part of these terms, not marketing.</p>

<h2>Encryption &amp; our knowledge</h2>
<p>Messages to a <b>require_e2e</b> mailbox are end-to-end encrypted to your key; we cannot read them and make no claim to monitor them. Plaintext-tier messages are readable by us. Our abuse and child-safety duties attach only where knowledge is possible — i.e. plaintext bodies via reports.</p>

<h2>Child safety (CSAM)</h2>
<p>On actual knowledge of CSAM in a plaintext body, we preserve evidence, report to the NCMEC CyberTipline, and suspend the address, as U.S. law requires.</p>

<h2>DMCA</h2>
<p>Copyright complaints: send a compliant notice to our Designated Agent. <span class="dim">Designated Agent registration with the U.S. Copyright Office is pending; agent contact will be listed here on completion. In the interim, notices may be sent to <a href="mailto:abuse@veritap.dev">abuse@veritap.dev</a>.</span></p>

<h2>No warranty; limitation of liability</h2>
<p>The service is provided "as is," without warranty of any kind. To the maximum extent permitted by law, our aggregate liability for any claim is limited to the amount you paid us for the action giving rise to the claim. We are not liable for indirect or consequential damages.</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of the State of Tennessee, USA. Contact: <a href="mailto:hello@veritap.dev">hello@veritap.dev</a>.</p>`);
}

/** POST /abuse — files an ABUSE_REPORT ticket. Rate-limited; accepts form or JSON. */
export async function handleAbuseReport(env: Env, req: Request): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "?";
  if (await rateLimited(env, `abuse:${ip}`, 10))
    return err("RATE_LIMITED", "Too many reports; try later.", 429);

  const ct = req.headers.get("content-type") ?? "";
  let subject = "", reason = "", contact = "";
  if (ct.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, string>;
    ({ subject = "", reason = "", contact = "" } = b);
  } else {
    const f = await req.formData().catch(() => null);
    subject = String(f?.get("subject") ?? "");
    reason = String(f?.get("reason") ?? "");
    contact = String(f?.get("contact") ?? "");
  }
  subject = subject.slice(0, 128).trim();
  reason = reason.slice(0, 4000).trim();
  contact = contact.slice(0, 200).trim();
  if (!subject || !reason)
    return err("VALIDATION_ERROR", "subject (a message_id or 0x address) and reason are required.", 400);

  const t = nowS();
  const desc = JSON.stringify({ subject, reason, contact: contact || null, ip, at: t });
  const row = await env.DB.prepare(
    `INSERT INTO tickets (wallet, kind, description, created_at) VALUES (?, 'abuse_report', ?, ?) RETURNING id`,
  )
    .bind(subject.startsWith("0x") ? subject : null, desc, t)
    .first<{ id: number }>();

  const ref = `AB-${row?.id ?? "?"}`;
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html"))
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Report filed</title><body style="font:15px ui-monospace,monospace;background:#111318;color:#d8dbe2;max-width:640px;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.2rem">Report filed</h1><p>Reference <b style="color:#f5a623">${esc(ref)}</b>. We log every report and reply. Thank you.</p><p><a style="color:#6ab0f3" href="/abuse">← back</a></p></body>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 201 },
    );
  return new Response(JSON.stringify({ status: "ABUSE_RECEIVED", reference: ref }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
