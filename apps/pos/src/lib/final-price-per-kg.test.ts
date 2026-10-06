import { describe, expect, it } from "vitest";

import { applyManualPrice, buildUnitTicketLine, buildWeightTicketLine, finalPricePerKgCents, type DiscountRule } from "./ticket-pricing";

// Dinero en centavos: $11.000/kg = 1_100_000n.
const molida = { productId: "molida", productName: "MOLIDA VACUNA", pricePerKgCents: 1_100_000n };
const noDiscounts: DiscountRule[] = [];
const promo: DiscountRule = {
  id: "thr-molida", productId: "molida", branchId: null, promotionMode: "THRESHOLD", minimumGrams: 2_000, discountType: "FIXED_PRICE_PER_KG",
  discountValue: "800000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null
};
const pack: DiscountRule = {
  id: "pack-molida", productId: "molida", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
  discountValue: null, packQuantityGrams: 2_000, packQuantityUnits: null, packPriceCents: "1600000"
};
const weightLine = (grams: number, discounts: DiscountRule[], asPack = false) =>
  buildWeightTicketLine(molida, grams, "w", asPack, asPack ? discounts[0] ?? null : null, discounts, "central", "CASH", 0n);

describe("finalPricePerKgCents (sólo informativo, nunca se usa para cobrar)", () => {
  it("sin descuento no repite el precio por kg", () => {
    expect(finalPricePerKgCents(weightLine(2_000, noDiscounts))).toBeNull();
  });

  it("2 kg, lista $22.000, final $16.000 => $8.000/kg", () => {
    const line = weightLine(2_000, [promo]);
    expect(line.subtotalCents).toBe(1_600_000n);
    expect(finalPricePerKgCents(line)).toBe(800_000n);
  });

  it("pack WEIGHT: total realmente cobrado / peso real, con redondeo half-up en centavos", () => {
    const line = weightLine(2_100, [pack], true);
    expect(line.subtotalCents).toBe(1_600_000n); // total fijo del pack, el peso real no lo cambia
    expect(finalPricePerKgCents(line)).toBe(761_905n); // 1.600.000 * 1000 / 2100 = 761.904,76
  });

  it("precio manual: el precio/kg manual ya es el efectivo, no se repite", () => {
    expect(finalPricePerKgCents(applyManualPrice(weightLine(2_000, noDiscounts), 900_000n))).toBeNull();
  });

  it("UNIT nunca muestra precio/kg final", () => {
    const unit = buildUnitTicketLine({ productId: "c", productName: "Coca", pricePerKgCents: 120_000n }, 3, "u", null, "CASH", 0n);
    expect(finalPricePerKgCents(unit)).toBeNull();
  });
});
