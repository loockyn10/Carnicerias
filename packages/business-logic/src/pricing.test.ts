import { describe, expect, it } from "vitest";
import { calculatePriceFormation, calculateSalePricing } from "./pricing";

describe("price formation", () => {
  it("inverts a 10% cash discount after a 30% markup", () => {
    expect(calculatePriceFormation(1_000_000n, 3_000n, 1_000n)).toEqual({
      targetCashPriceCents: 1_300_000n,
      listPriceCents: 1_444_444n,
      effectiveCashPriceCents: 1_300_000n
    });
  });

  it("recalculates deterministically when cost changes", () => {
    expect(calculatePriceFormation(1_100_000n, 3_000n, 1_000n).listPriceCents).toBe(1_588_889n);
  });

  it("recalculates cash, card and a sequential percentage promotion exactly", () => {
    const promotion = { id: "five", discountType: "PERCENTAGE" as const, discountValue: 500n };
    const cash = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CASH", cashDiscountBps: 1_000n, promotion });
    expect(cash.cashPriceCents).toBe(1_300_000n);
    expect(cash.finalPriceCents).toBe(1_235_000n);
    expect(cash.subtotalCents).toBe(1_235_000n);
    const card = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CREDIT", cashDiscountBps: 1_000n, promotion });
    expect(card.cashDiscountCents).toBe(0n);
    expect(card.finalPriceCents).toBe(1_372_222n);
  });

  it("has no residual cash discount after changing payment method", () => {
    const base = { listPriceCents: 1_444_444n, quantity: 1, quantityDivisor: 1 as const, cashDiscountBps: 1_000n };
    expect(calculateSalePricing({ ...base, paymentMethod: "CASH" }).finalPriceCents).toBe(1_300_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "DEBIT" }).finalPriceCents).toBe(1_444_444n);
  });

  it("uses the same calculation for UNIT products", () => {
    expect(calculateSalePricing({ listPriceCents: 14_444n, quantity: 2, quantityDivisor: 1, paymentMethod: "CASH", cashDiscountBps: 1_000n }).subtotalCents).toBe(26_000n);
  });
});
