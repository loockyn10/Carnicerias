import { calculateTicketDiscount, parseDiscountPercent } from "@carnicerias/business-logic";
import type { TicketLine } from "@carnicerias/types";
import { describe, expect, it } from "vitest";

import {
  applyManualPrice, buildUnitTicketLine, buildWeightTicketLine, carryManualPrice, repriceTicketLine, restoreNormalPrice,
  summarizeTicket, type DiscountRule, type PricingContext
} from "./ticket-pricing";

// Dinero en centavos: $12.000 = 1_200_000n. Recargo de tarjeta configurado: 10%.
const BRANCH = "central";
const SURCHARGE_BPS = 1_000n;
const coca = { productId: "coca", productName: "Coca Cola 2.25 L", pricePerKgCents: 1_200_000n };
const vacio = { productId: "vacio", productName: "Vacío", pricePerKgCents: 1_500_000n };

const noDiscounts: DiscountRule[] = [];
const hamburguesaPack: DiscountRule = {
  id: "pack-ham", productId: "ham", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
  discountValue: null, packQuantityGrams: null, packQuantityUnits: 40, packPriceCents: "2800000"
};
const vacioThreshold: DiscountRule = {
  id: "thr-vacio", productId: "vacio", branchId: null, promotionMode: "THRESHOLD", minimumGrams: 2_000, discountType: "PERCENTAGE",
  discountValue: "1000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null
};

function context(paymentMethod: PricingContext["paymentMethod"], discounts: DiscountRule[] = noDiscounts): PricingContext {
  return { paymentMethod, discounts, cashDiscountBps: SURCHARGE_BPS, branchId: BRANCH };
}

function unitLine(method: PricingContext["paymentMethod"], quantity = 1, product = coca, discounts: DiscountRule[] = noDiscounts): TicketLine {
  return buildUnitTicketLine(product, quantity, `line-${product.productId}`, discounts[0] ?? null, method, SURCHARGE_BPS);
}

describe("línea normal (el motor existente no cambia)", () => {
  it("UNIT: efectivo = precio de lista, tarjeta = lista + recargo", () => {
    expect(unitLine("CASH").subtotalCents).toBe(1_200_000n);
    expect(unitLine("DEBIT").subtotalCents).toBe(1_320_000n);
  });

  it("repriceTicketLine cambia una línea normal entre CASH y tarjeta en ambos sentidos sin componer el recargo", () => {
    const cash = unitLine("CASH");
    const card = repriceTicketLine(cash, context("DEBIT"));
    expect(card.subtotalCents).toBe(1_320_000n);
    expect(card.cardSurchargeCents).toBe(120_000n);
    const backToCash = repriceTicketLine(card, context("CASH"));
    expect(backToCash.subtotalCents).toBe(1_200_000n);
    expect(backToCash.cardSurchargeCents).toBe(0n);
    expect(repriceTicketLine(repriceTicketLine(backToCash, context("DEBIT")), context("DEBIT")).subtotalCents).toBe(1_320_000n);
  });

  it("WEIGHT con promoción por umbral sigue aplicándose en una línea normal", () => {
    const line = buildWeightTicketLine(vacio, 2_500, "w", false, null, [vacioThreshold], BRANCH, "CASH", SURCHARGE_BPS);
    // 2,5 kg a $15.000 con 10% off = $13.500/kg -> $33.750
    expect(line.subtotalCents).toBe(3_375_000n);
    expect(line.promotionMode).toBeNull();
    expect(line.discountRuleId).toBe("thr-vacio");
  });
});

