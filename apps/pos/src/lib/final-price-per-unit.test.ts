import type { BranchUnitPromotion } from "@carnicerias/business-logic";
import type { TicketLine } from "@carnicerias/types";
import { describe, expect, it } from "vitest";

import {
  applyManualPrice, buildUnitTicketLine, finalPricePerUnitCents, promotedUnitPriceCents, repriceTicketLine, unitPromotionLabel, type DiscountRule
} from "./ticket-pricing";

// Dinero en centavos: $5.400/u = 540_000n. Recargo de tarjeta configurado: 10 %.
const CARD_BPS = 1_000n;
const yerba = { productId: "yerba", productName: 'YERBA "AGUANTADORA" X KG', pricePerKgCents: 540_000n };
const FROM_3_15: BranchUnitPromotion = { id: "promo", minimumUnits: 3, discountBps: 1_500 };
const unitLine = (units: number, promotion: BranchUnitPromotion | null = FROM_3_15, method: Parameters<typeof buildUnitTicketLine>[4] = "CASH", product = yerba) =>
  buildUnitTicketLine(product, units, "u", null, method, CARD_BPS, { branchPromotions: promotion ? [promotion] : [] });
const unitPackRule = (packQuantityUnits: number): DiscountRule => ({
  id: "pack-rule", productId: "yerba", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
  discountValue: null, packQuantityGrams: null, packQuantityUnits, packPriceCents: "1440000"
});

describe("finalPricePerUnitCents (sólo informativo, nunca se usa para cobrar)", () => {
  it("3 × $5.400 con 15 %: total real $13.770 => $4.590/u final", () => {
    const line = unitLine(3);
    expect(line.subtotalCents).toBe(1_377_000n);
    expect(line.promotionDiscountCents).toBe(243_000n);
    expect(finalPricePerUnitCents(line)).toBe(459_000n);
  });

  it("debajo del mínimo no hay precio final distinto", () => {
    expect(finalPricePerUnitCents(unitLine(2))).toBeNull();
  });

  it("sin promoción no duplica el precio", () => {
    expect(finalPricePerUnitCents(unitLine(1, null))).toBeNull();
    expect(finalPricePerUnitCents(unitLine(5, null))).toBeNull();
  });

  it("precio manual: el precio/u manual ya es el efectivo, el total real es manual × unidades", () => {
    const manual = applyManualPrice(unitLine(3), 400_000n);
    expect(manual.subtotalCents).toBe(1_200_000n);
    expect(finalPricePerUnitCents(manual)).toBeNull();
  });

  it("promoción de un producto (PACK_FIXED_TOTAL por unidades): total real / unidades", () => {
    const line = buildUnitTicketLine(yerba, 8, "p", unitPackRule(8), "CASH", CARD_BPS);
    expect(line.subtotalCents).toBe(1_440_000n);
    expect(finalPricePerUnitCents(line)).toBe(180_000n); // $1.800/u
  });

  it("con tarjeta el precio efectivo incluye el recargo (igual que WEIGHT: es lo que realmente se cobra)", () => {
    const line = unitLine(3, FROM_3_15, "DEBIT");
    expect(line.subtotalCents).toBe(1_514_700n);
    expect(finalPricePerUnitCents(line)).toBe(504_900n);
    expect(finalPricePerUnitCents(unitLine(1, FROM_3_15, "DEBIT"))).toBe(594_000n);
    // Cambiar de medio de pago repreciando la línea no deja un precio final viejo.
    const back = repriceTicketLine(line, { paymentMethod: "CASH", discounts: [], cashDiscountBps: CARD_BPS, branchId: "b", branchPromotions: [FROM_3_15] });
    expect(finalPricePerUnitCents(back)).toBe(459_000n);
  });

  it("no es una línea UNIT: null", () => {
    const weightLike = Object.fromEntries(Object.entries(unitLine(3)).filter(([key]) => key !== "quantityUnits")) as unknown as TicketLine;
    expect(finalPricePerUnitCents({ ...weightLike, weightGrams: 2_000 })).toBeNull();
  });

  it("redondeo half-up en centavos, el mismo que el motor (finalPriceCents)", () => {
    // 2 u × $1.000,03 con 10 %: total real 180.005 c => 90.002,5 => 90.003.
    const line = unitLine(2, { id: "p2", minimumUnits: 2, discountBps: 1_000 }, "CASH", { ...yerba, pricePerKgCents: 100_003n });
    expect(line.subtotalCents).toBe(180_005n);
    expect(finalPricePerUnitCents(line)).toBe(90_003n);
    expect(finalPricePerUnitCents(line)).toBe(line.pricePerKgCents);
    // 4 u × $999,99 con 15 %: 339.997 c / 4 = 84.999,25 => 84.999.
    const odd = unitLine(4, FROM_3_15, "CASH", { ...yerba, pricePerKgCents: 99_999n });
    expect(odd.subtotalCents).toBe(339_997n);
    expect(finalPricePerUnitCents(odd)).toBe(84_999n);
  });
});

describe("promotedUnitPriceCents / unitPromotionLabel (precio promocional ANTES de vender)", () => {
  it("$5.400/u + 15 % desde 3 => '$4.590/u desde 3 u'", () => {
    expect(promotedUnitPriceCents(540_000n, FROM_3_15)).toBe(459_000n);
    expect(unitPromotionLabel(540_000n, [FROM_3_15])).toBe("$ 4.590/u desde 3 u");
  });

  it("coincide exactamente con lo que cobra el motor al llevar el mínimo", () => {
    for (const price of [540_000n, 100_003n, 99_999n, 12_345n]) {
      const line = buildUnitTicketLine({ ...yerba, pricePerKgCents: price }, 3, "x", null, "CASH", CARD_BPS, { branchPromotions: [FROM_3_15] });
      expect(promotedUnitPriceCents(price, FROM_3_15)).toBe(finalPricePerUnitCents(line) ?? price);
    }
  });

  it("sin promoción, sin precio o con una promoción que no baja el precio: sin etiqueta", () => {
    expect(unitPromotionLabel(540_000n, null)).toBeNull();
    expect(unitPromotionLabel(540_000n, undefined)).toBeNull();
    expect(unitPromotionLabel(0n, [FROM_3_15])).toBeNull();
    expect(unitPromotionLabel(540_000n, [])).toBeNull();
    expect(unitPromotionLabel(100n, [{ id: "p", minimumUnits: 3, discountBps: 1 }])).toBeNull();
  });

  it("una promoción por producto con pack que cabe en el mínimo gana a la de sucursal: sin etiqueta engañosa", () => {
    expect(unitPromotionLabel(540_000n, [FROM_3_15], unitPackRule(3))).toBeNull();
    expect(unitPromotionLabel(540_000n, [FROM_3_15], unitPackRule(2))).toBeNull();
    expect(unitPromotionLabel(540_000n, [FROM_3_15], unitPackRule(8))).toBe("$ 4.590/u desde 3 u");
  });
});
