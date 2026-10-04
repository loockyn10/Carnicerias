import { describe, expect, it } from "vitest";

import { buildSaleReceipt, canPrintReceipt, receiptPrintability } from "./receipt";
import { item, packItem, promoItem, receiptSource, unitItem, weightItem } from "./receipt-fixtures";

describe("receiptPrintability — sólo un ticket final se imprime", () => {
  const sale = (status: string, provider: string | null, verificationStatus: string | null) => receiptPrintability({ status, provider, verificationStatus });

  it("a completed manual sale (cash, card, manual transfer) is printable", () => {
    expect(sale("COMPLETED", null, "NOT_REQUIRED")).toEqual({ printable: true });
    expect(canPrintReceipt({ status: "COMPLETED", provider: null, verificationStatus: null })).toBe(true);
  });

  it("a Mercado Pago sale is printable only once the payment is CONFIRMED", () => {
    expect(sale("COMPLETED", "MERCADOPAGO", "CONFIRMED")).toEqual({ printable: true });
  });

  it("PENDING_PAYMENT (a pending or errored Mercado Pago charge) is not printable as a final ticket", () => {
    for (const verification of ["PENDING", "ERROR"]) {
      const result = sale("COMPLETED", "MERCADOPAGO", verification);
      expect(result).toMatchObject({ printable: false, reason: "PAYMENT_PENDING" });
    }
    expect(sale("PENDING_PAYMENT", "MERCADOPAGO", "PENDING")).toMatchObject({ printable: false, reason: "NOT_COMPLETED" });
  });

  it("CANCELLED and EXPIRED charges (and a cancelled sale) are never printed", () => {
    expect(sale("COMPLETED", "MERCADOPAGO", "CANCELLED")).toMatchObject({ printable: false, reason: "PAYMENT_CANCELLED" });
    expect(sale("COMPLETED", "MERCADOPAGO", "EXPIRED")).toMatchObject({ printable: false, reason: "PAYMENT_CANCELLED" });
    expect(sale("CANCELLED", null, "NOT_REQUIRED")).toMatchObject({ printable: false, reason: "NOT_COMPLETED" });
  });

  it("a mismatched or refunded charge is not a confirmed payment", () => {
    for (const verification of ["MISMATCH", "REFUNDED", null]) {
      expect(sale("COMPLETED", "MERCADOPAGO", verification)).toMatchObject({ printable: false, reason: "PAYMENT_NOT_CONFIRMED" });
    }
  });

  it("every refusal explains itself in Spanish", () => {
    const refused = sale("COMPLETED", "MERCADOPAGO", "PENDING");
    expect(!refused.printable && refused.message).toMatch(/Mercado Pago/);
  });
});

describe("buildSaleReceipt — snapshot de la venta", () => {
  it("keeps the unit/weight lines, the real pack and the promotion exactly as stored", () => {
    const receipt = buildSaleReceipt(receiptSource([unitItem(), weightItem(), packItem(2500, 2), promoItem()]));
    const [unit, weight, pack, promo] = receipt.lines;
    expect(unit).toMatchObject({ unitType: "UNIT", quantityUnits: 2, weightGrams: null, originalUnitPrice: 250_000n, lineSubtotal: 500_000n, promotion: null });
    expect(weight).toMatchObject({ unitType: "WEIGHT", quantityUnits: null, weightGrams: 1250, originalUnitPrice: 1_200_000n });
    expect(pack).toMatchObject({ packCount: 2, packSizeUnitsSnapshot: 8, packDiscountBps: 2500, quantityUnits: 16, promotion: { kind: "PACK", discountBps: 2500 }, promotionDiscount: 400_000n });
    expect(promo).toMatchObject({ branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1500, promotion: { kind: "BRANCH", minimumUnits: 3, discountBps: 1500 }, promotionDiscount: 60_000n });
  });

  it("a manual price line carries the price charged and no promotion", () => {
    const manual = item({ quantityUnits: 1, originalPriceCents: "1200000", chargedPriceCents: "1000000", subtotalCents: "1000000", manualPriceApplied: true, manualUnitPriceCents: "1000000", promotionMode: "PACK_FIXED_TOTAL" });
    expect(buildSaleReceipt(receiptSource([manual])).lines[0]).toMatchObject({ manualPrice: true, manualUnitPrice: 1_000_000n, chargedUnitPrice: 1_000_000n, promotion: null });
  });

  it("derives the subtotal from the charged total plus the general discount, so the totals always add up", () => {
    const receipt = buildSaleReceipt(receiptSource([unitItem(), weightItem()], { ticketDiscountBps: 500, ticketDiscountCents: "100000" }));
    expect(receipt).toMatchObject({ subtotal: 2_000_000n, ticketDiscount: 100_000n, ticketDiscountBps: 500, total: 1_900_000n });
    expect(receipt.subtotal - receipt.ticketDiscount).toBe(receipt.total);
  });

  it("does not depend on anything but the source: the same snapshot always yields the same receipt (no catalog read)", () => {
    const source = receiptSource([packItem(2000)]);
    expect(buildSaleReceipt(source)).toEqual(buildSaleReceipt(structuredClone(source)));
  });

  it("falls back to 'Otro' when the payment row is missing and keeps names/provider as snapshots", () => {
    expect(buildSaleReceipt(receiptSource([unitItem()], { payment: null })).paymentMethod).toBe("OTHER");
    const mp = buildSaleReceipt(receiptSource([unitItem()], { payment: { method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus: "CONFIRMED" }, branchName: "Central", operatorName: "Juan" }));
    expect(mp).toMatchObject({ paymentMethod: "TRANSFER", paymentProvider: "MERCADOPAGO", branchName: "Central", operatorName: "Juan", saleId: "a8f4k2d1-0000-4000-8000-000000000000" });
  });

  it("describes percentage and fixed-price WEIGHT promotions from their snapshot", () => {
    const percentage = buildSaleReceipt(receiptSource([weightItem({ promotionDiscountCents: "150000", discountType: "PERCENTAGE", discountValue: 1000 })])).lines[0];
    expect(percentage?.promotion).toEqual({ kind: "PERCENTAGE", discountBps: 1000 });
    const fixed = buildSaleReceipt(receiptSource([weightItem({ promotionDiscountCents: "150000", discountType: "FIXED_PRICE_PER_KG", discountValue: 1_080_000 })])).lines[0];
    expect(fixed?.promotion).toEqual({ kind: "FIXED_PRICE_PER_KG", pricePerKgCents: 1_080_000n });
  });
});
