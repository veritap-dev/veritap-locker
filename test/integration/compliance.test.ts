/** #804 compliance surfaces live on the dev worker: abuse intake + legal pages. */

import { describe, expect, it } from "vitest";

const BASE = () => process.env.LOCKER_BASE ?? "http://localhost:8788";

describe("abuse intake (#804)", () => {
  it("POST /abuse files a report and returns a reference", async () => {
    const res = await fetch(`${BASE()}/abuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "lm_testreport", reason: "test abuse report", contact: "" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; reference: string };
    expect(body.status).toBe("ABUSE_RECEIVED");
    expect(body.reference).toMatch(/^AB-\d+$/);
  });

  it("rejects a report missing required fields", async () => {
    const res = await fetch(`${BASE()}/abuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "", reason: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("legal pages render (#804)", () => {
  it("/abuse, /privacy, /terms are served as HTML", async () => {
    for (const p of ["/abuse", "/privacy", "/terms"]) {
      const res = await fetch(`${BASE()}${p}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<!doctype html>");
    }
  });

  it("privacy states the E2E-unreadable guarantee and CSAM/plaintext boundary", async () => {
    const text = await (await fetch(`${BASE()}/privacy`)).text();
    expect(text).toContain("cannot read");
    expect(text.toLowerCase()).toContain("ncmec");
    expect(text).toContain("require_e2e");
  });
});

describe("sanctions screening does not break the free flow (#804)", () => {
  it("nonce issuance still works on the testnet instance (screening is a no-op)", async () => {
    const addr = "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B";
    const res = await fetch(`${BASE()}/v1/nonce?address=${addr}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { nonce: string }).nonce).toContain("veritap-locker:auth:");
  });
});
