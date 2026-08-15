/** #804 OFAC screening: no-op off mainnet, correct oracle-result parsing, fail-open. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { isSanctioned } from "../../src/sanctions.ts";
import type { Env } from "../../src/types.ts";

const env = (over: Partial<Env> = {}) => ({ X402_NETWORK: "base", ...over }) as Env;
const clean = "0x1111111111111111111111111111111111111111";

afterEach(() => vi.unstubAllGlobals());

describe("sanctions screening", () => {
  it("is a no-op off Base mainnet (never calls the RPC)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await isSanctioned(env({ X402_NETWORK: "base-sepolia" }), clean, "t")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("parses a non-zero oracle word as SANCTIONED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: "0x0000000000000000000000000000000000000000000000000000000000000001" })),
    ));
    expect(await isSanctioned(env(), clean, "t")).toBe(true);
  });

  it("parses an all-zero oracle word as CLEAN", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: "0x" + "0".repeat(64) })),
    ));
    expect(await isSanctioned(env(), clean, "t")).toBe(false);
  });

  it("fails OPEN on RPC error (never blocks the service on an oracle hiccup)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("rpc down");
    }));
    expect(await isSanctioned(env(), clean, "t")).toBe(false);
  });
});
