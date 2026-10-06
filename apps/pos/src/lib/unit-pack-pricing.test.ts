import type { BranchUnitPromotion } from "@carnicerias/business-logic";
import { createOfflineSale } from "@carnicerias/sync";
import type { TicketLine } from "@carnicerias/types";
import { describe, expect, it } from "vitest";

import {
  applyManualPrice, buildUnitTicketLine, carryManualPrice, describeUnitLine, findMergeableUnitLine, repriceTicketLine, resolveUnitLineRequest,
  restoreNormalPrice, summarizeTicket, unitModalState, type DiscountRule, type PricingContext
} from "./ticket-pricing";

// Dinero en centavos: $1.000 = 100_000n. Recargo de tarjeta configurado: 10 %.
const BRANCH = "central";
const CARD_BPS = 1_000n;
const leche = { productId: "leche", productName: "Leche", pricePerKgCents: 100_000n };
const coca = { productId: "coca", productName: "Coca Cola 2.25 L", pricePerKgCents: 120_000n };
const FROM_3_15: BranchUnitPromotion = { id: "promo-central", minimumUnits: 3, discountBps: 1_500 };
const PACK_8 = { packCount: 1, packSizeUnits: 8, packDiscountBps: 2_000 };
const lechePackRule: DiscountRule = {
  id: "pack-leche", productId: "leche", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
  discountValue: null, packQuantityGrams: null, packQuantityUnits: 4, packPriceCents: "300000"
};

function context(paymentMethod: PricingContext["paymentMethod"], branchPromotion: BranchUnitPromotion | null = FROM_3_15, discounts: DiscountRule[] = []): PricingContext {
  return { paymentMethod, discounts, cashDiscountBps: CARD_BPS, branchId: BRANCH, branchPromotion };
}

function normal(quantity: number, method: PricingContext["paymentMethod"] = "CASH", promotion: BranchUnitPromotion | null = FROM_3_15, product = leche, pack: DiscountRule | null = null): TicketLine {
  return buildUnitTicketLine(product, quantity, `n-${product.productId}-${String(quantity)}`, pack, method, CARD_BPS, { branchPromotion: promotion });
}

/** La versión del pack que el catálogo le da al POS para ese tamaño y ese porcentaje (en la vida real la crea el servidor). */
const packConfigFor = (packSizeUnits: number, packDiscountBps = 2_000) => packDiscountBps === 2_000 ? `cfg-${String(packSizeUnits)}` : `cfg-${String(packSizeUnits)}-${String(packDiscountBps)}`;

function packLine(packCount: number, method: PricingContext["paymentMethod"] = "CASH", packSizeUnits = 8, promotion: BranchUnitPromotion | null = FROM_3_15, packDiscountBps = 2_000, product = leche): TicketLine {
  return buildUnitTicketLine(product, packCount * packSizeUnits, `p-${product.productId}-${String(packCount)}`, null, method, CARD_BPS, {
    branchPromotion: promotion, packSale: { packCount, packSizeUnits, packDiscountBps, packConfigId: packConfigFor(packSizeUnits, packDiscountBps) }
  });
}

