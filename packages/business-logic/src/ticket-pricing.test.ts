import { describe, expect, it } from "vitest";

import { calculateSalePricing, calculateUnitPackSalePricing } from "./pricing";
import {
  allocateTicketDiscount, calculateManualLinePricing, calculateTicketDiscount, formatDiscountPercent, parseDiscountPercent
} from "./ticket-pricing";

// Dinero en centavos: $12.000 = 1_200_000n.
describe("calculateManualLinePricing (D-061)", () => {
  it("UNIT: Coca Cola 2,25 L de $12.000 a $10.000 deja un ajuste manual de -$2.000 por unidad", () => {
    const pricing = calculateManualLinePricing({ listPriceCents: 1_200_000n, manualUnitPriceCents: 1_000_000n, quantity: 1, quantityDivisor: 1 });
    expect(pricing).toEqual({
      listPriceCents: 1_200_000n, manualUnitPriceCents: 1_000_000n, listSubtotalCents: 1_200_000n,
      subtotalCents: 1_000_000n, manualAdjustmentCents: -200_000n
    });
  });

  it("UNIT: el precio es por unidad y se multiplica por la cantidad", () => {
    const pricing = calculateManualLinePricing({ listPriceCents: 1_200_000n, manualUnitPriceCents: 1_000_000n, quantity: 3, quantityDivisor: 1 });
    expect(pricing.subtotalCents).toBe(3_000_000n);
    expect(pricing.manualAdjustmentCents).toBe(-600_000n);
  });

  it("WEIGHT: el precio es por kg y se prorratea por gramos con redondeo half-up", () => {
    const pricing = calculateManualLinePricing({ listPriceCents: 1_500_000n, manualUnitPriceCents: 1_300_000n, quantity: 1_250, quantityDivisor: 1_000 });
    expect(pricing.listSubtotalCents).toBe(1_875_000n);
    expect(pricing.subtotalCents).toBe(1_625_000n);
    expect(pricing.manualAdjustmentCents).toBe(-250_000n);
    // 333 g a $10.001,00/kg = 3.330,333 -> 333033 centavos (redondeo half-up de 333.033,3).
    expect(calculateManualLinePricing({ listPriceCents: 1_100_000n, manualUnitPriceCents: 1_000_100n, quantity: 333, quantityDivisor: 1_000 }).subtotalCents).toBe(333_033n);
    // Mitad exacta redondea hacia arriba: 1 g a 150 centavos/kg = 0,15 -> 0; 5 g a 150 = 0,75 -> 1
    expect(calculateManualLinePricing({ listPriceCents: 1_000n, manualUnitPriceCents: 150n, quantity: 5, quantityDivisor: 1_000 }).subtotalCents).toBe(1n);
  });

  it("un precio manual mayor al normal también es válido (ajuste positivo)", () => {
    expect(calculateManualLinePricing({ listPriceCents: 1_000_000n, manualUnitPriceCents: 1_100_000n, quantity: 1, quantityDivisor: 1 }).manualAdjustmentCents).toBe(100_000n);
  });

  it("rechaza precio <= 0, cantidad inválida y una línea que redondea a $0", () => {
    const base = { listPriceCents: 1_000_000n, manualUnitPriceCents: 900_000n, quantity: 1, quantityDivisor: 1 as const };
    expect(() => calculateManualLinePricing({ ...base, manualUnitPriceCents: 0n })).toThrow(RangeError);
    expect(() => calculateManualLinePricing({ ...base, manualUnitPriceCents: -1n })).toThrow(RangeError);
    expect(() => calculateManualLinePricing({ ...base, quantity: 0 })).toThrow(RangeError);
    expect(() => calculateManualLinePricing({ ...base, quantity: 1.5 })).toThrow(RangeError);
    expect(() => calculateManualLinePricing({ ...base, listPriceCents: 0n })).toThrow(RangeError);
    // 1 g a 1 centavo/kg = 0,001 centavos -> $0: la base rechazaría subtotal_cents = 0.
    expect(() => calculateManualLinePricing({ listPriceCents: 1_000n, manualUnitPriceCents: 1n, quantity: 1, quantityDivisor: 1_000 })).toThrow(RangeError);
  });

  it("no depende del medio de pago ni de promociones: el motor normal sí cambia con tarjeta, el manual no", () => {
    // Misma línea con el motor normal: con tarjeta (+10%) sube.
    const normalCash = calculateSalePricing({ listPriceCents: 1_200_000n, quantity: 1, quantityDivisor: 1, paymentMethod: "CASH", cashDiscountBps: 1_000n });
    const normalCard = calculateSalePricing({ listPriceCents: 1_200_000n, quantity: 1, quantityDivisor: 1, paymentMethod: "DEBIT", cashDiscountBps: 1_000n });
    expect(normalCash.subtotalCents).toBe(1_200_000n);
    expect(normalCard.subtotalCents).toBe(1_320_000n);
    // El precio manual no recibe parámetros de medio de pago: es el mismo resultado siempre.
    const manual = calculateManualLinePricing({ listPriceCents: 1_200_000n, manualUnitPriceCents: 1_000_000n, quantity: 1, quantityDivisor: 1 });
    expect(manual.subtotalCents).toBe(1_000_000n);
    expect(Object.keys(manual)).not.toContain("cardSurchargeCents");
  });

  it("no recibe una promoción pack: el pack de 40 unidades sí la tendría, el manual cobra exactamente lo fijado", () => {
    const pack = calculateUnitPackSalePricing({
      listPriceCents: 100_000n, quantityUnits: 40, paymentMethod: "CASH", cashDiscountBps: 0n,
      pack: { id: "pack", packQuantityUnits: 40, packPriceCents: 2_800_000n }
    });
    expect(pack.subtotalCents).toBe(2_800_000n);
    const manual = calculateManualLinePricing({ listPriceCents: 100_000n, manualUnitPriceCents: 90_000n, quantity: 40, quantityDivisor: 1 });
    expect(manual.subtotalCents).toBe(3_600_000n);
  });
});

