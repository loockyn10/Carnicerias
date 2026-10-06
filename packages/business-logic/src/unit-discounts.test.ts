import { describe, expect, it } from "vitest";

import {
  calculateBranchPromotionLinePricing, calculateUnitPackLinePricing, DEFAULT_PACK_DISCOUNT_BPS, isValidPackDiscountBps,
  isValidPackSizeUnits, packDiscountLabel, packRealUnits, promotedUnitsFor, type BranchUnitPromotion
} from "./unit-discounts";

const L = 100_000n; // $1.000,00
const FROM_3_15: BranchUnitPromotion = { id: "promo-1", minimumUnits: 3, discountBps: 1_500 };

function promo(quantityUnits: number, paymentMethod: "CASH" | "DEBIT" = "CASH", cardBps = 1_000n, listPriceCents = L, promotion = FROM_3_15) {
  return calculateBranchPromotionLinePricing({ listPriceCents, quantityUnits, promotion, paymentMethod, cashDiscountBps: cardBps });
}

describe("promoción de sucursal: DESDE 3 unidades, 15 % sobre toda la línea", () => {
  it("1 y 2 unidades no llegan al mínimo: sin descuento", () => {
    expect(promo(1)).toBeNull();
    expect(promo(2)).toBeNull();
  });

  it.each([
    [3, 3, 45_000n, 255_000n],
    [4, 4, 60_000n, 340_000n],
    [5, 5, 75_000n, 425_000n],
    [6, 6, 90_000n, 510_000n],
    [8, 8, 120_000n, 680_000n],
    [20, 20, 300_000n, 1_700_000n]
  ])("%i unidades: las %i con descuento (-%s) y total %s", (quantity, discounted, discount, total) => {
    const pricing = promo(quantity);
    expect(pricing).not.toBeNull();
    expect(pricing?.discountedUnits).toBe(discounted);
    expect(pricing?.unitDiscountCents).toBe(discount);
    expect(pricing?.promotionDiscountCents).toBe(discount);
    expect(pricing?.discountCents).toBe(discount);
    expect(pricing?.subtotalCents).toBe(total);
    expect(pricing?.cashSubtotalCents).toBe(total);
    expect(pricing?.cardSurchargeCents).toBe(0n);
  });

  it("4 unidades de $1.000: base $4.000, 15 % = -$600, total $3.400; 8 unidades: -$1.200, total $6.800", () => {
    const four = promo(4);
    expect([four?.listSubtotalCents, four?.unitDiscountCents, four?.subtotalCents]).toEqual([400_000n, 60_000n, 340_000n]);
    const eight = promo(8);
    expect([eight?.listSubtotalCents, eight?.unitDiscountCents, eight?.subtotalCents]).toEqual([800_000n, 120_000n, 680_000n]);
  });

  it("promotedUnitsFor: ninguna por debajo del mínimo y TODAS desde el mínimo (nunca floor(cantidad / N) × N)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((quantity) => promotedUnitsFor(quantity, 3))).toEqual([0, 0, 3, 4, 5, 6, 7, 8, 9, 20]);
    // Con un mínimo de 5 el descuento sólo aparece desde la quinta unidad.
    expect([3, 4, 5, 6, 12].map((quantity) => promotedUnitsFor(quantity, 5))).toEqual([0, 0, 5, 6, 12]);
  });

  it("el mínimo se evalúa por línea: dos productos distintos de 2 unidades NO se combinan", () => {
    // Cada línea del mismo ticket se calcula con su propia cantidad (2 + 2 = 4 no cuenta como 4).
    expect(promo(2)).toBeNull();
    expect(promo(2)).toBeNull();
  });

  it("la tarjeta recarga el total comercial completo, una sola vez, después de la promoción", () => {
    // 8 unidades: efectivo $6.800 → tarjeta +10 % = $7.480.
    const card = promo(8, "DEBIT");
    expect(card?.cashSubtotalCents).toBe(680_000n);
    expect(card?.subtotalCents).toBe(748_000n);
    expect(card?.cardSurchargeCents).toBe(68_000n);
    expect(card?.cashDiscountBps).toBe(1_000n);
    // El descuento en sí no depende del medio de pago.
    expect(card?.promotionDiscountCents).toBe(promo(8, "CASH")?.promotionDiscountCents);
  });

  it("efectivo/transferencia no llevan recargo", () => {
    expect(promo(8, "CASH", 1_000n)?.cardSurchargeCents).toBe(0n);
  });

  it("redondea half-up el descuento una sola vez sobre todas las unidades descontadas", () => {
    // $1,99 × 3 = 597; 15 % = 89,55 → 90 (half-up), no 3 × round(29,85).
    const pricing = promo(3, "CASH", 1_000n, 199n);
    expect(pricing?.unitDiscountCents).toBe(90n);
    expect(pricing?.subtotalCents).toBe(507n);
    // 4 × $1,99 = 796; 15 % = 119,4 → 119.
    expect(promo(4, "CASH", 1_000n, 199n)?.unitDiscountCents).toBe(119n);
  });

  it("rechaza porcentajes y mínimos inválidos", () => {
    expect(() => promo(3, "CASH", 0n, L, { id: "x", minimumUnits: 3, discountBps: 0 })).toThrow(RangeError);
    expect(() => promo(3, "CASH", 0n, L, { id: "x", minimumUnits: 3, discountBps: 10_000 })).toThrow(RangeError);
    expect(() => promo(3, "CASH", 0n, L, { id: "x", minimumUnits: 1, discountBps: 1_500 })).toThrow(RangeError);
    expect(() => promotedUnitsFor(0, 3)).toThrow(RangeError);
  });
});