describe("precio manual por línea (D-061)", () => {
  it("UNIT: Coca Cola de $12.000 a $10.000 — precio por unidad, snapshot auditable, catálogo intacto", () => {
    const manual = applyManualPrice(unitLine("CASH"), 1_000_000n);
    expect(manual).toMatchObject({
      manualPriceApplied: true, manualUnitPriceCents: 1_000_000n, manualAdjustmentCents: -200_000n,
      pricePerKgCents: 1_000_000n, originalPricePerKgCents: 1_200_000n, subtotalCents: 1_000_000n,
      promotionDiscountCents: 0n, cardSurchargeCents: 0n, discountCents: 0n, promotionMode: null, discountRuleId: null
    });
    // El producto del catálogo (precio normal) ni se tocó: la línea conserva el original y el objeto fuente es el mismo.
    expect(coca.pricePerKgCents).toBe(1_200_000n);
  });

  it("UNIT: el precio manual es por unidad y la cantidad sigue funcionando", () => {
    const manual = applyManualPrice(unitLine("CASH", 3), 1_000_000n);
    expect(manual.subtotalCents).toBe(3_000_000n);
    expect(manual.manualAdjustmentCents).toBe(-600_000n);
    expect(carryManualPrice(manual, unitLine("CASH", 5)).subtotalCents).toBe(5_000_000n);
  });

  it("WEIGHT: el precio manual es por kg y se prorratea por el peso real", () => {
    const line = buildWeightTicketLine(vacio, 1_250, "w", false, null, noDiscounts, BRANCH, "CASH", SURCHARGE_BPS);
    expect(line.subtotalCents).toBe(1_875_000n);
    const manual = applyManualPrice(line, 1_300_000n);
    expect(manual).toMatchObject({ pricePerKgCents: 1_300_000n, originalPricePerKgCents: 1_500_000n, subtotalCents: 1_625_000n, manualAdjustmentCents: -250_000n, weightGrams: 1_250 });
    // El peso cambia (reedición de la línea): el precio por kg manual se conserva sobre el nuevo peso.
    const heavier = carryManualPrice(manual, buildWeightTicketLine(vacio, 2_000, "w", false, null, noDiscounts, BRANCH, "CASH", SURCHARGE_BPS));
    expect(heavier).toMatchObject({ manualPriceApplied: true, subtotalCents: 2_600_000n, pricePerKgCents: 1_300_000n });
  });

  it("rechaza precio <= 0 y una línea que quedaría en $0", () => {
    expect(() => applyManualPrice(unitLine("CASH"), 0n)).toThrow(RangeError);
    expect(() => applyManualPrice(unitLine("CASH"), -100n)).toThrow(RangeError);
    const tiny = buildWeightTicketLine({ productId: "x", productName: "X", pricePerKgCents: 1_000n }, 1, "w", false, null, noDiscounts, BRANCH, "CASH", SURCHARGE_BPS);
    expect(() => applyManualPrice(tiny, 1n)).toThrow(RangeError);
  });

  it("no recibe promociones adicionales: una línea con pack UNIT pierde el pack al fijar el precio a mano", () => {
    const ham = { productId: "ham", productName: "Hamburguesa", pricePerKgCents: 100_000n };
    const packLine = buildUnitTicketLine(ham, 40, "ham-line", hamburguesaPack, "CASH", SURCHARGE_BPS);
    expect(packLine.subtotalCents).toBe(2_800_000n);
    expect(packLine.promotionMode).toBe("PACK_FIXED_TOTAL");
    const manual = applyManualPrice(packLine, 90_000n);
    expect(manual).toMatchObject({ promotionMode: null, discountRuleId: null, promotionDiscountCents: 0n, subtotalCents: 3_600_000n });
    // Y al repreciar con un pack vigente en el contexto, la línea manual NO vuelve a recibirlo.
    expect(repriceTicketLine(manual, context("CASH", [hamburguesaPack])).subtotalCents).toBe(3_600_000n);
  });

  it("no recibe una promoción por umbral: se cobra exactamente el precio fijado por kg", () => {
    const line = buildWeightTicketLine(vacio, 2_500, "w", false, null, [vacioThreshold], BRANCH, "CASH", SURCHARGE_BPS);
    const manual = applyManualPrice(line, 1_450_000n);
    expect(manual.subtotalCents).toBe(3_625_000n);
    expect(repriceTicketLine(manual, context("CASH", [vacioThreshold])).subtotalCents).toBe(3_625_000n);
  });

  it("cambio CASH <-> tarjeta: la línea manual no se mueve, la normal sí", () => {
    const manual = applyManualPrice(unitLine("CASH"), 1_000_000n);
    const normal = unitLine("CASH", 1, { productId: "fanta", productName: "Fanta", pricePerKgCents: 1_400_000n });
    const toCard = [manual, normal].map((line) => repriceTicketLine(line, context("DEBIT")));
    expect(toCard[0]?.subtotalCents).toBe(1_000_000n);
    expect(toCard[0]?.cardSurchargeCents).toBe(0n);
    expect(toCard[1]?.subtotalCents).toBe(1_540_000n);
    const toCash = toCard.map((line) => repriceTicketLine(line, context("CASH")));
    expect(toCash[0]?.subtotalCents).toBe(1_000_000n);
    expect(toCash[1]?.subtotalCents).toBe(1_400_000n);
    // Mercado Pago es TRANSFER (mismo precio que efectivo): tampoco mueve la manual.
    expect(repriceTicketLine(manual, context("TRANSFER")).subtotalCents).toBe(1_000_000n);
  });

  it("restaurar 'Usar precio normal' vuelve al motor de siempre con el medio de pago actual", () => {
    const manual = applyManualPrice(unitLine("CASH"), 1_000_000n);
    const cash = restoreNormalPrice(manual, context("CASH"));
    expect(cash).toMatchObject({ subtotalCents: 1_200_000n, pricePerKgCents: 1_200_000n, cardSurchargeCents: 0n });
    expect(cash.manualPriceApplied).toBeUndefined();
    expect(cash.manualUnitPriceCents).toBeUndefined();
    expect(cash.manualAdjustmentCents).toBeUndefined();
    expect(restoreNormalPrice(manual, context("DEBIT")).subtotalCents).toBe(1_320_000n);
    const manualWeight = applyManualPrice(buildWeightTicketLine(vacio, 1_250, "w", false, null, noDiscounts, BRANCH, "CASH", SURCHARGE_BPS), 1_300_000n);
    const restoredWeight = restoreNormalPrice(manualWeight, context("DEBIT"));
    expect(restoredWeight.subtotalCents).toBe(2_062_500n); // 1,25 kg a $16.500/kg (15.000 + 10%)
    expect(restoredWeight.manualPriceApplied).toBeUndefined();
    expect(restoredWeight.id).toBe("w");
  });

  it("restaurar una línea UNIT con pack vigente recupera el pack automático", () => {
    const ham = { productId: "ham", productName: "Hamburguesa", pricePerKgCents: 100_000n };
    const manual = applyManualPrice(buildUnitTicketLine(ham, 40, "h", hamburguesaPack, "CASH", SURCHARGE_BPS), 90_000n);
    expect(restoreNormalPrice(manual, context("CASH", [hamburguesaPack])).subtotalCents).toBe(2_800_000n);
  });

  it("carryManualPrice no inventa un precio manual cuando la línea anterior era normal", () => {
    const next = unitLine("CASH", 2);
    expect(carryManualPrice(unitLine("CASH"), next)).toBe(next);
    expect(carryManualPrice(undefined, next)).toBe(next);
  });
});

