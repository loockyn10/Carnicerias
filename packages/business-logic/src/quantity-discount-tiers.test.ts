import { describe, expect, it } from "vitest";

import {
  calculateQuantityTierLinePricing, MAX_QUANTITY_TIERS, normalizeQuantityTiers, quantityTierLabel, selectQuantityTier
} from "./quantity-discount-tiers";
import type { BranchUnitPromotion } from "./unit-discounts";

const L = 100_000n; // $1.000,00 por unidad
const T3: BranchUnitPromotion = { id: "tier-3", minimumUnits: 3, discountBps: 1_500 };
const T5: BranchUnitPromotion = { id: "tier-5", minimumUnits: 5, discountBps: 2_000 };

function price(quantityUnits: number, tiers: readonly BranchUnitPromotion[] = [T3, T5], paymentMethod: "CASH" | "DEBIT" = "CASH", listPriceCents = L) {
  return calculateQuantityTierLinePricing({ listPriceCents, quantityUnits, tiers, paymentMethod, cashDiscountBps: 1_000n });
}

describe("descuento por cantidad: 3 → 15 %, 5 → 20 %", () => {
  it("1 y 2 unidades no llegan al primer escalón: sin descuento", () => {
    expect(price(1)).toBeNull();
    expect(price(2)).toBeNull();
  });

  it.each([
    [3, 3, 15, 45_000n, 255_000n],
    [4, 4, 15, 60_000n, 340_000n],
    [5, 5, 20, 100_000n, 400_000n],
    [6, 6, 20, 120_000n, 480_000n],
    [10, 10, 20, 200_000n, 800_000n],
    [50, 50, 20, 1_000_000n, 4_000_000n]
  ])("%i unidades: las %i con el %i %% (-%s), total %s", (quantity, discounted, percent, discount, total) => {
    const pricing = price(quantity);
    expect(pricing?.discountedUnits).toBe(discounted);
    expect(pricing?.discountBps).toBe(percent * 100);
    expect(pricing?.unitDiscountCents).toBe(discount);
    expect(pricing?.subtotalCents).toBe(total);
  });

  it("NO acumula los escalones: 5 unidades son 20 %, nunca 15 % + 20 %", () => {
    const five = price(5);
    expect(five?.subtotalCents).toBe(400_000n);
    // Acumulados (0,85 × 0,80 = 32 % de descuento) darían $3.400: no es lo que cobra el sistema.
    expect(five?.subtotalCents).not.toBe(340_000n);
    expect(five?.unitDiscountCents).toBe(100_000n);
  });

  it("devuelve el escalón aplicado (id y mínimo) para guardarlo como snapshot de la venta", () => {
    expect([price(3)?.promotionId, price(3)?.promotionMinimumUnits]).toEqual(["tier-3", 3]);
    expect([price(4)?.promotionId, price(4)?.promotionMinimumUnits]).toEqual(["tier-3", 3]);
    expect([price(5)?.promotionId, price(5)?.promotionMinimumUnits]).toEqual(["tier-5", 5]);
    expect([price(20)?.promotionId, price(20)?.promotionMinimumUnits]).toEqual(["tier-5", 5]);
  });

  it("no depende del orden en que llegan los escalones", () => {
    expect(price(4, [T5, T3])?.promotionId).toBe("tier-3");
    expect(price(5, [T5, T3])?.promotionId).toBe("tier-5");
    expect(selectQuantityTier([T5, T3], 7)?.id).toBe("tier-5");
  });

  it("sin escalones configurados no hay descuento", () => {
    expect(price(10, [])).toBeNull();
  });

  it("el recargo de tarjeta se aplica UNA vez, sobre el total ya descontado del escalón", () => {
    // 5 u: $4.000 con el 20 % → tarjeta +10 % = $4.400 (el recargo no se descuenta ni se compone con el escalón).
    const card = price(5, [T3, T5], "DEBIT");
    expect(card?.cashSubtotalCents).toBe(400_000n);
    expect(card?.subtotalCents).toBe(440_000n);
    expect(card?.cardSurchargeCents).toBe(40_000n);
    const three = price(3, [T3, T5], "DEBIT");
    expect(three?.cashSubtotalCents).toBe(255_000n);
    expect(three?.subtotalCents).toBe(280_500n);
  });

  it("redondea half-up sobre el total de la línea (centavos enteros)", () => {
    // 3 u × $333,33 = $999,99; 15 % = $149,9985 → $150,00 de descuento (half-up) y total $849,99.
    const rounded = price(3, [T3, T5], "CASH", 33_333n);
    expect(rounded?.listSubtotalCents).toBe(99_999n);
    expect(rounded?.unitDiscountCents).toBe(15_000n);
    expect(rounded?.subtotalCents).toBe(84_999n);
  });

  it("agregar o cambiar escalones (2 → 10 %, 3 → 15 %, 5 → 20 %, 10 → 25 %) cambia lo que se cobra, sin tocar el cálculo", () => {
    const tiers: BranchUnitPromotion[] = [
      { id: "a", minimumUnits: 2, discountBps: 1_000 }, { id: "b", minimumUnits: 3, discountBps: 1_500 }, { id: "c", minimumUnits: 5, discountBps: 2_000 }, { id: "d", minimumUnits: 10, discountBps: 2_500 }
    ];
    expect([1, 2, 3, 4, 5, 9, 10, 11].map((units) => price(units, tiers)?.discountBps ?? 0)).toEqual([0, 1_000, 1_500, 1_500, 2_000, 2_000, 2_500, 2_500]);
    expect(price(10, tiers)?.subtotalCents).toBe(750_000n);
  });

  it("rechaza una cantidad inválida", () => {
    expect(() => price(0)).toThrow(RangeError);
    expect(() => price(2.5)).toThrow(RangeError);
  });
});

