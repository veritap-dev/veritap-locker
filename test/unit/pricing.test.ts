/**
 * #768.4 — the margin invariant as a property test: for ALL valid quotable
 * offers, price ≥ MIN_MARGIN × cost_floor. Runs in the suite (= CI), so any
 * pricing or cost-constant change that goes underwater fails the build
 * before it can deploy.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { LIMITS, PRICE, priceForMessage, RECEIPT_VAULT } from "../../src/codes.ts";
import { COST_RATES, costFloorMicrousd, MIN_MARGIN } from "../../src/cost.ts";

const marginHolds = (price: number, size: number, ttl: number, product: "message" | "receipt_vault") =>
  price * (1 - COST_RATES.facilitator_fee_pct) >= MIN_MARGIN * costFloorMicrousd(size, ttl, product);

describe("pricing margin invariant (#768)", () => {
  it("holds across the full (size × ttl × extensions) matrix", () => {
    // Tier boundaries ±1 plus interior points — the exact set #768 names.
    const sizes = [
      1, 1024, 32 * 1024 - 1, 32 * 1024, 32 * 1024 + 1,
      100 * 1024 - 1, 100 * 1024, 100 * 1024 + 1,
      1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1,
      10 * 1024 * 1024 - 1, 10 * 1024 * 1024,
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...sizes),
        fc.integer({ min: 1, max: LIMITS.ttl_max_days }),
        (size, ttl) => {
          const price = priceForMessage(size, ttl);
          return marginHolds(price, size, ttl, "message");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("compound worst case explicitly: max size × max TTL", () => {
    const size = 10 * 1024 * 1024;
    const ttl = LIMITS.ttl_max_days; // 365d = base + 4 extensions
    const price = priceForMessage(size, ttl);
    const floor = MIN_MARGIN * costFloorMicrousd(size, ttl, "message");
    expect(price).toBeGreaterThanOrEqual(floor);
    // And it's not close: log the actual multiple for the record.
    console.log(`worst case: price ${price}µ$, ${MIN_MARGIN}x-floor ${Math.ceil(floor)}µ$, actual margin ${(price / costFloorMicrousd(size, ttl, "message")).toFixed(0)}x`);
  });

  it("receipt-vault clears the floor at its own worst case (32KB × 365d)", () => {
    expect(
      marginHolds(RECEIPT_VAULT.price_microusd, RECEIPT_VAULT.max_bytes, RECEIPT_VAULT.ttl_days, "receipt_vault"),
    ).toBe(true);
  });

  it("storage price clears MIN_MARGIN × R2 cost (#768.3)", () => {
    const costPerGbMonth = (COST_RATES.r2_storage_gb_month_usd + 2 * (COST_RATES.r2_class_a_per_million_usd / 1e6)) * 1e6;
    expect(PRICE.storage_gb_month_microusd).toBeGreaterThanOrEqual(MIN_MARGIN * costPerGbMonth);
  });

  it("a hypothetical facilitator fee up to 20% still clears (spec §6 buffer)", () => {
    const size = 10 * 1024 * 1024;
    const ttl = 365;
    const price = priceForMessage(size, ttl) * (1 - 0.2);
    expect(price).toBeGreaterThanOrEqual(MIN_MARGIN * costFloorMicrousd(size, ttl, "message"));
  });

  it("guardQuote CLAMPS UP a below-floor quote, never returns underwater (#768 behavioral)", async () => {
    const { guardQuote } = await import("../../src/cost.ts");
    const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => null }) }) } } as unknown as import("../../src/types.ts").Env;
    const floor = MIN_MARGIN * costFloorMicrousd(1000, 30, "message");
    const res = await guardQuote(env, Math.floor(floor / 2), 1000, 30, "message", "t");
    expect(res.clamped).toBe(true);
    expect(res.priceMicrousd).toBeGreaterThanOrEqual(floor);
    const ok = await guardQuote(env, floor * 10, 1000, 30, "message", "t");
    expect(ok.clamped).toBe(false);
  });
});
