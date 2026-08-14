/** §12-A unit vectors: EIP-191, address canonicalization, entropy gate, sealed box. */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import nacl from "tweetnacl";

import { canonicalAddress } from "../../src/auth.ts";
import { e2eGate, shannonBitsPerByte } from "../../src/entropy.ts";
import { sealedBoxOpen, sealedBoxSeal } from "../../client/index.ts";

// Fixed test key (never used anywhere real).
const PRIV = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PRIV);

describe("EIP-191 (§12.1-2)", () => {
  it("sign/recover round trip with the \\x19 prefix semantics", async () => {
    const msg = `veritap-locker:auth:${account.address}:deadbeef:9999999999`;
    const sig = await account.signMessage({ message: msg });
    const rec = await recoverMessageAddress({ message: msg, signature: sig });
    expect(rec).toBe(account.address);
  });

  it("checksummed and lowercase inputs canonicalize identically", () => {
    const lower = account.address.toLowerCase();
    expect(canonicalAddress(lower)).toBe(account.address);
    expect(canonicalAddress(account.address)).toBe(account.address);
    expect(canonicalAddress("0xnothex")).toBeNull();
    expect(canonicalAddress("")).toBeNull();
  });
});

describe("sealed box (§12.5)", () => {
  it("seal → open round trip; wrong key fails", () => {
    const kp = nacl.box.keyPair();
    const other = nacl.box.keyPair();
    const msg = new TextEncoder().encode("checkpoint your state before you die");
    const sealed = sealedBoxSeal(msg, kp.publicKey);
    const opened = sealedBoxOpen(sealed, kp.publicKey, kp.secretKey);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe("checkpoint your state before you die");
    expect(sealedBoxOpen(sealed, other.publicKey, other.secretKey)).toBeNull();
  });
});

describe("require_e2e gate (§12.6a)", () => {
  it("accepts real sealed-box ciphertext", () => {
    const kp = nacl.box.keyPair();
    const sealed = sealedBoxSeal(crypto.getRandomValues(new Uint8Array(256)), kp.publicKey);
    expect(e2eGate(sealed).pass).toBe(true);
  });
  it("rejects plaintext JSON", () => {
    const g = e2eGate(new TextEncoder().encode(JSON.stringify({ verdict: "pass", job: "vt_123", details: "x".repeat(100) })));
    expect(g.pass).toBe(false);
    expect(g.reason).toContain("json");
  });
  it("rejects low-entropy bodies", () => {
    const g = e2eGate(new Uint8Array(256).fill(7));
    expect(g.pass).toBe(false);
  });
  it("rejects short bodies", () => {
    expect(e2eGate(crypto.getRandomValues(new Uint8Array(16))).pass).toBe(false);
  });
  it("accepts random high-entropy bytes (documented limit)", () => {
    expect(e2eGate(crypto.getRandomValues(new Uint8Array(128))).pass).toBe(true);
  });
  it("entropy math sanity", () => {
    expect(shannonBitsPerByte(new Uint8Array(0))).toBe(0);
    expect(shannonBitsPerByte(new Uint8Array(1024).fill(65))).toBe(0);
    expect(shannonBitsPerByte(crypto.getRandomValues(new Uint8Array(65536)))).toBeGreaterThan(7.9);
  });
});
