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
const EVERY_3_15: BranchUnitPromotion = { id: "promo-central", everyUnits: 3, discountBps: 1_500 };
const PACK_8 = { packCount: 1, packSizeUnits: 8 };
const lechePackRule: DiscountRule = {
  id: "pack-leche", productId: "leche", branchId: null, promotionMode: "PACK_FIXED_TOTAL", minimumGrams: null, discountType: null,
  discountValue: null, packQuantityGrams: null, packQuantityUnits: 4, packPriceCents: "300000"
};

function context(paymentMethod: PricingContext["paymentMethod"], branchPromotion: BranchUnitPromotion | null = EVERY_3_15, discounts: DiscountRule[] = []): PricingContext {
  return { paymentMethod, discounts, cashDiscountBps: CARD_BPS, branchId: BRANCH, branchPromotion };
}

function normal(quantity: number, method: PricingContext["paymentMethod"] = "CASH", promotion: BranchUnitPromotion | null = EVERY_3_15, product = leche, pack: DiscountRule | null = null): TicketLine {
  return buildUnitTicketLine(product, quantity, `n-${product.productId}-${String(quantity)}`, pack, method, CARD_BPS, { branchPromotion: promotion });
}

/** La versión del pack que el catálogo le da al POS para ese tamaño (en la vida real la crea el servidor). */
const packConfigFor = (packSizeUnits: number) => `cfg-${String(packSizeUnits)}`;

function packLine(packCount: number, method: PricingContext["paymentMethod"] = "CASH", packSizeUnits = 8, promotion: BranchUnitPromotion | null = EVERY_3_15): TicketLine {
  return buildUnitTicketLine(leche, packCount * packSizeUnits, `p-${String(packCount)}`, null, method, CARD_BPS, {
    branchPromotion: promotion, packSale: { packCount, packSizeUnits, packConfigId: packConfigFor(packSizeUnits) }
  });
}

describe("promoción de sucursal: cada 3 unidades, 15 %", () => {
  it.each([
    [1, 100_000n, 0], [2, 200_000n, 0], [3, 255_000n, 3], [4, 355_000n, 3], [5, 455_000n, 3], [6, 510_000n, 6], [8, 710_000n, 6]
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
    const ticket = [normal(2), normal(1, "CASH", EVERY_3_15, coca)];
    expect(ticket.every((line) => line.branchPromotionId === undefined)).toBe(true);
    expect(summarizeTicket(ticket, 0n).subtotalCents).toBe(200_000n + 120_000n);
  });

  it("sin promoción en la sucursal (otra sucursal, o inactiva) la línea sigue a precio normal", () => {
    expect(normal(8, "CASH", null).subtotalCents).toBe(800_000n);
  });

  it("la tarjeta recarga el total comercial ya descontado, una sola vez", () => {
    const cash = normal(8, "CASH");
    const card = normal(8, "DEBIT");
    expect(card.subtotalCents).toBe(781_000n);
    expect(card.cardSurchargeCents).toBe(71_000n);
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
    expect(repriceTicketLine(cash, context("CASH", { id: "p2", everyUnits: 2, discountBps: 1_000 })).subtotalCents).toBe(540_000n);
  });
});

describe("Pack (20 % de descuento, unidades reales)", () => {
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

  it("aplica exactamente 20 % y NO recibe además la promoción cada 3 (no hay acumulación)", () => {
    const asPack = packLine(1);
    expect(asPack.subtotalCents).toBe(800_000n - 800_000n / 5n);
    // Si se acumularan, 8 unidades quedarían en menos de $6.400; vendidas como Pack son exactamente $6.400.
    expect(asPack.subtotalCents).toBe(640_000n);
    // La venta normal de las mismas 8 unidades sí recibe 3+3 y deja 2 a precio normal.
    const normalEight = normal(8);
    expect(normalEight.subtotalCents).toBe(710_000n);
    expect(normalEight.branchPromotionDiscountedUnits).toBe(6);
    expect(normalEight.packCount).toBeUndefined();
  });

  it("el pack gana también a la promoción específica del producto (no se acumulan)", () => {
    const withRule = buildUnitTicketLine(leche, 8, "p", lechePackRule, "CASH", CARD_BPS, { branchPromotion: EVERY_3_15, packSale: PACK_8 });
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
    expect(describeUnitLine(normal(8)).badge).toBe("Promo 3×15%: 6 u con descuento");
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
    const line = normal(8, "CASH", EVERY_3_15, leche, lechePackRule);
    expect(line.promotionMode).toBe("PACK_FIXED_TOTAL");
    expect(line.subtotalCents).toBe(600_000n);
    expect(line.branchPromotionId).toBeUndefined();
  });

  it("si la específica no es aplicable (menos unidades que su pack) rige la de sucursal", () => {
    const line = normal(3, "CASH", EVERY_3_15, leche, lechePackRule);
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

  it("editar la línea escaneada y pasarla a Pack la convierte en unidades reales con 20 %", () => {
    const scanned = normal(1);
    const edited = buildUnitTicketLine(leche, 1 * 8, scanned.id, null, "CASH", CARD_BPS, { branchPromotion: EVERY_3_15, packSale: { packCount: 1, packSizeUnits: 8 } });
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
    const sale = createOfflineSale({ ...base, ticket: [packLine(2), normal(1, "CASH", EVERY_3_15, coca)], paymentMethod: "CASH", createId });
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
      quantityUnits: 8, branchPromotionId: "promo-central", branchPromotionEveryUnits: 3, branchPromotionDiscountBps: 1_500,
      branchPromotionDiscountedUnits: 6, branchPromotionDiscountCents: "90000", promotionDiscountCents: "90000", subtotalCents: "710000"
    });
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
    resolveUnitLineRequest({ ticket, productId: "leche", packSizeUnits: 8, packConfigId: "cfg-8", packMode: false, quantity: 1, editingLineId: null, ...overrides });

  it("grilla: 1 pack agrega 8 unidades reales y 2 packs agregan 16", () => {
    expect(request([], { packMode: true, quantity: 1 })).toMatchObject({ units: 8, packSale: { packCount: 1, packSizeUnits: 8, packConfigId: "cfg-8" }, lineId: "", mergedLine: undefined });
    expect(request([], { packMode: true, quantity: 2 })).toMatchObject({ units: 16, packSale: { packCount: 2, packSizeUnits: 8 } });
    const built = buildUnitTicketLine(leche, 16, "x", null, "CASH", CARD_BPS, { packSale: { packCount: 2, packSizeUnits: 8 } });
    expect(built.subtotalCents).toBe(1_280_000n);
  });

  it("grilla: un producto sin pack ignora el modo Pack (la cantidad son unidades)", () => {
    expect(request([], { packSizeUnits: null, packConfigId: null, packMode: true, quantity: 3 })).toMatchObject({ units: 3, packSale: null });
  });

  it("sin la versión del pack (servidor anterior) no hay Pack, aunque el tamaño exista: la venta no podría validarse", () => {
    expect(request([], { packConfigId: null, packMode: true, quantity: 2 })).toMatchObject({ units: 2, packSale: null });
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