describe("Usar precio normal conserva 'Vender como pack' (D-061)", () => {
  const vacioPack: DiscountRule = {
    id: "pack-vacio", productId: "vacio", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
    discountValue: null, packQuantityGrams: 2_000, packQuantityUnits: null, packPriceCents: "1800000"
  };
  const packLine = (method: PricingContext["paymentMethod"] = "CASH") =>
    buildWeightTicketLine(vacio, 2_050, "w", true, vacioPack, [vacioPack], BRANCH, method, SURCHARGE_BPS);

  it("una línea vendida como pack recuerda el estado aunque el precio manual anule la promoción", () => {
    const pack = packLine();
    expect(pack).toMatchObject({ promotionMode: "PACK_FIXED_TOTAL", sellAsPack: true, subtotalCents: 1_800_000n });
    const manual = applyManualPrice(pack, 1_300_000n);
    expect(manual).toMatchObject({ promotionMode: null, discountRuleId: null, sellAsPack: true, manualPriceApplied: true });
  });

  it("restaurar el precio normal vuelve exactamente a la línea pack, en efectivo y con tarjeta", () => {
    const manual = applyManualPrice(packLine(), 1_300_000n);
    const cash = restoreNormalPrice(manual, context("CASH", [vacioPack]));
    expect(cash).toMatchObject({ promotionMode: "PACK_FIXED_TOTAL", discountRuleId: "pack-vacio", sellAsPack: true, subtotalCents: 1_800_000n, weightGrams: 2_050 });
    expect(cash.manualPriceApplied).toBeUndefined();
    expect(cash).toEqual(packLine());
    const card = restoreNormalPrice(manual, context("DEBIT", [vacioPack]));
    expect(card).toMatchObject({ promotionMode: "PACK_FIXED_TOTAL", sellAsPack: true, subtotalCents: 1_980_000n });
    expect(card).toEqual(packLine("DEBIT"));
  });

  it("restaurar NO activa el pack en una línea que no se vendía como pack", () => {
    const plain = buildWeightTicketLine(vacio, 2_050, "w", false, null, [vacioPack], BRANCH, "CASH", SURCHARGE_BPS);
    expect(plain.sellAsPack).toBeUndefined();
    const restored = restoreNormalPrice(applyManualPrice(plain, 1_300_000n), context("CASH", [vacioPack]));
    expect(restored.promotionMode).toBeNull();
    expect(restored.sellAsPack).toBeUndefined();
    expect(restored.subtotalCents).toBe(plain.subtotalCents);
  });

  it("editar el peso de una línea manual-pack conserva el estado del pack y el precio manual", () => {
    const manual = applyManualPrice(packLine(), 1_300_000n);
    const edited = carryManualPrice(manual, buildWeightTicketLine(vacio, 2_500, "w", true, vacioPack, [vacioPack], BRANCH, "CASH", SURCHARGE_BPS));
    expect(edited).toMatchObject({ manualPriceApplied: true, sellAsPack: true, promotionMode: null, subtotalCents: 3_250_000n });
    expect(restoreNormalPrice(edited, context("CASH", [vacioPack]))).toMatchObject({ promotionMode: "PACK_FIXED_TOTAL", sellAsPack: true, subtotalCents: 1_800_000n });
  });

  it("si el pack ya no existe al restaurar, la línea vuelve al precio normal sin pack", () => {
    const restored = restoreNormalPrice(applyManualPrice(packLine(), 1_300_000n), context("CASH", []));
    expect(restored.promotionMode).toBeNull();
    expect(restored.sellAsPack).toBeUndefined();
  });
});

