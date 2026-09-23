import { describe, expect, it } from "vitest";
import {
  calculatePriceFormation, calculateSalePricing, calculateUnitPackSalePricing,
  calculateWeightPackSalePricing, isDiscountEligiblePaymentMethod
} from "./pricing";

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
    expect(calculateSalePricing({ ...base, paymentMethod: "TRANSFER" }).finalPriceCents).toBe(1_300_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "DEBIT" }).finalPriceCents).toBe(1_444_444n);
    expect(calculateSalePricing({ ...base, paymentMethod: "CREDIT" }).finalPriceCents).toBe(1_444_444n);
    expect(calculateSalePricing({ ...base, paymentMethod: "CASH" }).finalPriceCents).toBe(1_300_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "OTHER" }).finalPriceCents).toBe(1_300_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "DEBIT" }).finalPriceCents).toBe(1_444_444n);
  });

  it("defines payment discount eligibility from the real payment methods", () => {
    expect(["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"].map((method) =>
      isDiscountEligiblePaymentMethod(method as "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER")))
      .toEqual([true, true, false, false, true]);
  });

  it("uses the same calculation for UNIT products", () => {
    expect(calculateSalePricing({ listPriceCents: 14_444n, quantity: 2, quantityDivisor: 1, paymentMethod: "CASH", cashDiscountBps: 1_000n }).subtotalCents).toBe(26_000n);
  });
});

describe("promotion pack (PACK_FIXED_TOTAL)", () => {
  it("charges the WEIGHT pack's fixed total regardless of the real weighed grams", () => {
    // "Vacío: 2kg por $18.000" sold as a real 2.050kg piece — not the nominal weight.
    const result = calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "CASH", cashDiscountBps: 1_000n, packPriceCents: 18_000n
    });
    expect(result.subtotalCents).toBe(18_000n);
    expect(result.listSubtotalCents).toBe(20_500n);
    expect(result.cashSubtotalCents).toBe(18_450n);
    expect(result.promotionDiscountCents).toBe(450n);
    expect(result.discountCents).toBe(2_500n);
  });

  it("never scales a WEIGHT pack with weight — a lighter or heavier piece still pays the same total", () => {
    const light = calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 1_950, paymentMethod: "CASH", cashDiscountBps: 0n, packPriceCents: 18_000n
    });
    const heavy = calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 2_150, paymentMethod: "CASH", cashDiscountBps: 0n, packPriceCents: 18_000n
    });
    expect(light.subtotalCents).toBe(18_000n);
    expect(heavy.subtotalCents).toBe(18_000n);
  });

  it("clamps promotionDiscountCents to zero when a real piece is underweight enough that the pack costs more than the cash price for that weight, but stays within the list-price guard", () => {
    const result = calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 1_900, paymentMethod: "CASH", cashDiscountBps: 1_000n, packPriceCents: 18_000n
    });
    expect(result.listSubtotalCents).toBe(19_000n);
    expect(result.cashSubtotalCents).toBe(17_100n);
    expect(result.subtotalCents).toBe(18_000n);
    // Known, deliberate edge case (documented in the migration/plan): discountCents
    // (list - subtotal) can exceed cashDiscountCents + promotionDiscountCents here,
    // because promotionDiscountCents is clamped to >= 0 instead of going negative.
    expect(result.promotionDiscountCents).toBe(0n);
    expect(result.discountCents).toBe(1_000n);
  });

  it("rejects a WEIGHT pack whose fixed total exceeds list price for the weighed amount", () => {
    expect(() => calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 100, paymentMethod: "CASH", cashDiscountBps: 0n, packPriceCents: 18_000n
    })).toThrow(RangeError);
  });

  it("applies a UNIT pack on exact multiples, charging the remainder at the normal price", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 27_000n };
    const exactMultiple = calculateUnitPackSalePricing({
      listPriceCents: 700n, quantityUnits: 80, paymentMethod: "CASH", cashDiscountBps: 0n, pack
    });
    expect(exactMultiple.subtotalCents).toBe(54_000n); // 2 packs, no remainder
    expect(exactMultiple.promotionDiscountCents).toBe(2_000n);

    const withRemainder = calculateUnitPackSalePricing({
      listPriceCents: 700n, quantityUnits: 45, paymentMethod: "CASH", cashDiscountBps: 0n, pack
    });
    expect(withRemainder.subtotalCents).toBe(30_500n); // 1 pack (27.000) + 5 units at 700 each
    expect(withRemainder.discountCents).toBe(1_000n);
  });

  it("does not invent a discount for a UNIT quantity below the pack size", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 27_000n };
    const result = calculateUnitPackSalePricing({
      listPriceCents: 700n, quantityUnits: 35, paymentMethod: "CASH", cashDiscountBps: 0n, pack
    });
    expect(result.subtotalCents).toBe(result.cashSubtotalCents);
    expect(result.promotionDiscountCents).toBe(0n);
  });

  it("rejects a misconfigured UNIT pack priced above list for its own quantity", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 30_000n };
    expect(() => calculateUnitPackSalePricing({
      listPriceCents: 700n, quantityUnits: 40, paymentMethod: "CASH", cashDiscountBps: 0n, pack
    })).toThrow(RangeError);
  });
});
