/**
 * OFAC screening (board #804). Reads the Chainalysis sanctions oracle — an
 * on-chain contract deployed at the same address on every EVM chain incl.
 * Base — via a plain eth_call. Free, no API key. Results are cached in KV
 * (24h) because an address's status rarely changes and the payment path
 * can't afford an RPC round trip per call.
 *
 * FAIL-OPEN by design: if the RPC is unreachable we allow and log loudly
 * rather than halt all payments on an oracle hiccup — the cache still blocks
 * every already-known sanctioned address. A hard-down oracle is an ops alert,
 * not a service outage. Screening runs only on Base mainnet; on testnet /
 * the free instance it is a no-op so tests stay deterministic and offline.
 */

import type { Env } from "./types.ts";

// Chainalysis sanctions oracle — identical address on all EVM chains.
const ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";
// keccak256("isSanctioned(address)")[:4]
const SELECTOR = "0xdf592f7d";
const CACHE_TTL = 24 * 3600;

function screeningActive(env: Env): boolean {
  // Only meaningful on Base mainnet, where real USDC settles.
  return (env.X402_NETWORK ?? "base-sepolia") === "base";
}

async function oracleSays(env: Env, address: string): Promise<boolean> {
  const rpc = env.BASE_RPC_URL ?? "https://mainnet.base.org";
  const data = SELECTOR + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: ORACLE, data }, "latest"],
    }),
    signal: AbortSignal.timeout(6000),
  });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (typeof body.result !== "string") throw new Error(`oracle error: ${JSON.stringify(body.error)}`);
  // 32-byte word; non-zero => sanctioned.
  return /[1-9a-f]/i.test(body.result.replace(/^0x/, ""));
}

/**
 * True if `address` is OFAC-sanctioned. Fail-open on any error. `where` is a
 * short tag for the audit log (e.g. "pay" | "nonce").
 */
export async function isSanctioned(env: Env, address: string, where: string): Promise<boolean> {
  if (!screeningActive(env)) return false;
  const key = `ofac:${address.toLowerCase()}`;
  try {
    if (env.SANCTIONS) {
      const cached = await env.SANCTIONS.get(key);
      if (cached === "1") return true;
      if (cached === "0") return false;
    }
    const flagged = await oracleSays(env, address);
    if (env.SANCTIONS) await env.SANCTIONS.put(key, flagged ? "1" : "0", { expirationTtl: CACHE_TTL });
    return flagged;
  } catch (e) {
    // Fail-open: never block the whole service on an oracle outage.
    console.error("OFAC_SCREEN_FAILED", { where, address, error: String(e) });
    return false;
  }
}