describe("Pack: unidades reales con el descuento propio de cada producto", () => {
  const pack = (packCount: number, packSizeUnits = 8, packDiscountBps = 2_000, paymentMethod: "CASH" | "DEBIT" = "CASH", cardBps = 1_000n, listPriceCents = L) =>
    calculateUnitPackLinePricing({ listPriceCents, pack: { packCount, packSizeUnits, packDiscountBps }, paymentMethod, cashDiscountBps: cardBps });

  it("pack de 8 × $1.000 al 20 % → 8 unidades reales y $6.400", () => {
    const pricing = pack(1);
    expect(DEFAULT_PACK_DISCOUNT_BPS).toBe(2_000);
    expect(pricing.quantityUnits).toBe(8);
    expect(pricing.discountedUnits).toBe(8);
    expect(pricing.listSubtotalCents).toBe(800_000n);
    expect(pricing.unitDiscountCents).toBe(160_000n);
    expect(pricing.subtotalCents).toBe(640_000n);
    expect(pricing.discountBps).toBe(2_000);
  });

  it("el porcentaje es el del producto: Leche A 20 %, Leche B 25 %, Producto C (12 u) 15 %", () => {
    const milkA = pack(1, 8, 2_000);
    const milkB = pack(1, 8, 2_500);
    const productC = pack(1, 12, 1_500);
    expect([milkA.quantityUnits, milkA.unitDiscountCents, milkA.subtotalCents]).toEqual([8, 160_000n, 640_000n]);
    expect([milkB.quantityUnits, milkB.unitDiscountCents, milkB.subtotalCents]).toEqual([8, 200_000n, 600_000n]);
    expect([productC.quantityUnits, productC.unitDiscountCents, productC.subtotalCents]).toEqual([12, 180_000n, 1_020_000n]);
    expect(milkB.discountBps).toBe(2_500);
  });

  it("ejemplo del Admin: $1.000 por unidad, pack de 8 al 25 % → base $8.000, descuento $2.000, total $6.000", () => {
    const pricing = pack(1, 8, 2_500);
    expect([pricing.listSubtotalCents, pricing.unitDiscountCents, pricing.subtotalCents]).toEqual([800_000n, 200_000n, 600_000n]);
  });

  it("soporta porcentajes decimales (12,5 % = 1250 bps)", () => {
    const pricing = pack(1, 8, 1_250);
    expect(pricing.unitDiscountCents).toBe(100_000n);
    expect(pricing.subtotalCents).toBe(700_000n);
  });

  it("2 packs → 16 unidades reales y $12.800 (al 20 %)", () => {
    const pricing = pack(2);
    expect(pricing.quantityUnits).toBe(16);
    expect(pricing.listSubtotalCents).toBe(1_600_000n);
    expect(pricing.unitDiscountCents).toBe(320_000n);
    expect(pricing.subtotalCents).toBe(1_280_000n);
  });

  it("aplica exactamente el porcentaje del subtotal de lista (no el porcentaje por unidad redondeada)", () => {
    // 8 × $1,99 = $15,92; 20 % = $3,184 → 318 c (half-up); por unidad serían 8 × round(39,8) = 8 × 40 = 320.
    const pricing = pack(1, 8, 2_000, "CASH", 0n, 199n);
    expect(pricing.listSubtotalCents).toBe(1_592n);
    expect(pricing.unitDiscountCents).toBe(318n);
    expect(pricing.subtotalCents).toBe(1_274n);
  });

  it("NO se acumula con la promoción desde 3: el pack de 8 descuenta las 8 al % del producto, la venta normal de 8 toma el 15 %", () => {
    const asPack = pack(1, 8, 2_500);
    expect(asPack.kind).toBe("PACK");
    expect(asPack.discountedUnits).toBe(8);
    expect(asPack.subtotalCents).toBe(600_000n);
    const normal = promo(8);
    expect(normal?.kind).toBe("BRANCH_PROMOTION");
    expect(normal?.discountedUnits).toBe(8);
    expect(normal?.subtotalCents).toBe(680_000n);
    // Nunca -25 % y después -15 %: 8 × $1.000 × 0,75 × 0,85 = $5.100, que ninguna de las dos formas cobra.
    expect(asPack.subtotalCents).not.toBe(510_000n);
    expect(normal?.subtotalCents).not.toBe(510_000n);
  });

  it("el recargo de tarjeta se aplica después del pack, una sola vez", () => {
    const card = pack(1, 8, 2_000, "DEBIT");
    expect(card.cashSubtotalCents).toBe(640_000n);
    expect(card.subtotalCents).toBe(704_000n);
    expect(card.cardSurchargeCents).toBe(64_000n);
  });

  it("valida el tamaño del pack, el porcentaje (0 <= % < 100: 0 % es un pack sin descuento) y la cantidad", () => {
    expect(isValidPackSizeUnits(1)).toBe(false);
    expect(isValidPackSizeUnits(2)).toBe(true);
    expect(isValidPackSizeUnits(8)).toBe(true);
    expect(isValidPackSizeUnits(2.5)).toBe(false);
    expect(isValidPackSizeUnits(null)).toBe(false);
    expect([0, 1, 2_000, 9_999, 10_000, -5, 12.5, null].map((bps) => isValidPackDiscountBps(bps))).toEqual([true, true, true, true, false, false, false, false]);
    expect(packRealUnits(2, 8)).toBe(16);
    expect(() => packRealUnits(0, 8)).toThrow(RangeError);
    expect(() => packRealUnits(1, 1)).toThrow(RangeError);
  });

  it("un pack de 0 % es un pack válido: 8 unidades reales a precio de lista, con y sin recargo de tarjeta", () => {
    const cash = pack(1, 8, 0);
    expect(cash.discountedUnits).toBe(8);
    expect(cash.unitDiscountCents).toBe(0n);
    expect(cash.subtotalCents).toBe(800_000n);
    expect(packDiscountLabel(0)).toBe("sin descuento");
    expect(packDiscountLabel(2_000)).toBe("20% OFF");
    expect(packDiscountLabel(1_250)).toBe("12,5% OFF");
  });

  it("rechaza un pack sin porcentaje válido (100 % o más, negativo o NaN)", () => {
    expect(() => pack(1, 8, -1)).toThrow(RangeError);
    expect(() => pack(1, 8, 10_000)).toThrow(RangeError);
    expect(() => pack(1, 8, 12_000)).toThrow(RangeError);
    expect(() => pack(1, 8, Number.NaN)).toThrow(RangeError);
  });

  it("un descuento que deja la línea en $0 se rechaza", () => {
    expect(() => calculateBranchPromotionLinePricing({
      listPriceCents: 1n, quantityUnits: 2, promotion: { id: "x", minimumUnits: 2, discountBps: 9_999 }, paymentMethod: "CASH", cashDiscountBps: 0n
    })).toThrow(RangeError);
  });
});