describe("parseDiscountPercent", () => {
  it("acepta enteros y decimales con coma o punto", () => {
    expect(parseDiscountPercent("5")).toEqual({ ok: true, bps: 500n });
    expect(parseDiscountPercent("7")).toEqual({ ok: true, bps: 700n });
    expect(parseDiscountPercent("10")).toEqual({ ok: true, bps: 1_000n });
    expect(parseDiscountPercent("12.5")).toEqual({ ok: true, bps: 1_250n });
    expect(parseDiscountPercent("12,5")).toEqual({ ok: true, bps: 1_250n });
    expect(parseDiscountPercent("7,25")).toEqual({ ok: true, bps: 725n });
    expect(parseDiscountPercent("0,05")).toEqual({ ok: true, bps: 5n });
    expect(parseDiscountPercent(" 3 ")).toEqual({ ok: true, bps: 300n });
  });

  it("vacío y 0 eliminan el descuento; el separador suelto mientras se tipea vale lo ya escrito", () => {
    expect(parseDiscountPercent("")).toEqual({ ok: true, bps: 0n });
    expect(parseDiscountPercent("0")).toEqual({ ok: true, bps: 0n });
    expect(parseDiscountPercent("0,0")).toEqual({ ok: true, bps: 0n });
    expect(parseDiscountPercent("5.")).toEqual({ ok: true, bps: 500n });
    expect(parseDiscountPercent("5,")).toEqual({ ok: true, bps: 500n });
  });

  it("permite de 0 a 100 y rechaza el resto", () => {
    expect(parseDiscountPercent("100")).toEqual({ ok: true, bps: 10_000n });
    expect(parseDiscountPercent("100,00")).toEqual({ ok: true, bps: 10_000n });
    expect(parseDiscountPercent("100,01").ok).toBe(false);
    expect(parseDiscountPercent("101").ok).toBe(false);
    expect(parseDiscountPercent("999").ok).toBe(false);
    expect(parseDiscountPercent("-5").ok).toBe(false);
    expect(parseDiscountPercent("1,234").ok).toBe(false);
    expect(parseDiscountPercent("abc").ok).toBe(false);
    expect(parseDiscountPercent("1e2").ok).toBe(false);
    expect(parseDiscountPercent("5%").ok).toBe(false);
    expect(parseDiscountPercent(",5").ok).toBe(false);
  });
});

