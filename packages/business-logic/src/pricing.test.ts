import { describe, expect, it } from "vitest";
import {
  calculateListPriceFromMargin, calculatePriceFormation, calculateSalePricing, calculateUnitPackSalePricing,
  calculateWeightPackSalePricing, isCardSurchargePaymentMethod, roundCommercialPriceToNearest50
} from "./pricing";
import { calculateBranchPromotionLinePricing, calculateUnitPackLinePricing } from "./unit-discounts";

// D-068: margin over the SALE price (gross-up), not a markup over cost.
describe("list price from margin", () => {
  it.each([
    [1_000_000n, 3_000n, 1_430_000n], // $10.000 at 30 % -> gross-up $14.285,71 -> $14.300 (NOT $13.000)
    [400_000n, 3_000n, 570_000n], // $4.000 at 30 % -> $5.714,29 -> $5.700
    [1_000_000n, 5_000n, 2_000_000n], // $10.000 at 50 % -> exactly $20.000
    [1_000_000n, 3_500n, 1_540_000n], // $10.000 at 35 % -> $15.384,62 -> $15.400
    [350_000n, 3_000n, 500_000n], // $3.500 at 30 % -> $5.000
    [148_000n, 4_000n, 245_000n], // $1.480 at 40 % -> $2.466,67 -> $2.450 (the Admin preview shows this, not $2.466,67)
    [1n, 5_000n, 5_000n], // floor: a tiny cost never forms a $0 price
    [10_000n, 1n, 10_000n] // $100,01 -> $100
  ])("cost %s at margin %s bps -> %s", (cost, margin, price) => {
    expect(calculateListPriceFromMargin(cost, margin)).toBe(price);
  });

  it("is not a markup: $10.000 at 30 % is not $13.000", () => {
    expect(calculateListPriceFromMargin(1_000_000n, 3_000n)).not.toBe(1_300_000n);
  });

  it("the realised margin over the sale price is the configured one (within the $50 rounding)", () => {
    const price = calculateListPriceFromMargin(1_000_000n, 3_000n);
    expect(Number(price - 1_000_000n) / Number(price)).toBeCloseTo(0.3, 2);
  });

  it("is the existing gross-up with a 0 markup plus the commercial rounding (no parallel formula)", () => {
    expect(calculateListPriceFromMargin(1_234_567n, 2_750n)).toBe(roundCommercialPriceToNearest50(calculatePriceFormation(1_234_567n, 0n, 2_750n).listPriceCents));
    // The generic gross-up itself is NOT rounded; only the automatic margin price is.
    expect(calculatePriceFormation(1_000_000n, 0n, 3_000n).listPriceCents).toBe(1_428_571n);
  });

  it("the automatic price is always a multiple of $50", () => {
    for (const cost of [123n, 4_990n, 99_999n, 1_234_567n, 987_654_321n]) for (const margin of [1n, 1_500n, 3_333n, 5_000n, 9_999n]) {
      expect(calculateListPriceFromMargin(cost, margin) % 5_000n).toBe(0n);
    }
  });

  it("rejects a 100 % / 0 % margin and a missing cost", () => {
    expect(() => calculateListPriceFromMargin(1_000_000n, 10_000n)).toThrow(RangeError);
    expect(() => calculateListPriceFromMargin(1_000_000n, 0n)).toThrow(RangeError);
    expect(() => calculateListPriceFromMargin(0n, 3_000n)).toThrow(RangeError);
  });
});

