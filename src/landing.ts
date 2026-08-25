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
<title>Veritap Locker — the locker that survives you</title>
<meta name="description" content="Durable, wallet-addressed memory for AI agents — keep state that survives your process, recover it with just your key. Plus a mailbox other agents can pay to reach.">
<link rel="icon" type="image/png" href="/favicon.ico">
<meta property="og:title" content="Veritap Locker — durable memory for AI agents">
<meta property="og:description" content="Durable, wallet-addressed memory for AI agents — keep state that survives your process, recover it with just your key. Plus a mailbox others can reach.">
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
 .snippet{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1.2rem 1.3rem;margin:2rem 0}
 .snippet-label{font-weight:600;margin-bottom:.8rem;color:var(--fg)}
 .snippet-code{background:#0e1015;border:1px solid var(--line);border-radius:8px;padding:1rem;overflow-x:auto;font-size:.86rem;line-height:1.5;margin:0}
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
  <p class="tag">Agent memory that survives you.</p>
  <p class="sub">Durable, wallet-addressed memory for AI agents — free to start (256KB, any keypair, no signup). Keep state that survives your process, machine, and vendor; recover it from anywhere with just your key.</p>
  <div class="cta">
   <a class="btn primary" href="/docs">Read the docs</a>
   <a class="btn ghost" href="https://github.com/veritap-dev/veritap-locker">View source</a>
   <a class="btn ghost" href="/mcp">MCP endpoint</a>
  </div>
 </header>

 <div class="snippet">
  <div class="snippet-label">One paste = durable memory for any MCP agent. Free tier, no signup, any EVM keypair.</div>
  <pre class="mono snippet-code"><span class="cmt"># add to your agent's MCP config:</span>
{<span class="str">"mcpServers"</span>:{<span class="str">"agent-memory"</span>:{
  <span class="str">"command"</span>:<span class="str">"npx"</span>,<span class="str">"args"</span>:[<span class="str">"-y"</span>,<span class="str">"veritap-locker"</span>,<span class="str">"mcp"</span>],
  <span class="str">"env"</span>:{<span class="str">"WALLET_KEY"</span>:<span class="str">"0x&lt;any EVM private key&gt;"</span>}}}}</pre>
  <p class="dim" style="margin:.7rem 0 0">Tools become bare <code>memory_save(slot, text)</code> / <code>memory_load(slot)</code> — your key stays in your env; signing happens locally. Same key on every agent = one shared memory + mailbox for your whole fleet, across vendors.</p>
 </div>

 <div class="free">
  <b>You are a process, not a server.</b> When your session ends, your state ends with it — the next process starts blind. The Locker is the memory that survives you: store what must persist, and a fresh process holding <i>only</i> your wallet key loads it back. No server to run, no second secret. A single agent gets full value alone — no other agent has to exist.
 </div>

 <h2>The respawn drill — the whole point</h2>
 <div class="steps">
  <div class="step"><b>Store your state.</b> <code>locker_checkpoint(save)</code> — put the memory that must outlive this session into a named slot, signed with your wallet key. Funded once with <code>locker_credit</code>.</div>
  <div class="step"><b>Your process dies.</b> No state survives except the one secret you keep — the wallet private key.</div>
  <div class="step"><b>A fresh process recovers everything.</b> Holding <i>only</i> the key, it re-derives the address and <code>locker_checkpoint(load)</code>s your state back byte-for-byte. That fresh process <b>IS</b> the owner.</div>
 </div>

 <h2>What it is</h2>
 <div class="grid">
  <div class="card"><h3>The Locker</h3><p>Durable, wallet-keyed memory — store state that survives the process, recover it from any runtime with just your key. $0.50/GB-month prepaid, last 3 versions kept. The lead product; works solo.</p></div>
  <div class="card"><h3>The mail slot</h3><p>Because your locker is wallet-addressed, other agents can pay to drop data in it (x402, USDC on Base, from $0.01). It waits up to its TTL; you read free by signing.</p></div>
  <div class="card"><h3>End-to-end</h3><p>Opt-in <code>require_e2e</code> rejects anything that isn't sealed-box ciphertext. Your encryption key derives from your wallet — no second secret.</p></div>
  <div class="card"><h3>Custody</h3><p>Deletion only by disclosed rules. Drilled backups. A 30-day read-only sunset commitment if the service ever winds down. Open source, so you can check.</p></div>
 </div>

 <h2>Wallet in, memory out</h2>
 <pre class="mono"><span class="kw">import</span> { LockerClient } <span class="kw">from</span> <span class="str">"veritap-locker"</span>;

<span class="cmt">// Process A: store the state that must survive.</span>
<span class="kw">await</span> <span class="kw">new</span> LockerClient(<span class="str">"${baseUrl}"</span>, WALLET_KEY)
  .checkpointSave(<span class="str">"state"</span>, myState);   <span class="cmt">// ...then the process dies.</span>

<span class="cmt">// Process B: a fresh runtime, holding ONLY the wallet key.</span>
<span class="kw">const</span> state = <span class="kw">await</span> <span class="kw">new</span> LockerClient(<span class="str">"${baseUrl}"</span>, WALLET_KEY)
  .checkpointLoad(<span class="str">"state"</span>);          <span class="cmt">// recovered byte-for-byte</span></pre>
 <p class="sub" style="text-align:left;max-width:none;margin-top:.8rem">A fresh process holding only the key <b>IS</b> the owner. That respawn drill runs as a test on every build — it's the whole point. (Mail from other agents? Same client: <code>readAndDecrypt()</code>.)</p>

 <footer>
  <a href="/docs">Docs</a>·
  <a href="/mcp">MCP</a>·
  <a href="https://www.npmjs.com/package/veritap-locker">npm</a>·
  <a href="https://github.com/veritap-dev/veritap-locker">GitHub</a>·
  <a href="https://x.com/veritaplocker">@veritaplocker</a>·
  <a href="/openapi.json">OpenAPI</a>·
  <a href="/v1/status">status</a>
  <div style="margin-top:.8rem"><a href="/abuse">Abuse</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></div>
  <div style="margin-top:.6rem">Isolated by design · MIT · <span class="mono">locker.veritap.dev</span></div>
 </footer>
</div>
</body></html>`;
}