describe("promoción de sucursal: DESDE 3 unidades, 15 % sobre toda la línea", () => {
  it.each([
    [1, 100_000n, 0], [2, 200_000n, 0], [3, 255_000n, 3], [4, 340_000n, 4], [5, 425_000n, 5], [6, 510_000n, 6], [8, 680_000n, 8], [20, 1_700_000n, 20]
  ])("%i unidad(es) → subtotal %s con %i unidades descontadas", (quantity, subtotal, discounted) => {
    const line = normal(quantity);
    expect(line.subtotalCents).toBe(subtotal);
    expect(line.quantityUnits).toBe(quantity);
    expect(line.branchPromotionDiscountedUnits ?? 0).toBe(discounted);
    expect(line.branchPromotionId).toBe(discounted > 0 ? "promo-central" : undefined);
    expect(line.soldAsPack).toBeUndefined();
  });

  it("una línea con 1 o 2 unidades no lleva ningún snapshot de promoción", () => {
    for (const quantity of [1, 2]) {
      const line = normal(quantity);
      expect(line.branchPromotionId).toBeUndefined();
      expect(line.promotionDiscountCents).toBe(0n);
    }
  });

  it("no suma productos distintos: 2 leches + 1 coca no activan la promoción", () => {
    const ticket = [normal(2), normal(1, "CASH", FROM_3_15, coca)];
    expect(ticket.every((line) => line.branchPromotionId === undefined)).toBe(true);
    expect(summarizeTicket(ticket, 0n).subtotalCents).toBe(200_000n + 120_000n);
  });

  it("evalúa cada producto por separado: 3 leches reciben el 15 % y 2 cocas del mismo ticket no", () => {
    const ticket = [normal(3), normal(2, "CASH", FROM_3_15, coca)];
    expect(ticket[0]?.branchPromotionDiscountedUnits).toBe(3);
    expect(ticket[1]?.branchPromotionId).toBeUndefined();
    expect(summarizeTicket(ticket, 0n).subtotalCents).toBe(255_000n + 240_000n);
  });

  it("4 unidades de $1.000: base $4.000, descuento -$600, total $3.400; 8 unidades: -$1.200, total $6.800", () => {
    expect(normal(4)).toMatchObject({ subtotalCents: 340_000n, promotionDiscountCents: 60_000n, branchPromotionDiscountedUnits: 4 });
    expect(normal(8)).toMatchObject({ subtotalCents: 680_000n, promotionDiscountCents: 120_000n, branchPromotionDiscountedUnits: 8 });
  });

  it("sin promoción en la sucursal (otra sucursal, o inactiva) la línea sigue a precio normal", () => {
    expect(normal(8, "CASH", null).subtotalCents).toBe(800_000n);
  });

  it("la tarjeta recarga el total comercial ya descontado, una sola vez", () => {
    const cash = normal(8, "CASH");
    const card = normal(8, "DEBIT");
    expect(card.subtotalCents).toBe(748_000n);
    expect(card.cardSurchargeCents).toBe(68_000n);
    expect(card.promotionDiscountCents).toBe(cash.promotionDiscountCents);
    // Cambiar el medio de pago del ticket no compone el recargo ni pierde la promoción.
    const back = repriceTicketLine(repriceTicketLine(cash, context("DEBIT")), context("CASH"));
    expect(back).toEqual(cash);
    expect(repriceTicketLine(card, context("DEBIT"))).toEqual(card);
  });

  it("repreciar con la promoción retirada la quita; con otra promoción usa la nueva", () => {
    const cash = normal(6);
    expect(repriceTicketLine(cash, context("CASH", null)).subtotalCents).toBe(600_000n);
    expect(repriceTicketLine(cash, context("CASH", null)).branchPromotionId).toBeUndefined();
    expect(repriceTicketLine(cash, context("CASH", { id: "p2", minimumUnits: 2, discountBps: 1_000 })).subtotalCents).toBe(540_000n);
  });
});

