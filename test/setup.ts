/**
 * Spawns wrangler dev (real workerd, real local D1/R2) on a fresh state dir,
 * applies migrations, waits for health. Every `vitest run` starts clean.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 8788;
const STATE = ".wrangler/test-state";
let proc: ChildProcess;

export async function setup() {
  try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  rmSync(STATE, { recursive: true, force: true });
  execSync(`npx wrangler d1 migrations apply veritap_locker --local --persist-to ${STATE}`, { stdio: "ignore" });
  proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--test-scheduled", "--var", "NONCE_HMAC_KEY:test-hmac-key", "--var", `PUBLIC_BASE_URL:http://localhost:${PORT}`],
    { stdio: "ignore", detached: false },
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/v1/health`);
      if (res.status === 200) {
        process.env.LOCKER_BASE = `http://localhost:${PORT}`;
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become healthy");
}

export async function teardown() {
  proc?.kill("SIGTERM");
}