describe("descuento general del ticket (D-061)", () => {
  function ticketOf(method: PricingContext["paymentMethod"]): TicketLine[] {
    return [
      applyManualPrice(unitLine(method), 1_000_000n),
      unitLine(method, 1, { productId: "fanta", productName: "Fanta", pricePerKgCents: 1_400_000n })
    ].map((line) => repriceTicketLine(line, context(method)));
  }
  const bps = (text: string): bigint => {
    const parsed = parseDiscountPercent(text);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.bps;
  };

  it("5% sobre $24.000: descuenta $1.200 y cobra $22.800", () => {
    expect(summarizeTicket(ticketOf("CASH"), bps("5"))).toMatchObject({ subtotalCents: 2_400_000n, discountCents: 120_000n, totalCents: 2_280_000n, hasManualPrice: true });
  });

  it("10% sobre $24.000", () => {
    expect(summarizeTicket(ticketOf("CASH"), bps("10"))).toMatchObject({ discountCents: 240_000n, totalCents: 2_160_000n });
  });

  it("0 elimina el descuento", () => {
    expect(summarizeTicket(ticketOf("CASH"), bps("0"))).toMatchObject({ discountCents: 0n, totalCents: 2_400_000n });
    expect(summarizeTicket(ticketOf("CASH"), bps(""))).toMatchObject({ discountCents: 0n, totalCents: 2_400_000n });
  });

  it("decimales (12,5) y el recálculo inmediato al editar el porcentaje", () => {
    const ticket = ticketOf("CASH");
    expect(summarizeTicket(ticket, bps("12,5"))).toMatchObject({ discountCents: 300_000n, totalCents: 2_100_000n });
    expect(summarizeTicket(ticket, bps("7"))).toMatchObject({ discountCents: 168_000n, totalCents: 2_232_000n });
  });

  it("cambio de medio: el subtotal se recalcula (la línea normal sube con tarjeta, la manual no) y el 5% se conserva", () => {
    const cash = summarizeTicket(ticketOf("CASH"), bps("5"));
    const card = summarizeTicket(ticketOf("DEBIT"), bps("5"));
    expect(card.subtotalCents).toBe(2_540_000n); // 10.000 manual + 14.000 + 10% = 15.400
    expect(card.discountCents).toBe(127_000n);
    expect(card.totalCents).toBe(2_413_000n);
    expect(cash.totalCents).toBe(2_280_000n);
    expect(summarizeTicket(ticketOf("CASH"), bps("5"))).toEqual(cash);
  });

  it("redondeos: el importe descontado es half-up y subtotal = total + descuento", () => {
    const line: TicketLine = { id: "l", productId: "p", productName: "P", weightGrams: 0, quantityUnits: 1, pricePerKgCents: 123_457n, originalPricePerKgCents: 123_457n, subtotalCents: 123_457n };
    const summary = summarizeTicket([line], bps("7,25"));
    expect(summary.discountCents).toBe(8_951n);
    expect(summary.discountCents + summary.totalCents).toBe(123_457n);
    expect(summary).toEqual({ ...calculateTicketDiscount(123_457n, 725n), hasManualPrice: false });
  });

  it("100% no se acepta (el modelo no admite ventas de $0) y 99,99% sí, con decimales", () => {
    expect(parseDiscountPercent("100")).toEqual({ ok: false, message: "El descuento tiene que ser menor a 100%." });
    expect(parseDiscountPercent("100,00").ok).toBe(false);
    const summary = summarizeTicket(ticketOf("CASH"), bps("99,99"));
    expect(summary.totalCents).toBe(240n);
    expect(summary.discountCents + summary.totalCents).toBe(2_400_000n);
  });
});