describe("Pack (descuento propio de cada producto, unidades reales)", () => {
  it("1 pack de 8 × $1.000 → 8 unidades reales y $6.400", () => {
    const line = packLine(1);
    expect(line.quantityUnits).toBe(8);
    expect(line.subtotalCents).toBe(640_000n);
    expect(line).toMatchObject({ soldAsPack: true, packCount: 1, packSizeUnitsSnapshot: 8, packDiscountBps: 2_000, packDiscountCents: 160_000n, promotionDiscountCents: 160_000n });
    expect(line.branchPromotionId).toBeUndefined();
  });

  it("2 packs → 16 unidades reales y $12.800", () => {
    const line = packLine(2);
    expect(line.quantityUnits).toBe(16);
    expect(line.subtotalCents).toBe(1_280_000n);
    expect(line.packDiscountCents).toBe(320_000n);
  });

  it("aplica exactamente su % y NO recibe además la promoción desde 3 (no hay acumulación)", () => {
    const asPack = packLine(1);
    expect(asPack.subtotalCents).toBe(800_000n - 800_000n / 5n);
    // Si se acumularan, 8 unidades quedarían en menos de $6.400; vendidas como Pack son exactamente $6.400.
    expect(asPack.subtotalCents).toBe(640_000n);
    // La venta normal de las mismas 8 unidades recibe el 15 % en TODAS (no 3+3 con 2 normales).
    const normalEight = normal(8);
    expect(normalEight.subtotalCents).toBe(680_000n);
    expect(normalEight.branchPromotionDiscountedUnits).toBe(8);
    expect(normalEight.packCount).toBeUndefined();
  });

  it("cada producto usa SU porcentaje: Leche A 20 %, Leche B 25 %, Producto C (12 u) 15 %", () => {
    const milkB = { productId: "leche-b", productName: "Leche B", pricePerKgCents: 100_000n };
    const productC = { productId: "prod-c", productName: "Producto C", pricePerKgCents: 100_000n };
    const a = packLine(1, "CASH", 8, FROM_3_15, 2_000);
    const b = packLine(1, "CASH", 8, FROM_3_15, 2_500, milkB);
    const c = packLine(1, "CASH", 12, FROM_3_15, 1_500, productC);
    expect([a.subtotalCents, b.subtotalCents, c.subtotalCents]).toEqual([640_000n, 600_000n, 1_020_000n]);
    expect([a.packDiscountBps, b.packDiscountBps, c.packDiscountBps]).toEqual([2_000, 2_500, 1_500]);
    expect(summarizeTicket([a, b, c], 0n).subtotalCents).toBe(2_260_000n);
  });

  it("ejemplo: $1.000 por unidad, pack de 8 al 25 % → base $8.000, descuento $2.000, total $6.000; la promoción desde 3 no se suma", () => {
    const line = packLine(1, "CASH", 8, FROM_3_15, 2_500);
    expect(line).toMatchObject({ quantityUnits: 8, soldAsPack: true, packDiscountBps: 2_500, packDiscountCents: 200_000n, promotionDiscountCents: 200_000n, subtotalCents: 600_000n });
    expect(line.branchPromotionId).toBeUndefined();
    // La misma venta SIN pack toma la promoción de sucursal (15 %), nunca -25 % y después -15 %.
    expect(normal(8).subtotalCents).toBe(680_000n);
  });

  it("el pack gana también a la promoción específica del producto (no se acumulan)", () => {
    const withRule = buildUnitTicketLine(leche, 8, "p", lechePackRule, "CASH", CARD_BPS, { branchPromotion: FROM_3_15, packSale: PACK_8 });
    expect(withRule.subtotalCents).toBe(640_000n);
    expect(withRule.promotionMode).toBeNull();
    expect(withRule.discountRuleId).toBeNull();
  });

  it("el recargo de tarjeta va después del pack, y el descuento general del ticket después de todo", () => {
    const card = packLine(1, "DEBIT");
    expect(card.subtotalCents).toBe(704_000n);
    expect(card.cardSurchargeCents).toBe(64_000n);
    const summary = summarizeTicket([packLine(1)], 500n);
    expect(summary).toMatchObject({ subtotalCents: 640_000n, discountCents: 32_000n, totalCents: 608_000n });
  });

  it("repreciar usa el snapshot de la propia línea, nunca el tamaño actual del producto", () => {
    const line = packLine(1, "CASH", 8);
    const card = repriceTicketLine(line, context("DEBIT"));
    expect(card.packSizeUnitsSnapshot).toBe(8);
    expect(card.quantityUnits).toBe(8);
    expect(card.subtotalCents).toBe(704_000n);
    expect(repriceTicketLine(card, context("CASH"))).toEqual(line);
  });

  it("un pack con cantidad que no es packCount × tamaño es un error", () => {
    expect(() => buildUnitTicketLine(leche, 7, "bad", null, "CASH", CARD_BPS, { packSale: PACK_8 })).toThrow(RangeError);
  });

  it("la línea describe el pack claramente", () => {
    expect(describeUnitLine(packLine(1))).toEqual({ quantityLabel: "1 pack × 8 u = 8 unidades", badge: "Pack 20% OFF" });
    expect(describeUnitLine(packLine(2)).quantityLabel).toBe("2 packs × 8 u = 16 unidades");
    expect(describeUnitLine(packLine(1, "CASH", 8, FROM_3_15, 2_500)).badge).toBe("Pack 25% OFF");
    expect(describeUnitLine(packLine(1, "CASH", 6, FROM_3_15, 1_250)).badge).toBe("Pack 12,5% OFF");
    expect(describeUnitLine(normal(8))).toEqual({ quantityLabel: "8 u", badge: null }); // el ahorro se lee en el precio/u final
    expect(describeUnitLine(normal(2))).toEqual({ quantityLabel: "2 u", badge: null });
  });
});

