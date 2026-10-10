import type { BranchUnitPromotion } from "@carnicerias/business-logic";
import { createOfflineSale } from "@carnicerias/sync";
import { describe, expect, it } from "vitest";

import {
  appliedQuantityTier, applyManualPrice, buildUnitTicketLine, buildWeightTicketLine, repriceTicketLine, restoreNormalPrice, summarizeTicket, unitPromotionLabel,
  type DiscountRule, type PricingContext
} from "./ticket-pricing";

// Descuentos por cantidad con escalones (D-083). Dinero en centavos: $1.000 = 100_000n. Recargo de tarjeta configurado: 10 %.
const BRANCH = "avenida";
const CARD_BPS = 1_000n;
const leche = { productId: "leche", productName: "Leche", pricePerKgCents: 100_000n };
const vacio = { productId: "vacio", productName: "Vacío", pricePerKgCents: 1_500_000n };
const T3: BranchUnitPromotion = { id: "tier-3", minimumUnits: 3, discountBps: 1_500 };
const T5: BranchUnitPromotion = { id: "tier-5", minimumUnits: 5, discountBps: 2_000 };
const TIERS = [T3, T5];

const unit = (units: number, method: PricingContext["paymentMethod"] = "CASH", tiers: readonly BranchUnitPromotion[] = TIERS, extra: Parameters<typeof buildUnitTicketLine>[6] = {}) =>
  buildUnitTicketLine(leche, units, `l-${String(units)}`, null, method, CARD_BPS, { branchPromotions: tiers, ...extra });
const context = (method: PricingContext["paymentMethod"], tiers: readonly BranchUnitPromotion[] = TIERS, discounts: DiscountRule[] = []): PricingContext =>
  ({ paymentMethod: method, discounts, cashDiscountBps: CARD_BPS, branchId: BRANCH, branchPromotions: tiers });

describe("POS: 2 / 3 / 4 / 5 / 6 / 10 unidades con 3 → 15 % y 5 → 20 %", () => {
  it.each([
    [1, 100_000n, 0n, ""],
    [2, 200_000n, 0n, ""],
    [3, 255_000n, 45_000n, "tier-3"],
    [4, 340_000n, 60_000n, "tier-3"],
    [5, 400_000n, 100_000n, "tier-5"],
    [6, 480_000n, 120_000n, "tier-5"],
    [10, 800_000n, 200_000n, "tier-5"]
  ])("%i unidades de $1.000: total %s, descuento %s, escalón «%s»", (units, total, discount, tierId) => {
    const line = unit(units);
    expect(line.subtotalCents).toBe(total);
    expect(line.promotionDiscountCents).toBe(discount);
    expect(line.branchPromotionId ?? "").toBe(tierId);
    if (tierId) expect(line.branchPromotionDiscountedUnits).toBe(units);
  });

  it("la línea guarda como snapshot el mínimo y el porcentaje del escalón aplicado (no el de otro)", () => {
    expect(unit(4)).toMatchObject({ branchPromotionId: "tier-3", branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1_500, branchPromotionDiscountCents: 60_000n });
    expect(unit(5)).toMatchObject({ branchPromotionId: "tier-5", branchPromotionMinimumUnits: 5, branchPromotionDiscountBps: 2_000, branchPromotionDiscountCents: 100_000n });
  });

  it("los escalones nunca se acumulan: 5 unidades cuestan $4.000, no $3.400", () => {
    expect(unit(5).subtotalCents).toBe(400_000n);
  });

  it("sin escalones (o POS sin la configuración) no hay descuento", () => {
    expect(unit(10, "CASH", []).subtotalCents).toBe(1_000_000n);
    expect(unit(10, "CASH", []).branchPromotionId).toBeUndefined();
  });

  it("con tarjeta: el recargo del 10 % se suma UNA vez sobre el total ya descontado del escalón", () => {
    expect(unit(5, "DEBIT")).toMatchObject({ subtotalCents: 440_000n, cardSurchargeCents: 40_000n, branchPromotionId: "tier-5" });
    expect(unit(3, "CREDIT")).toMatchObject({ subtotalCents: 280_500n, cardSurchargeCents: 25_500n, branchPromotionId: "tier-3" });
  });

  it("cambiar el medio de pago recalcula con el escalón vigente y volver a efectivo deja la línea idéntica", () => {
    const cash = unit(6);
    const card = repriceTicketLine(cash, context("DEBIT"));
    expect(card.subtotalCents).toBe(528_000n);
    expect(repriceTicketLine(card, context("CASH"))).toEqual(cash);
  });

  it("al cambiar la cantidad de la línea el escalón sube o baja con ella", () => {
    expect(unit(4).branchPromotionId).toBe("tier-3");
    expect(unit(5).branchPromotionId).toBe("tier-5");
    expect(unit(2).branchPromotionId).toBeUndefined();
  });

  it("el total del ticket suma cada línea con SU escalón (cada producto se evalúa por separado)", () => {
    const coca = { productId: "coca", productName: "Coca", pricePerKgCents: 120_000n };
    const lines = [unit(5), buildUnitTicketLine(coca, 2, "c", null, "CASH", CARD_BPS, { branchPromotions: TIERS }), unit(3)];
    expect(summarizeTicket(lines, 0n).totalCents).toBe(400_000n + 240_000n + 255_000n);
  });
});

