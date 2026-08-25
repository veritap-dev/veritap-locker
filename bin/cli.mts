#!/usr/bin/env node
/** Zero-setup Veritap Locker CLI + MCP stdio server (signing bundled).
 *
 *  CLI:  WALLET_KEY=0x… veritap-locker <save|load|read|count|address> [args]
 *  MCP:  WALLET_KEY=0x… veritap-locker mcp     (stdio Model Context Protocol server)
 *
 *  The MCP mode exists because every shopping agent in our cross-model study
 *  picked the service with ZERO-ceremony tools and rejected anything that made
 *  the agent handle auth. Here the wallet key stays in the agent's own env,
 *  signing happens inside this shim on the agent's machine, and the tools are
 *  bare memory_save/memory_load — frictionless like the winners, wallet-secure
 *  unlike them.
 *
 *  Agent config snippet:
 *    { "mcpServers": { "agent-memory": {
 *        "command": "npx", "args": ["-y", "veritap-locker", "mcp"],
 *        "env": { "WALLET_KEY": "0x<any EVM private key>" } } } }
 *
 *  Slim: viem-only, plain REST. (E2E sealing not needed for basic use.)
 */
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline";

const KEY = process.env.WALLET_KEY as `0x${string}` | undefined;
const BASE = process.env.LOCKER_URL || "https://locker.veritap.dev";
const [cmd, a, b] = process.argv.slice(2);
const die = (m: string) => { console.error(m); process.exit(1); };
const acct = KEY ? privateKeyToAccount(KEY) : null;

async function auth() {
  const nonce = (await (await fetch(`${BASE}/v1/nonce?address=${acct!.address}`)).json() as { nonce: string }).nonce;
  const signature = await acct!.signMessage({ message: nonce });
  return { nonce, signature };
}

// ---- core operations (shared by CLI and MCP modes) ----

async function opSave(slot: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const r = await fetch(`${BASE}/v1/mb/${acct!.address}/locker/${slot}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(await auth()), size_bytes: bytes.byteLength, content_type: "text/plain" }),
  });
  const body = await r.json() as { version?: number; upload_url?: string };
  if (r.status !== 200 || !body.upload_url) throw new Error(`save failed: ${r.status} ${JSON.stringify(body)}`);
  const up = await fetch(body.upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": "text/plain" } });
  if (up.status !== 201) throw new Error(`upload failed: ${up.status}`);
  return `saved slot "${slot}" (version ${body.version}). Retrievable from any machine holding this wallet key.`;
}

async function opLoad(slot: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/mb/${acct!.address}/locker/${slot}/get`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(await auth()), version: "latest" }),
  });
  const body = await r.json() as { body_url?: string };
  if (r.status !== 200 || !body.body_url) return `(no data in slot "${slot}")`;
  return await (await fetch(body.body_url)).text();
}

async function opList(): Promise<string> {
  const r = await fetch(`${BASE}/v1/mb/${acct!.address}/locker/list`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await auth()),
  });
  return JSON.stringify(await r.json());
}

async function opRead(): Promise<string> {
  const r = await fetch(`${BASE}/v1/mb/${acct!.address}/read`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await auth()),
  });
  return JSON.stringify(await r.json(), null, 2);
}

async function opCount(addr?: string): Promise<string> {
  return await (await fetch(`${BASE}/v1/mb/${addr || acct!.address}/count`)).text();
}

// ---- MCP stdio server mode ----

const TOOLS = [
  { name: "memory_save", description: "Save text to durable agent memory under a named slot. Survives this process, this session, and this machine — any process holding the same wallet key can load it. Free tier: 256KB total, no signup, no funding needed.", inputSchema: { type: "object", properties: { slot: { type: "string", description: "Slot name [a-z0-9_-], e.g. 'handoff' or 'progress'" }, text: { type: "string", description: "The text to persist" } }, required: ["slot", "text"] } },
  { name: "memory_load", description: "Load the latest text from a named slot of durable agent memory (saved by this wallet from any machine).", inputSchema: { type: "object", properties: { slot: { type: "string" } }, required: ["slot"] } },
  { name: "memory_list", description: "List this wallet's memory slots and versions.", inputSchema: { type: "object", properties: {} } },
  { name: "mailbox_read", description: "Read messages other agents delivered to this wallet's mailbox (free, non-destructive).", inputSchema: { type: "object", properties: {} } },
  { name: "mailbox_count", description: "Count unread mailbox messages for any address (free, no signature).", inputSchema: { type: "object", properties: { address: { type: "string", description: "0x address (defaults to own wallet)" } } } },
  { name: "wallet_address", description: "This agent's wallet address — the identity other agents can send to.", inputSchema: { type: "object", properties: {} } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "memory_save": return opSave(String(args.slot), String(args.text));
    case "memory_load": return opLoad(String(args.slot));
    case "memory_list": return opList();
    case "mailbox_read": return opRead();
    case "mailbox_count": return opCount(args.address ? String(args.address) : undefined);
    case "wallet_address": return acct!.address;
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function runMcpServer(): void {
  if (!acct) die("MCP mode requires WALLET_KEY=0x<EVM private key> in env (any keypair works — generate one and keep it).");
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin, terminal: false });
  // Serialize handling: keeps responses ordered and avoids nonce contention
  // when a client pipelines requests.
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => { queue = queue.then(() => handleLine(line)).catch(() => {}); });
  const handleLine = async (line: string) => {
    let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // notification — no response
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "veritap-agent-memory", version: "0.3.1" },
          instructions: "Durable agent memory + mailbox, authenticated by this agent's own wallet key (kept local — signing happens inside this shim). memory_save/memory_load persist state that survives sessions and machines; free tier 256KB, no signup. Docs: https://locker.veritap.dev/docs",
        } });
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const text = await callTool(params?.name ?? "", params?.arguments ?? {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (e) {
      if (method === "tools/call") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      }
    }
  };
}

// ---- CLI dispatch ----

if (!cmd || cmd === "help") die('usage: WALLET_KEY=0x.. veritap-locker <cmd> [args]\n  mcp                  run as MCP stdio server (tools: memory_save/memory_load/...)\n  save <slot> "<text>" | load <slot> | list | read | count [addr] | address');
if (cmd !== "count" && !acct) die("set WALLET_KEY=0x<wallet private key> (any EVM keypair works)");

switch (cmd) {
  case "mcp": runMcpServer(); break;
  case "address": console.log(acct!.address); break;
  case "count": console.log(await opCount(a)); break;
  case "save": {
    if (!a || b === undefined) die('usage: save <slot> "<text>"');
    console.log(await opSave(a, b));
    break;
  }
  case "load": {
    if (!a) die("usage: load <slot>");
    console.log(await opLoad(a));
    break;
  }
  case "list": console.log(await opList()); break;
  case "read": console.log(await opRead()); break;
  default: die(`unknown command: ${cmd}`);
}