describe("precio manual por encima de todo", () => {
  it("anula el pack y la promoción de sucursal (queda el precio fijado, sin descuentos automáticos)", () => {
    for (const line of [packLine(1), normal(6)]) {
      const manual = applyManualPrice(line, 90_000n);
      expect(manual.manualPriceApplied).toBe(true);
      expect(manual.subtotalCents).toBe(90_000n * BigInt(line.quantityUnits ?? 0));
      expect(manual.soldAsPack).toBeUndefined();
      expect(manual.branchPromotionId).toBeUndefined();
      expect(manual.promotionDiscountCents).toBe(0n);
      // Un cambio de medio de pago no la toca.
      expect(repriceTicketLine(manual, context("DEBIT"))).toEqual(manual);
    }
  });

  it("'Usar precio normal' recupera el Pack o la promoción", () => {
    const pack = applyManualPrice(packLine(1), 90_000n);
    expect(pack.packCount).toBe(1);
    expect(restoreNormalPrice(pack, context("CASH")).subtotalCents).toBe(640_000n);
    expect(restoreNormalPrice(pack, context("CASH")).soldAsPack).toBe(true);
    const promo = applyManualPrice(normal(6), 90_000n);
    expect(restoreNormalPrice(promo, context("CASH")).subtotalCents).toBe(510_000n);
  });

  it("editar la cantidad de una línea manual conserva el precio fijado sin reactivar descuentos", () => {
    const manual = applyManualPrice(normal(3), 90_000n);
    const edited = carryManualPrice(manual, normal(6));
    expect(edited.subtotalCents).toBe(540_000n);
    expect(edited.branchPromotionId).toBeUndefined();
  });
});

describe("promoción específica del producto vs promoción de sucursal", () => {
  it("la específica aplicable tiene prioridad (y no se suma la de sucursal)", () => {
    // Pack específico: 4 unidades por $3.000. 8 unidades = 2 packs = $6.000.
    const line = normal(8, "CASH", FROM_3_15, leche, lechePackRule);
    expect(line.promotionMode).toBe("PACK_FIXED_TOTAL");
    expect(line.subtotalCents).toBe(600_000n);
    expect(line.branchPromotionId).toBeUndefined();
  });

  it("si la específica no es aplicable (menos unidades que su pack) rige la de sucursal", () => {
    const line = normal(3, "CASH", FROM_3_15, leche, lechePackRule);
    expect(line.promotionMode).toBeNull();
    expect(line.branchPromotionDiscountedUnits).toBe(3);
    expect(line.subtotalCents).toBe(255_000n);
  });
});

describe("agregar y fusionar líneas UNIT", () => {
  it("el scanner agrega 1 unidad normal: nunca un Pack, aunque el producto tenga pack", () => {
    const scanned = normal(1);
    expect(scanned.quantityUnits).toBe(1);
    expect(scanned.packCount).toBeUndefined();
    expect(scanned.soldAsPack).toBeUndefined();
    expect(scanned.subtotalCents).toBe(100_000n);
  });

  it("editar la línea escaneada y pasarla a Pack la convierte en unidades reales con el % del producto", () => {
    const scanned = normal(1);
    const edited = buildUnitTicketLine(leche, 1 * 8, scanned.id, null, "CASH", CARD_BPS, { branchPromotion: FROM_3_15, packSale: PACK_8 });
    expect(edited.id).toBe(scanned.id);
    expect(edited.quantityUnits).toBe(8);
    expect(edited.subtotalCents).toBe(640_000n);
  });

  it("las unidades del mismo producto se acumulan en UNA línea normal; el Pack y las líneas manuales quedan aparte", () => {
    const manual = applyManualPrice(normal(2), 90_000n);
    const ticket = [packLine(1), manual, normal(2)];
    expect(findMergeableUnitLine(ticket, "leche", false)?.id).toBe(normal(2).id);
    expect(findMergeableUnitLine([packLine(1), manual], "leche", false)).toBeUndefined();
    expect(findMergeableUnitLine(ticket, "leche", true)?.packCount).toBe(1);
    expect(findMergeableUnitLine(ticket, "coca", false)).toBeUndefined();
    // Dos agregados sucesivos (2 + 1) llegan a 3 y activan la promoción, venga de la grilla o del scanner.
    expect(normal(2 + 1).subtotalCents).toBe(255_000n);
  });
});

