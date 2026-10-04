import { describe, expect, it } from "vitest";

import { buildTicketModel, evaluateTicketEligibility, parseTicketSource, renderTicketLine, renderTicketText } from "./whatsapp-ticket";

function sale(items: unknown[], total: number) {
  return {
    saleId: "11111111-2222-3333-4444-555555555555", status: "COMPLETED", completedAt: "2026-10-03T15:00:00Z", totalCents: total,
    ticketDiscountBps: 0, ticketDiscountCents: 0, organizationName: "Carnicerías", branchName: "Central", timezone: "America/Argentina/Buenos_Aires",
    items, payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: total }]
  };
}

const packItem = {
  name: "Leche", weightGrams: null, quantityUnits: 8, unitPriceCents: 100_000, promotionDiscountCents: 160_000, cardSurchargeCents: 0,
  subtotalCents: 640_000, promotionMode: null, manualPriceApplied: false,
  soldAsPack: true, packCount: 1, packSizeUnits: 8, packDiscountBps: 2_000
};
const promoItem = {
  name: "Leche", weightGrams: null, quantityUnits: 8, unitPriceCents: 100_000, promotionDiscountCents: 120_000, cardSurchargeCents: 0,
  subtotalCents: 680_000, promotionMode: null, manualPriceApplied: false,
  branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1_500, branchPromotionDiscountedUnits: 8
};

describe("ticket de WhatsApp con Pack y promoción de sucursal", () => {
  it("una línea Pack se lee como 1 pack × 8 u con su 20 % y el ticket cierra con el total cobrado", () => {
    const source = parseTicketSource(sale([packItem], 640_000));
    expect(source).not.toBeNull();
    if (!source) return;
    expect(evaluateTicketEligibility(source)).toEqual({ ok: true });
    const model = buildTicketModel(source);
    expect(model.lines[0]?.unitDiscountLabel).toBe("pack 1x8 u -20%");
    expect(renderTicketLine(model.lines[0] as never)).toContain("(pack 1x8 u -20%, promo -$1.600");
    expect(renderTicketText(model)).toContain("Leche 8 u.");
  });

  it("una línea Pack con otro porcentaje (25 %, 12,5 %) lo dice tal cual", () => {
    const b = { ...packItem, packDiscountBps: 2_500, promotionDiscountCents: 200_000, subtotalCents: 600_000 };
    const source = parseTicketSource(sale([b], 600_000));
    if (!source) throw new Error("source");
    expect(buildTicketModel(source).lines[0]?.unitDiscountLabel).toBe("pack 1x8 u -25%");
    const c = { ...packItem, packSizeUnits: 6, packDiscountBps: 1_250 };
    const other = parseTicketSource(sale([c], 640_000));
    if (!other) throw new Error("source");
    expect(buildTicketModel(other).lines[0]?.unitDiscountLabel).toBe("pack 1x6 u -12,5%");
  });

  it("una línea con la promoción de sucursal dice desde cuántas unidades y cuántas tuvieron descuento", () => {
    const source = parseTicketSource(sale([promoItem], 680_000));
    expect(source).not.toBeNull();
    if (!source) return;
    expect(buildTicketModel(source).lines[0]?.unitDiscountLabel).toBe("promo desde 3: 8 u -15%");
    expect(evaluateTicketEligibility(source)).toEqual({ ok: true });
  });

  it("un servidor que todavía manda la clave anterior (branchPromotionEveryUnits) se lee igual", () => {
    const { branchPromotionMinimumUnits: minimum, ...rest } = promoItem;
    const legacy = { ...rest, branchPromotionEveryUnits: minimum, branchPromotionDiscountedUnits: 6, promotionDiscountCents: 90_000, subtotalCents: 710_000 };
    const source = parseTicketSource(sale([legacy], 710_000));
    if (!source) throw new Error("source");
    expect(buildTicketModel(source).lines[0]?.unitDiscountLabel).toBe("promo desde 3: 6 u -15%");
  });

  it("un servidor anterior (sin esas claves) o una línea normal no cambian: sin etiqueta", () => {
    const plain = { ...packItem, soldAsPack: false, packCount: null, packSizeUnits: null, packDiscountBps: null, promotionDiscountCents: 0, subtotalCents: 800_000 };
    const source = parseTicketSource(sale([plain], 800_000));
    expect(source).not.toBeNull();
    if (!source) return;
    const line = buildTicketModel(source).lines[0];
    expect(line && "unitDiscountLabel" in line).toBe(false);
  });

  it("claves de pack incompletas o inválidas se ignoran en vez de inventar una etiqueta", () => {
    const broken = { ...packItem, packSizeUnits: -1 };
    const source = parseTicketSource(sale([broken], 640_000));
    expect(source).not.toBeNull();
    if (!source) return;
    expect(buildTicketModel(source).lines[0]?.unitDiscountLabel).toBeUndefined();
  });
});
