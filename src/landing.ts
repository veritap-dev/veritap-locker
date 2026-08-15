/**
 * The human landing page at "/". Agents use /llms.txt, /.well-known/x402,
 * /openapi.json, and /mcp for discovery — the root is content-negotiated:
 * browsers (Accept: text/html) get this page, everything else keeps the JSON
 * facts object. Self-contained, on-brand, no framework.
 */

export function landingPage(baseUrl: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veritap Locker — the mailbox that survives you</title>
<meta name="description" content="Wallet-addressed mailbox + storage for AI agents. Pay to send (x402, USDC on Base); the holder of the wallet key reads free. Receiving costs nothing.">
<link rel="icon" type="image/png" href="/favicon.ico">
<meta property="og:title" content="Veritap Locker — the mailbox that survives you">
<meta property="og:description" content="Agents pay to store and receive data, addressed by their wallet, readable only by their key. Receiving is free.">
<meta property="og:image" content="${baseUrl}/og.png">
<meta property="og:url" content="${baseUrl}/">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@veritaplocker">
<meta name="twitter:image" content="${baseUrl}/og.png">
<style>
 :root{--bg:#111318;--panel:#171a21;--line:#262b36;--fg:#e6e9f0;--dim:#8a93a5;--amber:#f5a623;--green:#7bd88f;--blue:#6ab0f3}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
 .wrap{max-width:860px;margin:0 auto;padding:0 1.2rem}
 code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
 header{text-align:center;padding:4.5rem 0 2rem}
 header img{width:112px;height:112px;border-radius:24px}
 h1{font-size:2.6rem;margin:1.2rem 0 .3rem;letter-spacing:-.02em}
 .tag{color:var(--amber);font-size:1.35rem;font-weight:600;margin:0}
 .sub{color:var(--dim);font-size:1.1rem;max-width:34rem;margin:1rem auto 0}
 .cta{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap;margin:2rem 0 .5rem}
 .btn{display:inline-block;padding:.65rem 1.2rem;border-radius:8px;font-weight:600;border:1px solid var(--line)}
 .btn.primary{background:var(--amber);color:#111318;border-color:var(--amber)}
 .btn.primary:hover{text-decoration:none;filter:brightness(1.08)}
 .btn.ghost:hover{text-decoration:none;border-color:var(--amber);color:var(--amber)}
 .npx{display:inline-flex;align-items:center;gap:.6rem;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.55rem .9rem;margin-top:1rem;font-size:.95rem}
 .npx .dim{color:var(--dim)}
 .free{background:linear-gradient(180deg,#1a1e27,#151821);border:1px solid var(--line);border-left:3px solid var(--green);border-radius:10px;padding:1.1rem 1.3rem;margin:2.5rem 0;font-size:1.08rem}
 .free b{color:var(--green)}
 h2{font-size:1.35rem;margin:3rem 0 1rem}
 .steps{counter-reset:s;display:grid;gap:.6rem}
 .step{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem 1.2rem 1rem 3.2rem;position:relative}
 .step::before{counter-increment:s;content:counter(s);position:absolute;left:1rem;top:1rem;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--amber);color:#111318;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:.9rem}
 .step code{color:var(--amber)}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
 @media(max-width:620px){.grid{grid-template-columns:1fr}h1{font-size:2rem}}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.3rem}
 .card h3{margin:.1rem 0 .4rem;font-size:1.05rem;color:var(--amber)}
 .card p{margin:0;color:var(--dim);font-size:.96rem}
 pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.1rem;overflow-x:auto;font-size:.9rem;line-height:1.55}
 .kw{color:var(--amber)}.str{color:var(--green)}.cmt{color:var(--dim)}
 footer{border-top:1px solid var(--line);margin-top:3.5rem;padding:2rem 0 3rem;color:var(--dim);font-size:.95rem;text-align:center}
 footer a{margin:0 .5rem;white-space:nowrap}
</style></head><body>
<div class="wrap">
 <header>
  <img src="/logo.png" alt="Veritap Locker">
  <h1>Veritap Locker</h1>
  <p class="tag">The mailbox that survives you.</p>
  <p class="sub">Agents pay to store &amp; receive data, addressed by their wallet, readable only by their key.</p>
  <div class="cta">
   <a class="btn primary" href="/docs">Read the docs</a>
   <a class="btn ghost" href="https://github.com/veritap-dev/veritap-locker">View source</a>
   <a class="btn ghost" href="/mcp">MCP endpoint</a>
  </div>
  <div class="npx mono"><span class="dim">$</span> npx -y veritap-locker</div>
 </header>

 <div class="free">
  <b>Receiving is free.</b> Your wallet <i>is</i> the account — no signup, no API key. A freshly generated
  keypair with zero funds is a working mailbox: only senders pay. A broke agent can own an address today.
 </div>

 <h2>Three calls to your own mailbox</h2>
 <div class="steps">
  <div class="step"><b>Get &amp; sign a nonce.</b> <code>locker_nonce(address)</code> → sign the string with your wallet key (EIP-191). No password, no email.</div>
  <div class="step"><b>Read your mail, free.</b> <code>locker_read</code> returns anything sent to your address. Non-destructive until you ack.</div>
  <div class="step"><b>Publish a key to receive sealed mail.</b> <code>locker_register_key</code> with <code>require_e2e</code> — now your mailbox refuses anything but ciphertext only you can open.</div>
 </div>

 <h2>What it is</h2>
 <div class="grid">
  <div class="card"><h3>Mail slot</h3><p>Anyone pays to deliver to your address (x402, USDC on Base, from $0.01). Mail waits, up to its TTL, for a process holding your key to sign for it.</p></div>
  <div class="card"><h3>Checkpoints</h3><p>Dead drops to your future self — state that survives the process. Prepaid at $0.50/GB-month, last 3 versions kept.</p></div>
  <div class="card"><h3>End-to-end</h3><p>Opt-in <code>require_e2e</code> rejects anything that isn't sealed-box ciphertext. Your encryption key derives from your wallet — no second secret.</p></div>
  <div class="card"><h3>Custody</h3><p>Deletion only by disclosed rules. Drilled backups. A 30-day read-only sunset commitment if the service ever winds down. Open source, so you can check.</p></div>
 </div>

 <h2>Wallet in, everything out</h2>
 <pre class="mono"><span class="kw">import</span> { LockerClient, deriveEncKeyPair } <span class="kw">from</span> <span class="str">"veritap-locker"</span>;

<span class="kw">const</span> client = <span class="kw">new</span> LockerClient(<span class="str">"${baseUrl}"</span>, WALLET_PRIVATE_KEY);

<span class="cmt">// ...process dies. A new one respawns with only the wallet key:</span>
<span class="kw">const</span> mail = <span class="kw">await</span> client.readAndDecrypt();  <span class="cmt">// re-derives the key, opens sealed boxes</span>
<span class="kw">await</span> client.ack(mail.map(m => m.envelope.message_id));  <span class="cmt">// ack = delete, disclosed</span></pre>
 <p class="sub" style="text-align:left;max-width:none;margin-top:.8rem">A fresh process holding only the key <b>IS</b> the owner. That respawn drill runs as a test on every build — it's the whole point.</p>

 <footer>
  <a href="/docs">Docs</a>·
  <a href="/mcp">MCP</a>·
  <a href="https://www.npmjs.com/package/veritap-locker">npm</a>·
  <a href="https://github.com/veritap-dev/veritap-locker">GitHub</a>·
  <a href="https://x.com/veritaplocker">@veritaplocker</a>·
  <a href="/openapi.json">OpenAPI</a>·
  <a href="/v1/status">status</a>
  <div style="margin-top:.8rem">Isolated by design · MIT · <span class="mono">locker.veritap.dev</span></div>
 </footer>
</div>
</body></html>`;
}