describe("formatDiscountPercent", () => {
  it("muestra el porcentaje legible", () => {
    expect(formatDiscountPercent(500n)).toBe("5");
    expect(formatDiscountPercent(1_250n)).toBe("12,5");
    expect(formatDiscountPercent(725n)).toBe("7,25");
    expect(formatDiscountPercent(5n)).toBe("0,05");
    expect(formatDiscountPercent(10_000n)).toBe("100");
    expect(formatDiscountPercent(0n)).toBe("0");
  });
});

describe("calculateTicketDiscount (D-061)", () => {
  it("ejemplo del pedido: subtotal $24.000 con 5% descuenta $1.200 y cobra $22.800", () => {
    expect(calculateTicketDiscount(2_400_000n, 500n)).toEqual({ subtotalCents: 2_400_000n, discountBps: 500n, discountCents: 120_000n, totalCents: 2_280_000n });
  });

  it("10% de $24.000", () => {
    expect(calculateTicketDiscount(2_400_000n, 1_000n)).toMatchObject({ discountCents: 240_000n, totalCents: 2_160_000n });
  });

  it("0% elimina el descuento", () => {
    expect(calculateTicketDiscount(2_400_000n, 0n)).toMatchObject({ discountCents: 0n, totalCents: 2_400_000n });
  });

  it("decimales: 12,5% de $24.000", () => {
    expect(calculateTicketDiscount(2_400_000n, 1_250n)).toMatchObject({ discountCents: 300_000n, totalCents: 2_100_000n });
  });

  it("redondea half-up el importe descontado y el total absorbe el resto: subtotal = total + descuento", () => {
    // 5% de $0,10 (10 centavos) = 0,5 -> 1 centavo (half-up).
    expect(calculateTicketDiscount(10n, 500n)).toMatchObject({ discountCents: 1n, totalCents: 9n });
    // 5% de 9 centavos = 0,45 -> 0.
    expect(calculateTicketDiscount(9n, 500n)).toMatchObject({ discountCents: 0n, totalCents: 9n });
    // 7,25% de $1.234,57 = 8950,6325 -> 8951 centavos.
    const odd = calculateTicketDiscount(123_457n, 725n);
    expect(odd.discountCents).toBe(8_951n);
    expect(odd.discountCents + odd.totalCents).toBe(123_457n);
  });

  it("100% deja el total en $0 (la UI y la base lo bloquean al cobrar)", () => {
    expect(calculateTicketDiscount(2_400_000n, 10_000n)).toMatchObject({ discountCents: 2_400_000n, totalCents: 0n });
  });

  it("rechaza porcentajes fuera de rango", () => {
    expect(() => calculateTicketDiscount(100n, 10_001n)).toThrow(RangeError);
    expect(() => calculateTicketDiscount(100n, -1n)).toThrow(RangeError);
    expect(() => calculateTicketDiscount(-1n, 100n)).toThrow(RangeError);
  });

  it("combinación: precio manual + línea normal con tarjeta + descuento general", () => {
    // Línea 1 manual: $10.000 (no cambia con tarjeta). Línea 2 normal $14.000 con +10% de tarjeta = $15.400.
    const manual = calculateManualLinePricing({ listPriceCents: 1_200_000n, manualUnitPriceCents: 1_000_000n, quantity: 1, quantityDivisor: 1 });
    const normal = calculateSalePricing({ listPriceCents: 1_400_000n, quantity: 1, quantityDivisor: 1, paymentMethod: "DEBIT", cashDiscountBps: 1_000n });
    const subtotal = manual.subtotalCents + normal.subtotalCents;
    expect(subtotal).toBe(2_540_000n);
    // 5% general sobre $25.400 = $1.270 -> $24.130.
    expect(calculateTicketDiscount(subtotal, 500n)).toMatchObject({ discountCents: 127_000n, totalCents: 2_413_000n });
    // Al volver a efectivo, la línea manual sigue en $10.000 y sólo la normal baja; el 5% se conserva y se recalcula.
    const normalCash = calculateSalePricing({ listPriceCents: 1_400_000n, quantity: 1, quantityDivisor: 1, paymentMethod: "CASH", cashDiscountBps: 1_000n });
    const cashSubtotal = manual.subtotalCents + normalCash.subtotalCents;
    expect(cashSubtotal).toBe(2_400_000n);
    expect(calculateTicketDiscount(cashSubtotal, 500n)).toMatchObject({ discountCents: 120_000n, totalCents: 2_280_000n });
  });
});