describe("versión del pack (pack_config_id): viaja con la línea y sobrevive al repricing", () => {
  const base = { organizationId: "org", branchId: BRANCH, profileId: "p", deviceId: "d", now: new Date("2026-10-03T12:00:00Z") };
  const createId = () => "00000000-0000-4000-8000-000000000001";

  it("la línea Pack guarda la versión con la que se armó y repreciar con tarjeta no la pierde", () => {
    const line = packLine(1);
    expect(line.packConfigId).toBe("cfg-8");
    const card = repriceTicketLine(line, context("CREDIT"));
    expect(card).toMatchObject({ packConfigId: "cfg-8", packSizeUnitsSnapshot: 8, soldAsPack: true });
  });

  it("un precio manual conserva la memoria de la versión y 'Usar precio normal' la recupera", () => {
    const manual = applyManualPrice(packLine(1), 90_000n);
    expect(manual).toMatchObject({ manualPriceApplied: true, packConfigId: "cfg-8" });
    expect(restoreNormalPrice(manual, context("CASH"))).toMatchObject({ soldAsPack: true, packConfigId: "cfg-8", subtotalCents: 640_000n });
  });

  it("después de pasar el pack a 12, una venta vieja con la versión de 8 sigue enviando 8; la nueva envía 12", () => {
    const old = createOfflineSale({ ...base, ticket: [packLine(1, "CASH", 8)], paymentMethod: "CASH", createId });
    const fresh = createOfflineSale({ ...base, ticket: [packLine(1, "CASH", 12)], paymentMethod: "CASH", createId });
    expect(old.items[0]).toMatchObject({ quantityUnits: 8, packSizeUnitsSnapshot: 8, packConfigId: "cfg-8", subtotalCents: "640000" });
    expect(fresh.items[0]).toMatchObject({ quantityUnits: 12, packSizeUnitsSnapshot: 12, packConfigId: "cfg-12", subtotalCents: "960000" });
  });

  it("repreciar con tarjeta y 'Usar precio normal' conservan el % de la versión (25 %), no vuelven al 20 %", () => {
    const line = packLine(1, "CASH", 8, FROM_3_15, 2_500);
    expect(line).toMatchObject({ packConfigId: "cfg-8-2500", packDiscountBps: 2_500, subtotalCents: 600_000n });
    const card = repriceTicketLine(line, context("DEBIT"));
    expect(card).toMatchObject({ packConfigId: "cfg-8-2500", packDiscountBps: 2_500, subtotalCents: 660_000n });
    expect(repriceTicketLine(card, context("CASH"))).toEqual(line);
    const manual = applyManualPrice(line, 90_000n);
    expect(manual).toMatchObject({ manualPriceApplied: true, packDiscountBps: 2_500, packConfigId: "cfg-8-2500" });
    expect(restoreNormalPrice(manual, context("CASH"))).toMatchObject({ soldAsPack: true, packDiscountBps: 2_500, subtotalCents: 600_000n });
  });

  it("Día 1 (pack 8 al 20 %) y Día 2 (pack 8 al 25 %): cada venta envía el % de SU versión", () => {
    const day1 = createOfflineSale({ ...base, ticket: [packLine(1, "CASH", 8, FROM_3_15, 2_000)], paymentMethod: "CASH", createId });
    const day2 = createOfflineSale({ ...base, ticket: [packLine(1, "CASH", 8, FROM_3_15, 2_500)], paymentMethod: "CASH", createId });
    expect(day1.items[0]).toMatchObject({ packSizeUnitsSnapshot: 8, packDiscountBps: 2_000, packDiscountCents: "160000", packConfigId: "cfg-8", subtotalCents: "640000" });
    expect(day2.items[0]).toMatchObject({ packSizeUnitsSnapshot: 8, packDiscountBps: 2_500, packDiscountCents: "200000", packConfigId: "cfg-8-2500", subtotalCents: "600000" });
  });

  it("una línea Pack sin versión no inventa una: el payload la omite y el servidor la rechaza", () => {
    const withoutVersion = Object.fromEntries(Object.entries(packLine(1)).filter(([key]) => key !== "packConfigId")) as unknown as TicketLine;
    const sale = createOfflineSale({ ...base, ticket: [withoutVersion], paymentMethod: "CASH", createId });
    expect(sale.items[0] && "packConfigId" in sale.items[0]).toBe(false);
  });
});

