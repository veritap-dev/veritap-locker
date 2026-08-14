/**
 * Spawns wrangler dev (real workerd, real local D1/R2) on a fresh state dir,
 * applies migrations, waits for health. Every `vitest run` starts clean.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { openSync, rmSync } from "node:fs";

const PORT = 8788;
const PAY_PORT = 8789;
const STATE = ".wrangler/test-state";
const PAY_STATE = ".wrangler/test-state-pay";
let proc: ChildProcess;
let payProc: ChildProcess;

export async function setup() {
  // An externally-supplied LOCKER_BASE (e.g. the deployed URL for the §12
  // exit-criteria run) wins: no local dev server, no override. Without this
  // guard the "production" respawn drill silently ran against localhost —
  // 122ms of round trips was the tell.
  if (process.env.LOCKER_BASE) return;
  try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  try { execSync(`lsof -ti:${PAY_PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  rmSync(STATE, { recursive: true, force: true });
  rmSync(PAY_STATE, { recursive: true, force: true });
  execSync(`npx wrangler d1 migrations apply veritap_locker --local --persist-to ${STATE}`, { stdio: "ignore" });
  execSync(`npx wrangler d1 migrations apply veritap_locker --local --persist-to ${PAY_STATE}`, { stdio: "ignore" });
  proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9331", "--persist-to", STATE, "--test-scheduled",
     "--var", "NONCE_HMAC_KEY:test-hmac-key-0123456789abcdef", "--var", `PUBLIC_BASE_URL:http://localhost:${PORT}`,
     "--var", "X402_ENABLED:false"],
    { stdio: ["ignore", openSync("/tmp/locker-dev-free.log", "w"), openSync("/tmp/locker-dev-free.log", "w")], detached: false },
  );
  // Second instance, OWN persist dir (two wranglers deadlock on shared state locks),
  // payments enabled,
  // facilitator pointed at a dead port so full payments fail closed — §12-D
  // tests 402 issuance and local sanity without touching a chain.
  payProc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PAY_PORT), "--inspector-port", "9332", "--persist-to", PAY_STATE,
     "--var", "NONCE_HMAC_KEY:test-hmac-key-0123456789abcdef", "--var", `PUBLIC_BASE_URL:http://localhost:${PAY_PORT}`,
     "--var", "X402_ENABLED:true", "--var", "X402_NETWORK:base-sepolia",
     "--var", "RECEIVING_ADDRESS:0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B",
     "--var", "FACILITATOR_URL:http://localhost:19999"],
    { stdio: ["ignore", openSync("/tmp/locker-dev-pay.log", "w"), openSync("/tmp/locker-dev-pay.log", "w")], detached: false },
  );
  // Two instances bundling the MCP deps concurrently can exceed 2 min cold.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/v1/health`);
      if (res.status === 200) {
        const pay = await fetch(`http://localhost:${PAY_PORT}/v1/health`).catch(() => null);
        if (pay?.status === 200) {
          process.env.LOCKER_BASE = `http://localhost:${PORT}`;
          process.env.LOCKER_PAY_BASE = `http://localhost:${PAY_PORT}`;
          return;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become healthy");
}

export async function teardown() {
  proc?.kill("SIGTERM");
  payProc?.kill("SIGTERM");
}
