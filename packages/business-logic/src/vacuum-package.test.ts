import { describe, expect, it } from "vitest";

import { calculateVacuumPackagePricing } from "./vacuum-package";

describe("línea PACKAGE: importe fijo", () => {
  it("efectivo: se cobra el importe del paquete, sin recalcular precio/kg × peso", () => {
    const pricing = calculateVacuumPackagePricing({ fixedTotalCents: 1_125_000n, weightGrams: 750, paymentMethod: "CASH", cashDiscountBps: 1000n });
    expect(pricing.subtotalCents).toBe(1_125_000n);
    expect(pricing.cardSurchargeCents).toBe(0n);
    expect(pricing.cashDiscountBps).toBe(0n);
    expect(pricing.discountCents).toBe(0n);
    expect(pricing.promotionDiscountCents).toBe(0n);
    expect(pricing.listPriceCents).toBe(1_500_000n); // $15.000/kg derivado, sólo para mostrar
  });

  it("el importe NO depende del precio/kg actual: sólo del paquete", () => {
    const a = calculateVacuumPackagePricing({ fixedTotalCents: 1_125_000n, weightGrams: 750, paymentMethod: "TRANSFER", cashDiscountBps: 0n });
    expect(a.subtotalCents).toBe(1_125_000n);
  });

  it("tarjeta: el recargo se suma UNA vez sobre el importe completo, half-up, y queda separado", () => {
    const pricing = calculateVacuumPackagePricing({ fixedTotalCents: 499_500n, weightGrams: 333, paymentMethod: "DEBIT", cashDiscountBps: 1000n });
    expect(pricing.subtotalCents).toBe(549_450n);
    expect(pricing.cardSurchargeCents).toBe(49_950n);
    expect(pricing.cashSubtotalCents).toBe(499_500n);
    expect(pricing.cashDiscountBps).toBe(1000n);
  });

  it("tarjeta de crédito redondea half-up", () => {
    const pricing = calculateVacuumPackagePricing({ fixedTotalCents: 1_001_00n, weightGrams: 100, paymentMethod: "CREDIT", cashDiscountBps: 1n });
    expect(pricing.subtotalCents).toBe(100_110n); // 100.100 × 1,0001 = 100.110,01 → 100.110
    expect(pricing.cardSurchargeCents).toBe(10n);
  });

  it("rechaza importe o peso inválidos", () => {
    expect(() => calculateVacuumPackagePricing({ fixedTotalCents: 0n, weightGrams: 750, paymentMethod: "CASH", cashDiscountBps: 0n })).toThrow(RangeError);
    expect(() => calculateVacuumPackagePricing({ fixedTotalCents: 100n, weightGrams: 0, paymentMethod: "CASH", cashDiscountBps: 0n })).toThrow(RangeError);
    expect(() => calculateVacuumPackagePricing({ fixedTotalCents: 100n, weightGrams: 10, paymentMethod: "DEBIT", cashDiscountBps: 10_000n })).toThrow(RangeError);
  });
});