describe("POS: precedencia — el escalón no se acumula ni pisa lo que ya tenía prioridad", () => {
  const lechePackRule: DiscountRule = {
    id: "pack-fijo", productId: "leche", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
    discountValue: null, packQuantityGrams: null, packQuantityUnits: 6, packPriceCents: "450000"
  };

  it("una venta como PACK (con el % del pack) no recibe además el escalón", () => {
    const pack = unit(8, "CASH", TIERS, { packSale: { packCount: 1, packSizeUnits: 8, packDiscountBps: 2_500, packConfigId: "cfg-8" } });
    expect(pack).toMatchObject({ soldAsPack: true, packDiscountBps: 2_500, subtotalCents: 600_000n });
    expect(pack.branchPromotionId).toBeUndefined();
    // Las mismas 8 unidades sueltas: el mayor escalón (20 %) y NO el 25 % del pack.
    expect(unit(8).subtotalCents).toBe(640_000n);
  });

  it("la promoción específica del producto (pack fijo $4.500 por 6 u) gana al escalón: nunca se suman", () => {
    const line = buildUnitTicketLine(leche, 6, "p", lechePackRule, "CASH", CARD_BPS, { branchPromotions: TIERS });
    expect(line.promotionMode).toBe("PACK_FIXED_TOTAL");
    expect(line.subtotalCents).toBe(450_000n);
    expect(line.branchPromotionId).toBeUndefined();
    // Con 7 unidades: 1 pack de 6 a precio fijo + 1 suelta a precio normal, sin el escalón sobre la suelta.
    expect(buildUnitTicketLine(leche, 7, "p7", lechePackRule, "CASH", CARD_BPS, { branchPromotions: TIERS }).subtotalCents).toBe(550_000n);
    // Con menos unidades que el pack el escalón sí aplica.
    expect(buildUnitTicketLine(leche, 5, "p5", lechePackRule, "CASH", CARD_BPS, { branchPromotions: TIERS })).toMatchObject({ branchPromotionId: "tier-5", subtotalCents: 400_000n });
  });

  it("el precio manual (Central) quita el escalón y «Usar precio normal» lo vuelve a calcular", () => {
    const base = unit(5);
    const manual = applyManualPrice(base, 90_000n);
    expect(manual).toMatchObject({ manualPriceApplied: true, subtotalCents: 450_000n });
    expect(manual.branchPromotionId).toBeUndefined();
    expect(restoreNormalPrice(manual, context("CASH"))).toMatchObject({ branchPromotionId: "tier-5", subtotalCents: 400_000n });
  });

  it("un precio manual no se recalcula al cambiar el medio de pago ni toma el escalón", () => {
    const manual = applyManualPrice(unit(5), 90_000n);
    expect(repriceTicketLine(manual, context("DEBIT"))).toBe(manual);
  });
});

