import { describe, expect, it } from "vitest";
import {
  calculatePriceFormation, calculateSalePricing, calculateUnitPackSalePricing,
  calculateWeightPackSalePricing, isCardSurchargePaymentMethod
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
});

// D-044: the list price (product_prices.price_cents) is now the CASH/TRANSFER price directly —
// no adjustment at all. DEBIT/CREDIT ("Tarjeta") add a card surcharge on top of it. This is the
// inverse of the pre-D-044 model (CASH/TRANSFER got a discount off a higher list price).
describe("calculateSalePricing — payment method (D-044)", () => {
  const base = { listPriceCents: 1_000_000n, quantity: 1, quantityDivisor: 1 as const, cashDiscountBps: 1_000n };

  it("base $10.000 + 10%: CASH/TRANSFER pay list price unchanged, DEBIT/CREDIT pay list price + 10%", () => {
    expect(calculateSalePricing({ ...base, paymentMethod: "CASH" }).finalPriceCents).toBe(1_000_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "TRANSFER" }).finalPriceCents).toBe(1_000_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "DEBIT" }).finalPriceCents).toBe(1_100_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "CREDIT" }).finalPriceCents).toBe(1_100_000n);
  });

  it("OTHER pays list price unchanged (no explicit rule classifies it as a card surcharge)", () => {
    expect(calculateSalePricing({ ...base, paymentMethod: "OTHER" }).finalPriceCents).toBe(1_000_000n);
  });

  it("0% configured surcharge: every payment method pays exactly the list price", () => {
    const zero = { ...base, cashDiscountBps: 0n };
    for (const paymentMethod of ["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"] as const) {
      expect(calculateSalePricing({ ...zero, paymentMethod }).finalPriceCents).toBe(1_000_000n);
    }
  });

  it("CASH/TRANSFER/OTHER never carry a card surcharge or a cash discount — both are always 0", () => {
    for (const paymentMethod of ["CASH", "TRANSFER", "OTHER"] as const) {
      const pricing = calculateSalePricing({ ...base, paymentMethod });
      expect(pricing.cardSurchargeCents).toBe(0n);
      expect(pricing.cashDiscountCents).toBe(0n);
      expect(pricing.discountCents).toBe(0n);
    }
  });

  it("DEBIT/CREDIT report the surcharge amount via cardSurchargeCents, never as a cashDiscountCents", () => {
    const pricing = calculateSalePricing({ ...base, paymentMethod: "DEBIT" });
    expect(pricing.cardSurchargeCents).toBe(100_000n);
    expect(pricing.cashDiscountCents).toBe(0n);
  });

  it("switching Efectivo -> Tarjeta and back recalculates from the same immutable list price (no residual adjustment)", () => {
    expect(calculateSalePricing({ ...base, paymentMethod: "CASH" }).finalPriceCents).toBe(1_000_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "DEBIT" }).finalPriceCents).toBe(1_100_000n);
    expect(calculateSalePricing({ ...base, paymentMethod: "CASH" }).finalPriceCents).toBe(1_000_000n);
  });

  it("rounds a non-exactly-divisible surcharge half up, same centralized rounding as everywhere else", () => {
    // 14.444,44 base, 10% surcharge -> 15.888,884 -> rounds to 15.888,88 (round half up on cents)
    const pricing = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1, quantityDivisor: 1, paymentMethod: "DEBIT", cashDiscountBps: 1_000n });
    expect(pricing.finalPriceCents).toBe(1_588_888n);
  });

  it("applies a sequential percentage promotion after the card surcharge, not before", () => {
    const promotion = { id: "five", discountType: "PERCENTAGE" as const, discountValue: 500n };
    const cash = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CASH", cashDiscountBps: 1_000n, promotion });
    expect(cash.cashPriceCents).toBe(1_444_444n);
    expect(cash.finalPriceCents).toBe(1_372_222n);
    const card = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CREDIT", cashDiscountBps: 1_000n, promotion });
    expect(card.cashPriceCents).toBe(1_588_888n);
    expect(card.finalPriceCents).toBe(1_509_444n); // 5% off the post-surcharge price, not off list
  });

  it("defines which payment methods receive a card surcharge from the real payment methods", () => {
    expect(["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"].map((method) =>
      isCardSurchargePaymentMethod(method as "CASH" | "TRANSFER" | "DEBIT" | "CREDIT" | "OTHER")))
      .toEqual([false, false, true, true, false]);
  });

  it("uses the same calculation for UNIT products (WEIGHT and UNIT share one pricing engine)", () => {
    const cash = calculateSalePricing({ listPriceCents: 800n, quantity: 5, quantityDivisor: 1, paymentMethod: "CASH", cashDiscountBps: 1_000n });
    expect(cash.subtotalCents).toBe(4_000n);
    const card = calculateSalePricing({ listPriceCents: 800n, quantity: 5, quantityDivisor: 1, paymentMethod: "DEBIT", cashDiscountBps: 1_000n });
    expect(card.subtotalCents).toBe(4_400n);
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
    expect(result.promotionDiscountCents).toBe(2_500n);
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

  // D-044's deliberately-conservative resolution of the "how does card surcharge interact with
  // PACK_FIXED_TOTAL" ambiguity: the pack's fixed total is also payment-method-invariant, exactly
  // like it's already weight-invariant. A card payment never adds a surcharge on top of a pack.
  it("charges the exact same pack total for CASH, DEBIT and CREDIT — a pack never carries a card surcharge", () => {
    const cash = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "CASH", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    const debit = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    const credit = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "CREDIT", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    expect(debit.subtotalCents).toBe(cash.subtotalCents);
    expect(credit.subtotalCents).toBe(cash.subtotalCents);
    expect(debit.cardSurchargeCents).toBe(0n);
    expect(credit.cardSurchargeCents).toBe(0n);
  });

  it("still computes a correct (small but positive) discount for a real piece near the edge of the list-price guard", () => {
    // Since the pack is now compared only against listSubtotalCents (never a cash/card price —
    // see D-044), promotionDiscountCents can no longer go negative/need clamping the way the
    // pre-D-044 cash-discounted comparison could: the pack_price > list_subtotal guard above
    // already guarantees listSubtotalCents >= subtotalCents whenever this function doesn't throw.
    const result = calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 1_900, paymentMethod: "CASH", cashDiscountBps: 1_000n, packPriceCents: 18_000n
    });
    expect(result.listSubtotalCents).toBe(19_000n);
    expect(result.subtotalCents).toBe(18_000n);
    expect(result.promotionDiscountCents).toBe(1_000n);
    expect(result.discountCents).toBe(1_000n);
  });

  it("rejects a WEIGHT pack whose fixed total exceeds list price for the weighed amount", () => {
    expect(() => calculateWeightPackSalePricing({
      listPriceCents: 10_000n, weightGrams: 100, paymentMethod: "CASH", cashDiscountBps: 0n, packPriceCents: 18_000n
    })).toThrow(RangeError);
  });

  it("applies a UNIT pack on exact multiples, charging the remainder at the normal (cash) price", () => {
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

  it("charges the same pack total regardless of payment method, but the remainder DOES carry a card surcharge (40 hamburguesas = 1 pack $28.000; 45 = pack + 5 normal)", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 28_000n };
    const cash = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 45, paymentMethod: "CASH", cashDiscountBps: 1_000n, pack });
    expect(cash.subtotalCents).toBe(32_000n); // 28.000 + 5*800, no surcharge for cash
    expect(cash.cardSurchargeCents).toBe(0n);

    const debit = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 45, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, pack });
    expect(debit.subtotalCents).toBe(32_400n); // 28.000 (pack, unchanged) + 5*880 (remainder + 10%)
    expect(debit.cardSurchargeCents).toBe(400n);

    const debitFullPack = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 40, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, pack });
    expect(debitFullPack.subtotalCents).toBe(28_000n); // exact multiple: 100% pack, 0 remainder, no surcharge at all
    expect(debitFullPack.cardSurchargeCents).toBe(0n);
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