// D-068: the 3u and pack percentages are global; the formulas themselves did not change.
describe("global unit discounts (worked examples)", () => {
  it("\"llevando 3u\" at 15 %: $5.400 stays for 1-2 units and is $4.590 each from 3 (every unit, FROM_MINIMUM)", () => {
    const promotion = { id: "global", minimumUnits: 3, discountBps: 1_500 };
    const price = (quantityUnits: number) => calculateBranchPromotionLinePricing({ listPriceCents: 540_000n, quantityUnits, promotion, paymentMethod: "CASH", cashDiscountBps: 0n });
    expect(price(1)).toBeNull();
    expect(price(2)).toBeNull();
    expect(price(3)?.finalPriceCents).toBe(459_000n);
    expect(price(3)?.subtotalCents).toBe(1_377_000n);
    expect(price(5)?.subtotalCents).toBe(2_295_000n); // all 5 units, not just the group of 3
  });

  it("pack of 6 at the global 20 %: $2.000 each -> $12.000 -> $9.600 -> $1.600 per unit", () => {
    const pricing = calculateUnitPackLinePricing({
      listPriceCents: 200_000n, pack: { packCount: 1, packSizeUnits: 6, packDiscountBps: 2_000 }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    expect(pricing.listSubtotalCents).toBe(1_200_000n);
    expect(pricing.subtotalCents).toBe(960_000n);
    expect(pricing.finalPriceCents).toBe(160_000n);
  });

  it("a pack and the 3u promotion never stack: the pack wins with its own percentage over all its units", () => {
    const pack = calculateUnitPackLinePricing({
      listPriceCents: 100_000n, pack: { packCount: 1, packSizeUnits: 8, packDiscountBps: 2_500 }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    const loose = calculateBranchPromotionLinePricing({
      listPriceCents: 100_000n, quantityUnits: 8, promotion: { id: "global", minimumUnits: 3, discountBps: 1_500 }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    expect(pack.subtotalCents).toBe(600_000n);
    expect(loose?.subtotalCents).toBe(680_000n);
  });
});

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

// D-044 (corrected): the list price (product_prices.price_cents) is the CASH/TRANSFER/OTHER
// price directly — a promotion is evaluated against it with no exception. DEBIT/CREDIT
// ("Tarjeta") then add a card surcharge to that WHOLE commercial result (list, or list-after-
// promotion, or a pack's fixed total) — never only to part of it, and never before the promotion.
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

  // The required THRESHOLD example: promo = $9.000/kg. CASH/TRANSFER pay exactly that; DEBIT/
  // CREDIT pay that PLUS the surcharge (the promo is evaluated against list first, then the
  // surcharge applies to the promo's result — never the other way around).
  it("THRESHOLD promo $9.000/kg: CASH/TRANSFER pay $9.000/kg, DEBIT/CREDIT pay $9.900/kg", () => {
    const promotion = { id: "fixed", discountType: "FIXED_PRICE_PER_KG" as const, discountValue: 900_000n };
    const cash = calculateSalePricing({ listPriceCents: 1_000_000n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CASH", cashDiscountBps: 1_000n, promotion });
    expect(cash.finalPriceCents).toBe(900_000n);
    const debit = calculateSalePricing({ listPriceCents: 1_000_000n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, promotion });
    expect(debit.finalPriceCents).toBe(990_000n);
  });

  it("applies a sequential percentage promotion BEFORE the card surcharge (list -> promotion -> surcharge)", () => {
    const promotion = { id: "five", discountType: "PERCENTAGE" as const, discountValue: 500n };
    const cash = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CASH", cashDiscountBps: 1_000n, promotion });
    expect(cash.cashPriceCents).toBe(1_372_222n); // 5% off list — the CASH-equivalent result
    expect(cash.finalPriceCents).toBe(1_372_222n);
    const card = calculateSalePricing({ listPriceCents: 1_444_444n, quantity: 1_000, quantityDivisor: 1_000, paymentMethod: "CREDIT", cashDiscountBps: 1_000n, promotion });
    expect(card.cashPriceCents).toBe(1_372_222n); // the promo baseline is identical regardless of payment method
    expect(card.finalPriceCents).toBe(1_509_444n); // then +10% surcharge on the promo's result, not on list
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

describe("promotion pack (PACK_FIXED_TOTAL) — D-044 corrected: no exception to the card surcharge", () => {
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

  // D-044 correction (2026-09-24): the user confirmed there is NO exception for packs — every
  // card payment carries the surcharge on the full commercial result, packs included. The
  // required example: "2 kg por $18.000" -> DEBIT/CREDIT = $19.800 (18.000 * 1,10), not $18.000.
  it("surcharges the pack's WHOLE fixed total for DEBIT/CREDIT — no pack exception (the required $18.000 -> $19.800 example)", () => {
    const cash = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "CASH", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    expect(cash.subtotalCents).toBe(18_000n);
    expect(cash.cardSurchargeCents).toBe(0n);
    const debit = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    expect(debit.subtotalCents).toBe(19_800n);
    expect(debit.cardSurchargeCents).toBe(1_800n);
    const credit = calculateWeightPackSalePricing({ listPriceCents: 10_000n, weightGrams: 2_050, paymentMethod: "CREDIT", cashDiscountBps: 1_000n, packPriceCents: 18_000n });
    expect(credit.subtotalCents).toBe(19_800n);
  });

  it("still computes a correct (small but positive) discount for a real piece near the edge of the list-price guard", () => {
    // Since the pack is compared only against listSubtotalCents (never a payment-method-adjusted
    // one), promotionDiscountCents can no longer go negative/need clamping the way the pre-D-044
    // comparison could: the pack_price > list_subtotal guard above already guarantees
    // listSubtotalCents >= cashSubtotalCents whenever this function doesn't throw.
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

  // D-044 correction: the required examples. "40 unidades por $28.000" -> DEBIT = $30.800
  // (28.000 * 1,10). 45 units (1 pack + 5 loose, $32.000 CASH-equivalent) -> DEBIT = $35.200
  // (32.000 * 1,10) — the surcharge applies to the WHOLE total, never only to the remainder.
  it("surcharges the UNIT pack's whole total for DEBIT/CREDIT, including an exact multiple with no remainder", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 28_000n };
    const cash = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 40, paymentMethod: "CASH", cashDiscountBps: 1_000n, pack });
    expect(cash.subtotalCents).toBe(28_000n);
    const debit = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 40, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, pack });
    expect(debit.subtotalCents).toBe(30_800n);
    expect(debit.cardSurchargeCents).toBe(2_800n);
  });

  it("surcharges the WHOLE total of a pack + remainder sale, not just the remainder (the required 45-hamburguesas example)", () => {
    const pack = { id: "pack-40", packQuantityUnits: 40, packPriceCents: 28_000n };
    const cash = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 45, paymentMethod: "CASH", cashDiscountBps: 1_000n, pack });
    expect(cash.subtotalCents).toBe(32_000n); // 28.000 (pack) + 5*800 (remainder) = the CASH-equivalent total
    expect(cash.cardSurchargeCents).toBe(0n);

    const debit = calculateUnitPackSalePricing({ listPriceCents: 800n, quantityUnits: 45, paymentMethod: "DEBIT", cashDiscountBps: 1_000n, pack });
    expect(debit.subtotalCents).toBe(35_200n); // 32.000 * 1,10 — the WHOLE total, not 28.000 + 5*880
    expect(debit.cardSurchargeCents).toBe(3_200n);
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

// D-071: commercial rounding of the automatic list price to the nearest $50 (5.000 cents), half-up, integers only.
describe("roundCommercialPriceToNearest50", () => {
  it.each([
    [246_644n, 245_000n], // 2.466,44 -> 2.450
    [242_400n, 240_000n], // 2.424 -> 2.400
    [247_499n, 245_000n], // 2.474,99 -> 2.450
    [247_500n, 250_000n], // 2.475 (midpoint) -> 2.500
    [247_600n, 250_000n], // 2.476 -> 2.500
    [571_429n, 570_000n], // 5.714,29 -> 5.700
    [572_600n, 575_000n], // 5.726 -> 5.750
    [1_428_571n, 1_430_000n], // 14.285,71 -> 14.300
    [250_000n, 250_000n], // already a multiple
    [0n, 0n]
  ])("%s cents -> %s", (input, expected) => {
    expect(roundCommercialPriceToNearest50(input)).toBe(expected);
  });

  it("works on integers far beyond Number precision", () => {
    expect(roundCommercialPriceToNearest50(9_007_199_254_740_993_000n + 2_500n)).toBe(9_007_199_254_740_995_000n);
  });

  it("promotions, packs and the card surcharge keep their formulas, computed from the already-rounded list price", () => {
    const list = calculateListPriceFromMargin(148_000n, 4_000n);
    expect(list).toBe(245_000n);
    const promo = calculateBranchPromotionLinePricing({ listPriceCents: list, quantityUnits: 3, promotion: { id: "p", minimumUnits: 3, discountBps: 1_500 }, paymentMethod: "CASH", cashDiscountBps: 0n });
    expect(promo?.cashSubtotalCents).toBe(624_750n); // 3 x 2.450 x 0,85, NOT re-rounded to $50
  });
});