describe("allocateTicketDiscount", () => {
  it("la suma asignada es exactamente el descuento y respeta el tope de cada línea", () => {
    const allocated = allocateTicketDiscount([1_000_000n, 1_400_000n], 120_000n);
    expect(allocated.reduce((sum, value) => sum + value, 0n)).toBe(120_000n);
    expect(allocated).toEqual([50_000n, 70_000n]);
  });

  it("reparte el resto por mayor resto y, en empate, a la línea de menor índice", () => {
    // 3 líneas iguales y 1 centavo: la primera se lo queda.
    expect(allocateTicketDiscount([100n, 100n, 100n], 1n)).toEqual([1n, 0n, 0n]);
    expect(allocateTicketDiscount([100n, 100n, 100n], 2n)).toEqual([1n, 1n, 0n]);
    // 10 centavos entre 3 iguales: 3,33 cada una -> 4,3,3.
    expect(allocateTicketDiscount([100n, 100n, 100n], 10n)).toEqual([4n, 3n, 3n]);
    // El mayor resto gana aunque su índice sea mayor: 7 entre [1, 6] -> shares 1 (rem 1/7*...) ... exacto.
    expect(allocateTicketDiscount([100n, 600n], 7n)).toEqual([1n, 6n]);
    const mixed = allocateTicketDiscount([300n, 300n, 400n], 5n);
    expect(mixed.reduce((sum, value) => sum + value, 0n)).toBe(5n);
    expect(mixed).toEqual([2n, 1n, 2n]);
  });

  it("sin descuento no asigna nada; 100% asigna el subtotal completo de cada línea", () => {
    expect(allocateTicketDiscount([100n, 200n], 0n)).toEqual([0n, 0n]);
    expect(allocateTicketDiscount([100n, 200n], 300n)).toEqual([100n, 200n]);
  });

  it("nunca asigna más que el subtotal de una línea (descuento <= total)", () => {
    for (const discount of [1n, 17n, 99n, 150n, 299n]) {
      const subtotals = [1n, 99n, 200n];
      const allocated = allocateTicketDiscount(subtotals, discount);
      expect(allocated.reduce((sum, value) => sum + value, 0n)).toBe(discount);
      allocated.forEach((value, index) => { expect(value <= (subtotals[index] ?? 0n)).toBe(true); });
    }
  });

  it("rechaza un descuento mayor al total o líneas sin importe", () => {
    expect(() => allocateTicketDiscount([100n], 101n)).toThrow(RangeError);
    expect(() => allocateTicketDiscount([100n, 0n], 10n)).toThrow(RangeError);
  });
});
