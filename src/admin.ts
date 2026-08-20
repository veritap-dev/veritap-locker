/**
 * #788 — the adoption funnel, one read-only HTML page, no framework.
 * Gate: ADMIN_KEY secret as ?k= (HTTPS-only surface; page sends no referrer).
 *
 * NON-NEGOTIABLE: self traffic (SELF_ADDRESSES + receiving address) is
 * computed as its own column and NEVER blended into adoption numbers — the
 * sensor-ledger lesson (own test traffic mistaken for a customer) is
 * structural here, not a convention.
 */

import { LIMITS } from "./codes.ts";
import { selfAddresses } from "./metrics.ts";
import type { Env } from "./types.ts";
import { nowS } from "./types.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function adminPanel(env: Env, key: string | null): Promise<Response> {
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY)
    return new Response("Not found.", { status: 404 });

  const self = selfAddresses(env);
  const selfSql = self.length ? self.map((a) => `'${a}'`).join(",") : "''";
  const q = async <T>(sql: string): Promise<T[]> =>
    (await env.DB.prepare(sql).all<T>()).results ?? [];

  // ---- funnel counters (metrics table, last 14 days) ----
  const metrics = await q<{ k: string; day: string; n: number }>(
    `SELECT k, day, n FROM metrics WHERE day >= date('now','-14 days') ORDER BY day, k`,
  );
  const totals: Record<string, number> = {};
  for (const m of metrics) totals[m.k] = (totals[m.k] ?? 0) + m.n;
  const quotes = (totals["quote402:send"] ?? 0) + (totals["quote402:credit"] ?? 0);
  const settled = (totals["settled:send"] ?? 0) + (totals["settled:credit"] ?? 0);

  // ---- identity: wallets seen, self split out ----
  const wallets = await q<{ kind: string; total: number; self_n: number }>(
    `SELECT kind, count(DISTINCT address) AS total,
            count(DISTINCT CASE WHEN lower(address) IN (${selfSql}) THEN address END) AS self_n
       FROM addresses_seen GROUP BY kind ORDER BY kind`,
  );
  const newPerDay = await q<{ day: string; n: number }>(
    `SELECT date(first_seen,'unixepoch') AS day, count(DISTINCT address) AS n
       FROM addresses_seen WHERE lower(address) NOT IN (${selfSql})
       GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
  );

  // ---- usage depth (self excluded; self shown separately) ----
  const msgs = await q<{ product: string; who: string; n: number; bytes: number; paid: number }>(
    `SELECT COALESCE(product,'message') AS product,
            CASE WHEN lower(address) IN (${selfSql}) OR lower(COALESCE(payer,'')) IN (${selfSql}) THEN 'self' ELSE 'external' END AS who,
            count(*) AS n, COALESCE(sum(size),0) AS bytes, COALESCE(sum(paid_microusd),0) AS paid
       FROM messages GROUP BY 1,2 ORDER BY 1,2`,
  );
  const producers = await q<{ producer: string; n: number }>(
    `SELECT COALESCE(producer,'(none)') AS producer, count(*) AS n FROM messages
      WHERE lower(address) NOT IN (${selfSql}) AND lower(COALESCE(payer,'')) NOT IN (${selfSql})
      GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  );
  const keysRows = await q<{ require_e2e: number; private_count: number; n: number }>(
    `SELECT require_e2e, private_count, count(*) AS n FROM keys WHERE superseded_at IS NULL GROUP BY 1,2`,
  );
  const ckpt = await q<{ who: string; addrs: number; n: number; bytes: number }>(
    `SELECT CASE WHEN lower(address) IN (${selfSql}) THEN 'self' ELSE 'external' END AS who,
            count(DISTINCT address) AS addrs, count(*) AS n, COALESCE(sum(size),0) AS bytes
       FROM checkpoints GROUP BY 1`,
  );
  const tickets = await q<{ kind: string; n: number }>(
    `SELECT kind, count(*) AS n FROM tickets GROUP BY 1 ORDER BY n DESC`,
  );
  const revenue = await q<{ who: string; usd: number }>(
    `SELECT CASE WHEN lower(COALESCE(payer, address)) IN (${selfSql}) THEN 'self' ELSE 'external' END AS who,
            COALESCE(sum(paid_microusd),0)/1000000.0 AS usd FROM messages GROUP BY 1`,
  );

  // ---- ops corner ----
  const spendToday = await q<{ n: number }>(
    `SELECT COALESCE(sum(n),0) AS n FROM rate_counters WHERE bucket LIKE 'spendday:%' AND window_start = ${nowS() - (nowS() % 86400)}`,
  );
  const lastOps = await q<{ entity: string; to_state: string; at: number }>(
    `SELECT entity, to_state, max(at) AS at FROM state_transitions
      WHERE entity IN ('backup','breaker','tripwire') GROUP BY entity, to_state ORDER BY at DESC LIMIT 6`,
  );

  const daySeries = (prefix: string) => {
    const byDay: Record<string, number> = {};
    for (const m of metrics) if (m.k.startsWith(prefix)) byDay[m.day] = (byDay[m.day] ?? 0) + m.n;
    return Object.entries(byDay).sort().map(([d, n]) => `${d.slice(5)}:${n}`).join(" · ") || "—";
  };
  const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
  const table = (head: string[], rows: string[]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="dim">nothing yet</td></tr>`}</tbody></table>`;

  const html = `<!doctype html>
<meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Locker Adoption</title>
<style>
 body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#111318;color:#d8dbe2;max-width:960px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.2rem} h2{font-size:1rem;color:#f5a623;margin-top:2rem;border-bottom:1px solid #2a2f3a;padding-bottom:.3rem}
 table{border-collapse:collapse;width:100%;margin:.5rem 0} td,th{border:1px solid #2a2f3a;padding:.3rem .6rem;text-align:left}
 th{color:#8a93a5;font-weight:600} .big{font-size:1.6rem;color:#fff} .dim{color:#6a7385} .self{color:#e0708a}
 a{color:#6ab0f3} .cards{display:flex;gap:1rem;flex-wrap:wrap} .card{border:1px solid #2a2f3a;border-radius:6px;padding: .7rem 1rem;min-width:10rem}
</style>
<h1>Veritap Locker — adoption funnel <span class="dim">(read-only · self-traffic never blended · UTC)</span></h1>

<div class="cards">
 <div class="card"><div class="dim">quotes served (14d)</div><div class="big">${quotes}</div></div>
 <div class="card"><div class="dim">settled (14d)</div><div class="big">${settled}</div></div>
 <div class="card"><div class="dim">conversion</div><div class="big">${quotes ? ((100 * settled) / quotes).toFixed(1) + "%" : "—"}</div></div>
 <div class="card"><div class="dim">revenue external / <span class="self">self</span></div><div class="big">$${esc((revenue.find((r) => r.who === "external")?.usd ?? 0).toFixed(2))} / <span class="self">$${esc((revenue.find((r) => r.who === "self")?.usd ?? 0).toFixed(2))}</span></div></div>
</div>
<p class="dim">Self wallets excluded from adoption: ${esc(self.join(", ") || "(none configured!)")}</p>

<h2>1 · Discovery — someone found us</h2>
${table(["signal", "14d total", "by day"], [
  row(["MCP initialize", totals["disc:mcp_initialize"] ?? 0, daySeries("disc:mcp_initialize")]),
  row(["MCP tools/list", totals["disc:tools_list"] ?? 0, daySeries("disc:tools_list")]),
  row(["locker_capabilities calls", totals["mcp:locker_capabilities"] ?? 0, daySeries("mcp:locker_capabilities")]),
  row(["llms.txt fetches", totals["disc:llms_txt"] ?? 0, daySeries("disc:llms_txt")]),
  row(["openapi.json fetches", totals["disc:openapi"] ?? 0, daySeries("disc:openapi")]),
])}
<p><b>Agents or crawlers?</b> — capabilities reads split by caller User-Agent (instrumented 2026-08-20; earlier reads uncategorized). <span style="color:#7bd88f">agent</span> = a known agent client; validator/smithery/scripted lean crawler.</p>
${table(["capabilities caller", "14d"], (() => {
  const cls = ["agent", "smithery", "validator", "scripted", "browser", "unknown", "none"];
  return cls.filter((k) => (totals[`capsua:${k}`] ?? 0) > 0).map((k) =>
    `<tr${k === "agent" ? ' style="color:#7bd88f"' : ""}><td>${esc(k)}</td><td>${esc(totals[`capsua:${k}`] ?? 0)}</td></tr>`,
  );
})())}
<p><b>Who connects (initialize clientInfo.name)</b> — how MCP clients self-identify:</p>
${table(["client name", "14d initializes"],
  Object.entries(totals).filter(([k]) => k.startsWith("client:")).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, n]) => row([k.slice("client:".length), n])))}

<h2>2 · Window-shopping → conversion</h2>
${table(["", "send", "credit", "probe (bare/invalid)"], [
  row(["402 quotes served", totals["quote402:send"] ?? 0, totals["quote402:credit"] ?? 0, totals["quote402:probe"] ?? 0]),
  row(["settled payments", totals["settled:send"] ?? 0, totals["settled:credit"] ?? 0, "—"]),
])}
<p><b>Send quotes, disambiguated</b> — a valid, unpaid send can still be a crawler walking our published example. Only <span class="self" style="color:#7bd88f">EXTERNAL</span> is real interest:</p>
${table(["bucket", "14d", "what it is"], [
  row(["self", totals["qual:send:self"] ?? 0, "target is one of our own wallets (incl. the doc example address)"]),
  row(["example_echo", totals["qual:send:example_echo"] ?? 0, "body byte-identical to our OpenAPI/Bazaar sample → schema-aware crawler"]),
  `<tr style="color:#7bd88f"><td><b>EXTERNAL</b></td><td><b>${esc(totals["qual:send:external"] ?? 0)}</b></td><td>real address + non-example body → genuine window-shopper</td></tr>`,
])}
<p class="dim">Conversion counts real quotes only (valid request, no payment); probes are crawlers/validators and excluded. The disambiguation split above is instrumented from 2026-08-15 — earlier quotes predate it and are uncategorized.</p>

<h2>3 · Identity — distinct wallets <span class="dim">(external / self)</span></h2>
${table(["interaction", "external wallets", "self"], wallets.map((w) => row([w.kind, w.total - w.self_n, w.self_n])))}
<p><b>New external wallets per day:</b> ${esc(newPerDay.map((d) => `${d.day.slice(5)}:${d.n}`).join(" · ") || "none yet")}</p>

<h2>4 · Usage depth</h2>
${table(["product", "who", "messages", "bytes", "paid µ$"], msgs.map((m) => row([m.product, m.who, m.n, m.bytes, m.paid])))}
${table(["metric", "14d"], [
  row(["reads (signed)", totals["use:read"] ?? 0]),
  row(["acks", totals["use:ack"] ?? 0]),
  row(["checkpoint saves", totals["use:checkpoint_save"] ?? 0]),
  row(["key registrations", totals["use:key_register"] ?? 0]),
])}
${table(["keys (active)", "count"], keysRows.map((k) => row([`require_e2e=${k.require_e2e} private_count=${k.private_count}`, k.n])))}
${table(["checkpoints", "addresses", "versions", "bytes"], ckpt.map((c2) => row([c2.who, c2.addrs, c2.n, c2.bytes])))}
<p><b>Top external producers:</b> ${esc(producers.map((p) => `${p.producer} (${p.n})`).join(", ") || "none yet")}</p>

<h2>5 · Tickets (demand signal)</h2>
${table(["kind", "count"], tickets.map((t) => row([t.kind, t.n])))}

<h2>6 · Ops corner</h2>
${table(["", ""], [
  row(["requests today (breaker counter)", spendToday[0]?.n ?? 0]),
  row(["writes mode", env.LOCKER_WRITES === "off" ? "WRITES_OFF (wind-down)" : "on"]),
  row(["daily budget", `$${esc(env.DAILY_COST_BUDGET_USD ?? "50")}`]),
  ...lastOps.map((o) => row([`last ${o.entity} → ${o.to_state}`, new Date(o.at * 1000).toISOString()])),
])}

<h2>External references</h2>
<ul>
 <li><a href="https://smithery.ai/servers/veritapdev/locker" rel="noreferrer">Smithery listing</a></li>
 <li><a href="https://www.x402scan.com" rel="noreferrer">x402scan</a> · <a href="https://tryponcho.com/m/locker.veritap.dev" rel="noreferrer">Poncho merchant page</a></li>
 <li><a href="https://registry.modelcontextprotocol.io/v0/servers?search=dev.veritap" rel="noreferrer">Official MCP registry entry</a></li>
 <li><a href="https://dash.cloudflare.com/738143e88a9302f70a37a43af0c062d6/workers/services/view/veritap-locker/production/metrics" rel="noreferrer">CF Workers metrics</a></li>
</ul>
<p class="dim">Generated ${new Date().toISOString()} · page size limits: read_page_max=${LIMITS.read_page_max}</p>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
