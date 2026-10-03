import { describe, expect, it } from "vitest";

import {
  calculateBranchPromotionLinePricing, calculateUnitPackLinePricing, isValidPackSizeUnits, PACK_DISCOUNT_BPS,
  packRealUnits, promotedUnitsFor, type BranchUnitPromotion
} from "./unit-discounts";

const L = 100_000n; // $1.000,00
const EVERY_3_15: BranchUnitPromotion = { id: "promo-1", everyUnits: 3, discountBps: 1_500 };

function promo(quantityUnits: number, paymentMethod: "CASH" | "DEBIT" = "CASH", cardBps = 1_000n, listPriceCents = L) {
  return calculateBranchPromotionLinePricing({ listPriceCents, quantityUnits, promotion: EVERY_3_15, paymentMethod, cashDiscountBps: cardBps });
}

describe("promoción de sucursal: cada 3 unidades, 15 %", () => {
  it("1 y 2 unidades no completan ningún grupo", () => {
    expect(promo(1)).toBeNull();
    expect(promo(2)).toBeNull();
  });

  it.each([
    [3, 3, 45_000n, 255_000n],
    [4, 3, 45_000n, 355_000n],
    [5, 3, 45_000n, 455_000n],
    [6, 6, 90_000n, 510_000n],
    [8, 6, 90_000n, 710_000n]
  ])("%i unidades: %i con descuento (-%s) y total %s", (quantity, discounted, discount, total) => {
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

  it("sólo cuenta unidades enteras del mismo producto (promotedUnitsFor)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((quantity) => promotedUnitsFor(quantity, 3))).toEqual([0, 0, 3, 3, 3, 6, 6, 6, 9]);
  });

  it("la tarjeta recarga el total comercial completo, una sola vez, después de la promoción", () => {
    // 8 unidades: efectivo $7.100 → tarjeta +10 % = $7.810.
    const card = promo(8, "DEBIT");
    expect(card?.cashSubtotalCents).toBe(710_000n);
    expect(card?.subtotalCents).toBe(781_000n);
    expect(card?.cardSurchargeCents).toBe(71_000n);
    expect(card?.cashDiscountBps).toBe(1_000n);
    // El descuento en sí no depende del medio de pago.
    expect(card?.promotionDiscountCents).toBe(promo(8, "CASH")?.promotionDiscountCents);
  });

  it("efectivo/transferencia no llevan recargo", () => {
    expect(promo(8, "CASH", 1_000n)?.cardSurchargeCents).toBe(0n);
  });

  it("redondea half-up el descuento una sola vez sobre las unidades descontadas", () => {
    // $1,99 × 3 = 597; 15 % = 89,55 → 90 (half-up), no 3 × round(29,85).
    const pricing = promo(3, "CASH", 1_000n, 199n);
    expect(pricing?.unitDiscountCents).toBe(90n);
    expect(pricing?.subtotalCents).toBe(507n);
  });

  it("rechaza porcentajes y grupos inválidos", () => {
    expect(() => calculateBranchPromotionLinePricing({ listPriceCents: L, quantityUnits: 3, promotion: { id: "x", everyUnits: 3, discountBps: 0 }, paymentMethod: "CASH", cashDiscountBps: 0n })).toThrow(RangeError);
    expect(() => calculateBranchPromotionLinePricing({ listPriceCents: L, quantityUnits: 3, promotion: { id: "x", everyUnits: 1, discountBps: 1_500 }, paymentMethod: "CASH", cashDiscountBps: 0n })).toThrow(RangeError);
    expect(() => promotedUnitsFor(0, 3)).toThrow(RangeError);
  });
});

describe("Pack: unidades reales con 20 % de descuento", () => {
  const pack = (packCount: number, packSizeUnits = 8, paymentMethod: "CASH" | "DEBIT" = "CASH", cardBps = 1_000n, listPriceCents = L) =>
    calculateUnitPackLinePricing({ listPriceCents, pack: { packCount, packSizeUnits }, paymentMethod, cashDiscountBps: cardBps });

  it("pack de 8 × $1.000 → 8 unidades reales y $6.400", () => {
    const pricing = pack(1);
    expect(PACK_DISCOUNT_BPS).toBe(2_000);
    expect(pricing.quantityUnits).toBe(8);
    expect(pricing.discountedUnits).toBe(8);
    expect(pricing.listSubtotalCents).toBe(800_000n);
    expect(pricing.unitDiscountCents).toBe(160_000n);
    expect(pricing.subtotalCents).toBe(640_000n);
    expect(pricing.discountBps).toBe(2_000);
  });

  it("2 packs → 16 unidades reales y $12.800", () => {
    const pricing = pack(2);
    expect(pricing.quantityUnits).toBe(16);
    expect(pricing.listSubtotalCents).toBe(1_600_000n);
    expect(pricing.unitDiscountCents).toBe(320_000n);
    expect(pricing.subtotalCents).toBe(1_280_000n);
  });

  it("aplica exactamente 20 % del subtotal de lista (no 20 % por unidad redondeada)", () => {
    // 8 × $1,99 = $15,92; 20 % = $3,184 → 318 c (half-up); por unidad serían 8 × round(39,8) = 8 × 40 = 320.
    const pricing = pack(1, 8, "CASH", 0n, 199n);
    expect(pricing.listSubtotalCents).toBe(1_592n);
    expect(pricing.unitDiscountCents).toBe(318n);
    expect(pricing.subtotalCents).toBe(1_274n);
  });

  it("NO recibe además la promoción cada 3: el pack de 8 descuenta las 8 unidades al 20 %, la venta normal de 8 deja 2 normales", () => {
    const asPack = pack(1);
    expect(asPack.kind).toBe("PACK");
    expect(asPack.discountedUnits).toBe(8);
    expect(asPack.subtotalCents).toBe(640_000n);
    const normal = promo(8);
    expect(normal?.kind).toBe("BRANCH_PROMOTION");
    expect(normal?.discountedUnits).toBe(6);
    expect(normal?.subtotalCents).toBe(710_000n);
    // No hay acumulación posible: 20 % + 15 % sobre las mismas unidades costaría menos que cualquiera de los dos.
    expect(asPack.subtotalCents).toBeLessThan(normal?.subtotalCents ?? 0n);
  });

  it("el recargo de tarjeta se aplica después del pack, una sola vez", () => {
    const card = pack(1, 8, "DEBIT");
    expect(card.cashSubtotalCents).toBe(640_000n);
    expect(card.subtotalCents).toBe(704_000n);
    expect(card.cardSurchargeCents).toBe(64_000n);
  });

  it("valida el tamaño del pack y la cantidad", () => {
    expect(isValidPackSizeUnits(1)).toBe(false);
    expect(isValidPackSizeUnits(2)).toBe(true);
    expect(isValidPackSizeUnits(8)).toBe(true);
    expect(isValidPackSizeUnits(2.5)).toBe(false);
    expect(isValidPackSizeUnits(null)).toBe(false);
    expect(packRealUnits(2, 8)).toBe(16);
    expect(() => packRealUnits(0, 8)).toThrow(RangeError);
    expect(() => packRealUnits(1, 1)).toThrow(RangeError);
  });

  it("un descuento que deja la línea en $0 se rechaza", () => {
    expect(() => calculateBranchPromotionLinePricing({
      listPriceCents: 1n, quantityUnits: 2, promotion: { id: "x", everyUnits: 2, discountBps: 9_999 }, paymentMethod: "CASH", cashDiscountBps: 0n
    })).toThrow(RangeError);
  });
});