describe("snapshot hacia el servidor (createOfflineSale)", () => {
  const base = { organizationId: "org", branchId: BRANCH, profileId: "p", deviceId: "d", now: new Date("2026-10-03T12:00:00Z") };
  let sequence = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

  it("una línea Pack viaja con unidades reales y su snapshot; las demás líneas no cambian de forma", () => {
    const sale = createOfflineSale({ ...base, ticket: [packLine(2), normal(1, "CASH", FROM_3_15, coca)], paymentMethod: "CASH", createId });
    const [pack, plain] = sale.items;
    expect(pack).toMatchObject({
      quantityUnits: 16, soldAsPack: true, packCount: 2, packSizeUnitsSnapshot: 8, packConfigId: "cfg-8", packDiscountBps: 2_000, packDiscountCents: "320000",
      promotionDiscountCents: "320000", subtotalCents: "1280000"
    });
    expect(pack?.branchPromotionId).toBeUndefined();
    expect(plain && "soldAsPack" in plain).toBe(false);
    expect(plain && "packConfigId" in plain).toBe(false);
    expect(plain && "branchPromotionId" in plain).toBe(false);
    expect(sale.stockMovements[0]?.quantityGrams).toBe("-16");
    expect(sale.totalCents).toBe("1400000");
  });

  it("una línea con la promoción de sucursal viaja con el snapshot de la regla", () => {
    const sale = createOfflineSale({ ...base, ticket: [normal(8)], paymentMethod: "CASH", createId });
    expect(sale.items[0]).toMatchObject({
      quantityUnits: 8, branchPromotionId: "promo-central", branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1_500,
      branchPromotionDiscountedUnits: 8, branchPromotionDiscountCents: "120000", promotionDiscountCents: "120000", subtotalCents: "680000"
    });
    expect(sale.items[0] && "branchPromotionEveryUnits" in sale.items[0]).toBe(false);
    expect(sale.items[0] && "soldAsPack" in sale.items[0]).toBe(false);
    expect(sale.stockMovements[0]?.quantityGrams).toBe("-8");
  });

  it("una línea con precio manual no manda ni pack ni promoción, aunque conserve la memoria del Pack", () => {
    const sale = createOfflineSale({ ...base, ticket: [applyManualPrice(packLine(1), 90_000n)], paymentMethod: "CASH", createId });
    const item = sale.items[0];
    expect(item && "soldAsPack" in item).toBe(false);
    expect(item && "packCount" in item).toBe(false);
    expect(item && "packConfigId" in item).toBe(false);
    expect(item?.manualPriceApplied).toBe(true);
    expect(item?.quantityUnits).toBe(8);
  });

  it("pack + descuento general del ticket: el ticket suma las líneas y descuenta al final", () => {
    const sale = createOfflineSale({ ...base, ticket: [packLine(1)], paymentMethod: "CASH", ticketDiscount: { bps: 500n, cents: 32_000n }, createId });
    expect(sale.totalCents).toBe("608000");
    expect(sale.subtotalCents).toBe("640000");
  });
});