describe("textos de los escalones", () => {
  it("«Llevando N o más: X% dto.»", () => {
    expect(quantityTierLabel({ minimumUnits: 3, discountBps: 1_500 })).toBe("Llevando 3 o más: 15% dto.");
    expect(quantityTierLabel({ minimumUnits: 5, discountBps: 2_000 })).toBe("Llevando 5 o más: 20% dto.");
    expect(quantityTierLabel({ minimumUnits: 6, discountBps: 1_250 })).toBe("Llevando 6 o más: 12,5% dto.");
  });
});

describe("validación de la configuración", () => {
  const ok = (tiers: { minimumUnits: number; discountBps: number }[]) => normalizeQuantityTiers(tiers);

  it("acepta 3 → 15 % y 5 → 20 % y los ordena por cantidad", () => {
    expect(ok([{ minimumUnits: 5, discountBps: 2_000 }, { minimumUnits: 3, discountBps: 1_500 }])).toEqual({
      ok: true, tiers: [{ minimumUnits: 3, discountBps: 1_500 }, { minimumUnits: 5, discountBps: 2_000 }]
    });
    expect(ok([])).toEqual({ ok: true, tiers: [] });
  });

  it("la cantidad mínima es un entero >= 2", () => {
    expect(ok([{ minimumUnits: 1, discountBps: 1_000 }].map((tier) => tier)).ok).toBe(false);
    expect(ok([{ minimumUnits: 0, discountBps: 1_000 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 2.5, discountBps: 1_000 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 1_001, discountBps: 1_000 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 2, discountBps: 1_000 }]).ok).toBe(true);
  });

  it("el porcentaje es mayor a 0 y menor a 100 (en basis points enteros)", () => {
    expect(ok([{ minimumUnits: 3, discountBps: 0 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 3, discountBps: -5 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 3, discountBps: 10_000 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 3, discountBps: 15.5 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 3, discountBps: 9_999 }]).ok).toBe(true);
    expect(ok([{ minimumUnits: 3, discountBps: 1 }]).ok).toBe(true);
  });

  it("no admite cantidades duplicadas", () => {
    const duplicated = ok([{ minimumUnits: 3, discountBps: 1_500 }, { minimumUnits: 3, discountBps: 2_000 }]);
    expect(duplicated.ok).toBe(false);
    expect(!duplicated.ok && duplicated.error).toContain("misma cantidad");
  });

  it("llevar más no puede dar menos descuento", () => {
    expect(ok([{ minimumUnits: 3, discountBps: 2_000 }, { minimumUnits: 5, discountBps: 1_500 }]).ok).toBe(false);
    expect(ok([{ minimumUnits: 3, discountBps: 1_500 }, { minimumUnits: 5, discountBps: 1_500 }]).ok).toBe(false);
  });

  it("admite hasta 10 escalones", () => {
    const many = Array.from({ length: MAX_QUANTITY_TIERS + 1 }, (_, index) => ({ minimumUnits: index + 2, discountBps: (index + 1) * 100 }));
    expect(ok(many).ok).toBe(false);
    expect(ok(many.slice(0, MAX_QUANTITY_TIERS)).ok).toBe(true);
  });
});
