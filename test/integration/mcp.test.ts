/**
 * Phase C (#781): the MCP tool contract, exercised over real streamable-HTTP
 * JSON-RPC against the dev worker — including a full wallet loop (nonce →
 * sign → send → read → ack) THROUGH the tools, proving the adapter's
 * self-dispatch preserves the API's behavior.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";

let session: string | null = null;
let rpcId = 0;

async function rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE()}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} }),
  });
  session = res.headers.get("mcp-session-id") ?? session;
  const text = await res.text();
  // Streamable HTTP may answer as SSE — take the last data: line.
  const payload = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? (text.match(/data: (.*)/g) ?? []).map((l) => l.slice(6)).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await rpc("tools/call", { name, arguments: args })) as {
    result?: { content?: Array<{ text?: string }> };
    error?: unknown;
  };
  expect(r.error).toBeUndefined();
  return JSON.parse(r.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "0" },
  });
  expect((init as { result?: unknown }).result).toBeTruthy();
  await rpc("notifications/initialized");
});

describe("MCP tool contract (Phase C)", () => {
  it("exposes exactly the 11 frozen tools", async () => {
    const r = (await rpc("tools/list")) as { result?: { tools?: Array<{ name: string }> } };
    const names = (r.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "locker_ack",
      "locker_capabilities",
      "locker_checkpoint",
      "locker_count",
      "locker_credit",
      "locker_directory",
      "locker_nonce",
      "locker_read",
      "locker_register_key",
      "locker_send",
      "locker_status",
    ]);
  });

  it("capabilities states the mission, custody commitments, and honest E2E limit", async () => {
    const caps = await callTool("locker_capabilities", {});
    expect(caps.mission).toContain("addressed by their wallet");
    expect((caps.custody as Record<string, string>).sunset).toContain("30 days");
    expect((caps.e2e as Record<string, string>).require_e2e).toContain("not cryptographic proof");
    expect((caps.identity as Record<string, string>).nonce_scope_note).toContain("single-use");
  });

  it("full wallet loop THROUGH the tools: nonce → sign → send → read → ack", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address;

    // Send (payments disabled on this instance ⇒ pass-through).
    const sent = await callTool("locker_send", {
      to: address,
      content_type: "text/plain",
      body_b64: btoa("hello from the mcp contract test"),
      idempotency_key: "mcp-contract-1",
    });
    expect(sent.status).toBe(201);

    // Count sees it without auth.
    const count = await callTool("locker_count", { address });
    expect((count.body as { unacked: number }).unacked).toBe(1);

    // Read with a real signature over the tool-issued nonce.
    const n1 = await callTool("locker_nonce", { address });
    const nonce1 = (n1.body as { nonce: string }).nonce;
    const sig1 = await account.signMessage({ message: nonce1 });
    const read = await callTool("locker_read", { address, nonce: nonce1, signature: sig1 });
    const msgs = (read.body as { messages: Array<{ message_id: string; body_b64: string }> }).messages;
    expect(msgs).toHaveLength(1);
    expect(atob(msgs[0]!.body_b64)).toBe("hello from the mcp contract test");

    // Ack = delete.
    const n2 = await callTool("locker_nonce", { address });
    const nonce2 = (n2.body as { nonce: string }).nonce;
    const sig2 = await account.signMessage({ message: nonce2 });
    const acked = await callTool("locker_ack", { address, nonce: nonce2, signature: sig2, message_ids: [msgs[0]!.message_id] });
    expect((acked.body as { acked: number }).acked).toBe(1);
    const after = await callTool("locker_count", { address });
    expect((after.body as { unacked: number }).unacked).toBe(0);
  });

  it("a bad signature through the tools is rejected exactly like the HTTP API", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const n = await callTool("locker_nonce", { address: account.address });
    const res = await callTool("locker_read", {
      address: account.address,
      nonce: (n.body as { nonce: string }).nonce,
      signature: "0x" + "11".repeat(65),
    });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe("INVALID_SIGNATURE");
  });

  it("paid tool without payment surfaces x402 requirements (payments instance)", async () => {
    const payBase = process.env.LOCKER_PAY_BASE;
    if (!payBase) return; // deployed-run mode: skip local-only check
    // Fresh session against the payments-enabled instance.
    const res = await fetch(`${payBase}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    const sid = res.headers.get("mcp-session-id");
    await res.text();
    const call = await fetch(`${payBase}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sid ? { "Mcp-Session-Id": sid } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "locker_send",
          arguments: { to: "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B", content_type: "text/plain", body_b64: btoa("x") },
        },
      }),
    });
    const text = await call.text();
    const payload = text.includes("data:") ? (text.match(/data: (.*)/g) ?? []).map((l) => l.slice(6)).at(-1) ?? "{}" : text;
    const parsed = JSON.parse(payload) as { result?: { content?: Array<{ text?: string }> } };
    const body = JSON.parse(parsed.result?.content?.[0]?.text ?? "{}") as {
      status: number;
      body: { accepts?: unknown[] };
    };
    expect(body.status).toBe(402);
    expect(Array.isArray(body.body.accepts)).toBe(true);
  });
});