describe("flujo del modal de cantidad (grilla, escáner y edición comparten el mismo componente)", () => {
  const request = (ticket: TicketLine[], overrides: Partial<Parameters<typeof resolveUnitLineRequest>[0]> = {}) =>
    resolveUnitLineRequest({ ticket, productId: "leche", packOffer: { packSizeUnits: 8, packDiscountBps: 2_000, packConfigId: "cfg-8" }, packMode: false, quantity: 1, editingLineId: null, ...overrides });

  it("grilla: 1 pack agrega 8 unidades reales y 2 packs agregan 16", () => {
    expect(request([], { packMode: true, quantity: 1 })).toMatchObject({ units: 8, packSale: { packCount: 1, packSizeUnits: 8, packDiscountBps: 2_000, packConfigId: "cfg-8" }, lineId: "", mergedLine: undefined });
    expect(request([], { packMode: true, quantity: 2 })).toMatchObject({ units: 16, packSale: { packCount: 2, packSizeUnits: 8 } });
    const built = buildUnitTicketLine(leche, 16, "x", null, "CASH", CARD_BPS, { packSale: { packCount: 2, packSizeUnits: 8, packDiscountBps: 2_000 } });
    expect(built.subtotalCents).toBe(1_280_000n);
  });

  it("grilla: un producto sin pack ignora el modo Pack (la cantidad son unidades)", () => {
    expect(request([], { packOffer: null, packMode: true, quantity: 3 })).toMatchObject({ units: 3, packSale: null });
  });

  it("sin la versión del pack o con un % inválido (servidor anterior) no hay Pack: la venta no podría validarse", () => {
    expect(request([], { packOffer: { packSizeUnits: 8, packDiscountBps: 2_000, packConfigId: "" }, packMode: true, quantity: 2 })).toMatchObject({ units: 2, packSale: null });
    expect(request([], { packOffer: { packSizeUnits: 8, packDiscountBps: 10_000, packConfigId: "cfg-8" }, packMode: true, quantity: 2 })).toMatchObject({ units: 2, packSale: null });
    expect(request([], { packOffer: { packSizeUnits: 8, packDiscountBps: -1, packConfigId: "cfg-8" }, packMode: true, quantity: 2 })).toMatchObject({ units: 2, packSale: null });
  });

  it("un Pack con 0 % (D-068) sí se ofrece: carga 2 packs de 8 = 16 unidades reales a precio de lista, sin descuento", () => {
    const offer = { packSizeUnits: 8, packDiscountBps: 0, packConfigId: "cfg-8-0" };
    const req = request([], { packOffer: offer, packMode: true, quantity: 2 });
    expect(req).toMatchObject({ units: 16, packSale: { packCount: 2, packSizeUnits: 8, packDiscountBps: 0 } });
    const line = buildUnitTicketLine(leche, req.units, "x", null, "CASH", CARD_BPS, { packSale: req.packSale });
    expect(line.subtotalCents).toBe(1_600_000n);
    expect(line.promotionDiscountCents).toBe(0n);
    expect(line.soldAsPack).toBe(true);
    expect(line.packDiscountBps).toBe(0);
    // Con tarjeta el recargo sigue aplicando sobre el total de la línea (D-044), también sin descuento.
    expect(buildUnitTicketLine(leche, req.units, "x", null, "DEBIT", CARD_BPS, { packSale: req.packSale }).subtotalCents).toBe(1_760_000n);
  });

  it("el Pack del modal lleva el % del producto: 25 % → 2 packs de 8 son 16 unidades reales y $12.000", () => {
    const offer = { packSizeUnits: 8, packDiscountBps: 2_500, packConfigId: "cfg-8-2500" };
    const req = request([], { packOffer: offer, packMode: true, quantity: 2 });
    expect(req).toMatchObject({ units: 16, packSale: { packCount: 2, packSizeUnits: 8, packDiscountBps: 2_500 } });
    expect(buildUnitTicketLine(leche, req.units, "x", null, "CASH", CARD_BPS, { packSale: req.packSale }).subtotalCents).toBe(1_200_000n);
  });

  it("agregar suma al mismo producto y modo; un Pack y una línea normal no se mezclan", () => {
    const normalLine = normal(2);
    const pack = packLine(1);
    expect(request([normalLine], { quantity: 1 })).toMatchObject({ units: 3, lineId: normalLine.id, packSale: null });
    expect(request([pack], { packMode: true, quantity: 2 })).toMatchObject({ units: 24, lineId: pack.id, packSale: { packCount: 3, packSizeUnits: 8 } });
    expect(request([pack], { quantity: 1 })).toMatchObject({ units: 1, lineId: "", mergedLine: undefined });
    expect(request([normalLine], { packMode: true, quantity: 1 })).toMatchObject({ units: 8, lineId: "", mergedLine: undefined });
  });

  it("modificar una línea la reemplaza (no la fusiona) y conserva su id", () => {
    const scanned = normal(1);
    expect(request([scanned], { editingLineId: scanned.id, quantity: 4 })).toMatchObject({ units: 4, lineId: scanned.id, mergedLine: undefined });
  });

  it("escaneo → editar cantidad: la línea escaneada (1 u normal) se abre con la opción Pack y puede convertirse", () => {
    const scanned = normal(1);
    expect(unitModalState(scanned, 8)).toEqual({ packMode: false, quantity: 1 });
    // Toca Pack con cantidad 1 → 8 unidades reales con 20 %.
    const converted = request([scanned], { editingLineId: scanned.id, packMode: true, quantity: 1 });
    expect(converted).toMatchObject({ units: 8, packSale: { packCount: 1, packSizeUnits: 8 } });
    const line = buildUnitTicketLine(leche, converted.units, scanned.id, null, "CASH", CARD_BPS, { packSale: converted.packSale });
    expect(line).toMatchObject({ id: scanned.id, quantityUnits: 8, subtotalCents: 640_000n, soldAsPack: true });
  });

  it("un producto nuevo abre el modal con 1 unidad normal; una línea Pack se reabre en modo Pack con sus packs", () => {
    expect(unitModalState(undefined, 8)).toEqual({ packMode: false, quantity: 1 });
    expect(unitModalState(packLine(2), 8)).toEqual({ packMode: true, quantity: 2 });
    // Si el producto ya no tiene pack, la línea se reabre en unidades reales.
    expect(unitModalState(packLine(2), null)).toEqual({ packMode: false, quantity: 16 });
  });

  it("el escáner suma a la línea normal aunque tenga precio manual, y nunca a un Pack", () => {
    const manual = applyManualPrice(normal(2), 90_000n);
    expect(findMergeableUnitLine([packLine(1), manual], "leche", false, true)?.id).toBe(manual.id);
    expect(findMergeableUnitLine([packLine(1)], "leche", false, true)).toBeUndefined();
  });
});

