/** #773 guardrails: route classification, breaker math, tripwire threshold. */

import { describe, expect, it } from "vitest";

import { budgetMicrousd, isSheddableRoute, isWriteRoute, projectedCostMicrousd } from "../../src/guardrails.ts";
import { tripwireExceeded } from "../../src/cron.ts";
import type { Env } from "../../src/types.ts";

describe("WRITES_OFF route classification (#773-C1)", () => {
  const A = "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B";
  it("blocks every custody-creating route", () => {
    expect(isWriteRoute("POST", `/v1/mb/${A}/messages`)).toBe(true);
    expect(isWriteRoute("PUT", `/v1/mb/${A}/locker/state`)).toBe(true);
    expect(isWriteRoute("POST", `/v1/mb/${A}/credit`)).toBe(true);
    expect(isWriteRoute("PUT", `/v1/upload/msg/${A}/lm_x`)).toBe(true);
  });
  it("keeps every draining route open", () => {
    expect(isWriteRoute("GET", "/v1/nonce")).toBe(false);
    expect(isWriteRoute("POST", `/v1/mb/${A}/read`)).toBe(false);
    expect(isWriteRoute("POST", `/v1/mb/${A}/ack`)).toBe(false);
    expect(isWriteRoute("GET", `/v1/mb/${A}/count`)).toBe(false);
    expect(isWriteRoute("GET", `/v1/directory/${A}`)).toBe(false);
    expect(isWriteRoute("POST", `/v1/mb/${A}/locker/state/get`)).toBe(false);
    expect(isWriteRoute("POST", `/v1/mb/${A}/locker/list`)).toBe(false);
    expect(isWriteRoute("POST", `/v1/mb/${A}/locker/state/delete`)).toBe(false);
    expect(isWriteRoute("GET", "/v1/blob/msg/x/y")).toBe(false);
  });
});

describe("spend breaker (#773-A1)", () => {
  const env = (b?: string) => ({ DAILY_COST_BUDGET_USD: b }) as unknown as Env;
  it("defaults to $50 and honors the env override", () => {
    expect(budgetMicrousd(env())).toBe(50_000_000);
    expect(budgetMicrousd(env("10"))).toBe(10_000_000);
  });
  it("projection crosses the default budget in the tens of millions of requests, not thousands", () => {
    expect(projectedCostMicrousd(1_000_000)).toBeLessThan(budgetMicrousd(env()));
    expect(projectedCostMicrousd(20_000_000)).toBeGreaterThan(budgetMicrousd(env()));
  });
  it("sheds only free informational routes", () => {
    const A = "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B";
    expect(isSheddableRoute("GET", "/v1/status")).toBe(true);
    expect(isSheddableRoute("GET", `/v1/mb/${A}/count`)).toBe(true);
    expect(isSheddableRoute("GET", `/v1/directory/${A}`)).toBe(true);
    // Revenue-carrying and owner-read paths are never shed.
    expect(isSheddableRoute("POST", `/v1/mb/${A}/messages`)).toBe(false);
    expect(isSheddableRoute("POST", `/v1/mb/${A}/read`)).toBe(false);
    expect(isSheddableRoute("GET", "/v1/nonce")).toBe(false);
    expect(isSheddableRoute("GET", "/v1/blob/msg/x/y")).toBe(false);
  });
});

describe("mass-delete tripwire (#773-B4)", () => {
  it("small-corpus natural churn never trips (absolute floor)", () => {
    expect(tripwireExceeded(10, 10)).toBe(false);
    expect(tripwireExceeded(50, 60)).toBe(false);
  });
  it("a large slice of live data trips", () => {
    expect(tripwireExceeded(51, 100)).toBe(true);
    expect(tripwireExceeded(600, 10_000)).toBe(true);
  });
  it("a big sweep over a big corpus that is under 5% passes", () => {
    expect(tripwireExceeded(400, 10_000)).toBe(false);
  });
});
