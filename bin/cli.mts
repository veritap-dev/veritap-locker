#!/usr/bin/env node
/** Zero-setup Veritap Locker CLI (signing bundled — no lib to install).
 *  WALLET_KEY=0x… node locker.mjs <save|load|read|count|address> [args]
 *  Slim: viem-only, plain REST. (E2E sealing not needed for basic use.) */
import { privateKeyToAccount } from "viem/accounts";

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

if (!cmd || cmd === "help") die('usage: WALLET_KEY=0x.. node locker.mjs <cmd> [args]\n  save <slot> "<text>" | load <slot> | read | count [addr] | address');
if (cmd !== "count" && !acct) die("set WALLET_KEY=0x<wallet private key>");

switch (cmd) {
  case "address": console.log(acct!.address); break;
  case "count": {
    const addr = a || acct?.address;
    console.log(await (await fetch(`${BASE}/v1/mb/${addr}/count`)).text());
    break;
  }
  case "save": {
    if (!a || b === undefined) die('usage: save <slot> "<text>"');
    const bytes = new TextEncoder().encode(b);
    const r = await fetch(`${BASE}/v1/mb/${acct!.address}/locker/${a}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(await auth()), size_bytes: bytes.byteLength, content_type: "text/plain" }),
    });
    const body = await r.json() as { version?: number; upload_url?: string; error?: string };
    if (r.status !== 200 || !body.upload_url) die(`save failed: ${r.status} ${JSON.stringify(body)}`);
    const up = await fetch(body.upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": "text/plain" } });
    if (up.status !== 201) die(`upload failed: ${up.status}`);
    console.log(`saved slot "${a}" (version ${body.version})`);
    break;
  }
  case "load": {
    if (!a) die("usage: load <slot>");
    const r = await fetch(`${BASE}/v1/mb/${acct!.address}/locker/${a}/get`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(await auth()), version: "latest" }),
    });
    const body = await r.json() as { body_url?: string };
    if (r.status !== 200 || !body.body_url) { console.log(`(empty slot "${a}")`); break; }
    console.log(await (await fetch(body.body_url)).text());
    break;
  }
  case "read": {
    const r = await fetch(`${BASE}/v1/mb/${acct!.address}/read`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await auth()),
    });
    console.log(JSON.stringify(await r.json(), null, 2));
    break;
  }
  default: die(`unknown command: ${cmd}`);
}