// D-044 + D-061 + D-068: el recargo por tarjeta NO es una promoción de línea. Una línea tiene a lo sumo UN descuento (pack o «desde 3») y,
// además, el recargo del medio de pago una sola vez sobre el total ya descontado. El precio MANUAL de Central es la excepción: es el precio final.
describe("recargo de tarjeta combinado con descuentos (no compite, no se pierde)", () => {
  it("precio normal + tarjeta: 2 × $1.000 → $2.200 (recargo $200, sin descuento)", () => {
    const line = normal(2, "DEBIT");
    expect(line.subtotalCents).toBe(220_000n);
    expect(line.cardSurchargeCents).toBe(20_000n);
    expect(line.promotionDiscountCents ?? 0n).toBe(0n);
    expect(normal(2, "CASH").subtotalCents).toBe(200_000n);
  });

  it("«desde 3» 15 % + tarjeta: $3.000 − $450 = $2.550 y después +10 % = $2.805 (descuento Y recargo)", () => {
    const line = normal(3, "DEBIT");
    expect(line.promotionDiscountCents).toBe(45_000n);
    expect(line.subtotalCents).toBe(280_500n);
    expect(line.cardSurchargeCents).toBe(25_500n);
    expect(normal(3, "CASH").subtotalCents).toBe(255_000n);
  });

  it("pack de 8 al 20 % + tarjeta: $8.000 − $1.600 = $6.400 y después +10 % = $7.040 (descuento Y recargo)", () => {
    const line = packLine(1, "DEBIT");
    expect(line.promotionDiscountCents).toBe(160_000n);
    expect(line.subtotalCents).toBe(704_000n);
    expect(line.cardSurchargeCents).toBe(64_000n);
    expect(packLine(1, "CASH").subtotalCents).toBe(640_000n);
  });

  it("pack al 0 % + tarjeta: sin descuento, el recargo sigue aplicando ($6.000 → $6.600)", () => {
    const zero = packLine(1, "DEBIT", 6, FROM_3_15, 0);
    expect(zero.promotionDiscountCents ?? 0n).toBe(0n);
    expect(zero.packDiscountBps).toBe(0);
    expect(zero.subtotalCents).toBe(660_000n);
    expect(zero.cardSurchargeCents).toBe(60_000n);
    expect(packLine(1, "CASH", 6, FROM_3_15, 0).subtotalCents).toBe(600_000n);
  });

  it("precio manual + tarjeta: el precio fijado es el final, SIN recargo y sin descuento (D-061), con cualquier medio de pago", () => {
    const manual = applyManualPrice(normal(2, "DEBIT"), 90_000n);
    expect(manual.subtotalCents).toBe(180_000n);
    expect(manual.cardSurchargeCents ?? 0n).toBe(0n);
    expect(repriceTicketLine(manual, context("CREDIT")).subtotalCents).toBe(180_000n);
    expect(repriceTicketLine(manual, context("CASH")).subtotalCents).toBe(180_000n);
  });

  it("el recargo no suma ni resta descuento: pack + «desde 3» siguen sin acumularse al pagar con tarjeta", () => {
    const pack = packLine(1, "DEBIT");
    expect(pack.branchPromotionId).toBeUndefined();
    expect(pack.subtotalCents).toBe(704_000n); // $6.400 + 10 %, no $6.800 (15 %) ni un 25 % combinado
  });
});