describe("POS: los productos por PESO no reciben la regla de unidades", () => {
  it("un producto WEIGHT de 5 kg con escalones configurados no tiene descuento por cantidad", () => {
    const line = buildWeightTicketLine(vacio, 5_000, "w", false, null, [], BRANCH, "CASH", CARD_BPS);
    expect(line.subtotalCents).toBe(7_500_000n);
    expect(line.branchPromotionId).toBeUndefined();
    const repriced = repriceTicketLine(line, context("CASH"));
    expect(repriced.subtotalCents).toBe(7_500_000n);
    expect(repriced.branchPromotionId).toBeUndefined();
    expect(restoreNormalPrice(line, context("CASH")).subtotalCents).toBe(7_500_000n);
  });
});

describe("POS: histórico y cambios de configuración", () => {
  const base = { organizationId: "org", branchId: BRANCH, profileId: "p", deviceId: "d", now: new Date("2026-10-10T12:00:00Z") };
  let sequence = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

  it("la venta offline lleva el id, el mínimo y el porcentaje del escalón con el que se hizo (el servidor lo valida contra SU regla)", () => {
    const sale = createOfflineSale({ ...base, ticket: [unit(5), unit(3)], paymentMethod: "CASH", createId });
    expect(sale.items[0]).toMatchObject({
      quantityUnits: 5, branchPromotionId: "tier-5", branchPromotionMinimumUnits: 5, branchPromotionDiscountBps: 2_000, branchPromotionDiscountedUnits: 5,
      branchPromotionDiscountCents: "100000", subtotalCents: "400000"
    });
    expect(sale.items[1]).toMatchObject({ quantityUnits: 3, branchPromotionId: "tier-3", branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1_500, subtotalCents: "255000" });
    expect(sale.totalCents).toBe("655000");
  });

  it("una línea sin escalón no envía campos de promoción", () => {
    const sale = createOfflineSale({ ...base, ticket: [unit(2)], paymentMethod: "CASH", createId });
    expect(sale.items[0] && "branchPromotionId" in sale.items[0]).toBe(false);
  });

  it("modificar los escalones sólo afecta líneas NUEVAS: la ya vendida conserva su snapshot", () => {
    const sold = createOfflineSale({ ...base, ticket: [unit(5)], paymentMethod: "CASH", createId });
    const newTiers: BranchUnitPromotion[] = [{ id: "tier-3b", minimumUnits: 3, discountBps: 2_000 }, { id: "tier-5b", minimumUnits: 5, discountBps: 3_000 }];
    const fresh = createOfflineSale({ ...base, ticket: [unit(5, "CASH", newTiers)], paymentMethod: "CASH", createId });
    expect(sold.items[0]).toMatchObject({ branchPromotionId: "tier-5", branchPromotionDiscountBps: 2_000, subtotalCents: "400000" });
    expect(fresh.items[0]).toMatchObject({ branchPromotionId: "tier-5b", branchPromotionDiscountBps: 3_000, subtotalCents: "350000" });
  });

  it("las líneas ya armadas en el ticket se recalculan con los escalones vigentes cuando el POS recibe la configuración nueva", () => {
    const stale = unit(5);
    const updated = repriceTicketLine(stale, context("CASH", [{ id: "tier-5b", minimumUnits: 5, discountBps: 3_000 }]));
    expect(updated).toMatchObject({ branchPromotionId: "tier-5b", subtotalCents: 350_000n });
  });
});

describe("POS: textos de los escalones", () => {
  it("la etiqueta del catálogo muestra el precio por unidad de cada escalón", () => {
    expect(unitPromotionLabel(100_000n, TIERS)).toBe("$ 850/u desde 3 u · $ 800/u desde 5 u");
    expect(unitPromotionLabel(100_000n, [T3])).toBe("$ 850/u desde 3 u");
    expect(unitPromotionLabel(100_000n, [])).toBeNull();
  });

  it("appliedQuantityTier devuelve el escalón que recibiría una cantidad", () => {
    expect([1, 2, 3, 4, 5, 9].map((units) => appliedQuantityTier(TIERS, units)?.id ?? null)).toEqual([null, null, "tier-3", "tier-3", "tier-5", "tier-5"]);
    expect(appliedQuantityTier(TIERS, 0)).toBeNull();
  });
});
