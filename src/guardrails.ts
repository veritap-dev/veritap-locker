/**
 * #773 A1/C1 — the two operator guardrails between "small service" and
 * "five-figure surprise":
 *
 * SPEND BREAKER: stored bytes cannot outrun revenue (every byte is paid before
 * it is written), so the only unbounded cost surface is free traffic. We count
 * every /v1 request in a per-UTC-day counter and, once the projected day cost
 * crosses DAILY_COST_BUDGET_USD, the free informational endpoints 429 until
 * midnight UTC. Paid endpoints and owner reads stay up — they carry their own
 * revenue. /v1/nonce also stays up (owner reads depend on it) — it is bounded
 * by its own per-address+IP cap, and blob GETs by single-use redemption.
 *
 * WRITES_OFF: the wind-down mode the sunset commitment promises — all
 * custody-creating routes 503, everything needed to DRAIN (nonce, read, ack,
 * count, directory, checkpoint get/list/delete, blob GET) stays served.
 */

import { bumpCounter } from "./auth.ts";
import { LIMITS } from "./codes.ts";
import type { Env } from "./types.ts";
import { nowS } from "./types.ts";

/** Routes that create new custody or take money — blocked in WRITES_OFF. */
export function isWriteRoute(method: string, path: string): boolean {
  if (method === "PUT") return /^\/v1\/(mb\/[^/]+\/locker\/[^/]+|upload\/)/.test(path);
  if (method === "POST")
    return /^\/v1\/mb\/[^/]+\/(messages|credit)$/.test(path);
  return false;
}

/** Free informational routes the breaker sheds first. */
export function isSheddableRoute(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return (
    path === "/v1/status" ||
    /^\/v1\/directory\//.test(path) ||
    /^\/v1\/mb\/[^/]+\/(count|status)$/.test(path)
  );
}

/** Free GETs under the coarse per-IP cap (#773-A4/M6): the sheddable set plus
 * nonce — per-(address,IP) caps alone are bypassable by rotating addresses. */
export function isFreeGetRoute(method: string, path: string): boolean {
  return isSheddableRoute(method, path) || (method === "GET" && path.startsWith("/v1/nonce"));
}

export const budgetMicrousd = (env: Env) =>
  Math.max(1, Number(env.DAILY_COST_BUDGET_USD ?? "50")) * 1_000_000;

export const projectedCostMicrousd = (requestsToday: number) =>
  requestsToday * LIMITS.breaker_est_req_cost_microusd;

/**
 * Count this request and report whether the breaker is tripped. One D1 write
 * per request — itself part of the modeled cost. Returns the count so the
 * exact crossing request can file the ticket (once, race-tolerantly).
 */
export async function breakerCheck(env: Env): Promise<{ tripped: boolean; crossedNow: boolean }> {
  const t = nowS();
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const n = await bumpCounter(env, `spendday:${day}`, t);
  const tripped = projectedCostMicrousd(n) > budgetMicrousd(env);
  const crossedNow = tripped && projectedCostMicrousd(n - 1) <= budgetMicrousd(env);
  return { tripped, crossedNow };
}

export const secondsToUtcMidnight = () => 86_400 - (nowS() % 86_400);
