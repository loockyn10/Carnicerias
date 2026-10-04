/** Fixtures de pruebas del ticket impreso: filas tal como las devuelve `get_sale_receipt_source` (dinero en centavos). */
import type { LocalSaleReceiptItemSource, LocalSaleReceiptSource } from "./local-database";

const BASE_ITEM: LocalSaleReceiptItemSource = {
  productName: "Producto", weightGrams: null, quantityUnits: null, chargedPriceCents: "0", originalPriceCents: "0", subtotalCents: "0",
  promotionDiscountCents: "0", cardSurchargeCents: "0", promotionMode: null, discountType: null, discountValue: null,
  manualPriceApplied: false, manualUnitPriceCents: null, soldAsPack: false, packCount: null, packSizeUnitsSnapshot: null,
  packDiscountBps: null, branchPromotionMinimumUnits: null, branchPromotionDiscountBps: null
};

export const item = (overrides: Partial<LocalSaleReceiptItemSource>): LocalSaleReceiptItemSource => ({ ...BASE_ITEM, ...overrides });

/** Coca Cola 2 x $2.500. */
export const unitItem = (overrides: Partial<LocalSaleReceiptItemSource> = {}) =>
  item({ productName: "Coca Cola", quantityUnits: 2, chargedPriceCents: "250000", originalPriceCents: "250000", subtotalCents: "500000", ...overrides });

/** Vacío 1,250 kg a $12.000/kg = $15.000. */
export const weightItem = (overrides: Partial<LocalSaleReceiptItemSource> = {}) =>
  item({ productName: "Vacio", weightGrams: 1250, chargedPriceCents: "1200000", originalPriceCents: "1200000", subtotalCents: "1500000", ...overrides });

/** Leche de $1.000 la unidad en pack de 8 con `bps` de descuento (pack_count packs). */
export const packItem = (bps: number, packCount = 1, overrides: Partial<LocalSaleReceiptItemSource> = {}) => {
  const units = 8 * packCount;
  const list = 100_000 * units;
  const discount = Math.round((list * bps) / 10_000);
  return item({
    productName: "Leche Entera", quantityUnits: units, originalPriceCents: "100000", chargedPriceCents: String(Math.round((list - discount) / units)),
    subtotalCents: String(list - discount), promotionDiscountCents: String(discount), soldAsPack: true, packCount, packSizeUnitsSnapshot: 8, packDiscountBps: bps, ...overrides
  });
};

/** Coca de $1.000 x4 con la promoción de sucursal "15 % desde 3". */
export const promoItem = (overrides: Partial<LocalSaleReceiptItemSource> = {}) =>
  item({
    productName: "Coca Cola", quantityUnits: 4, originalPriceCents: "100000", chargedPriceCents: "85000", subtotalCents: "340000",
    promotionDiscountCents: "60000", branchPromotionMinimumUnits: 3, branchPromotionDiscountBps: 1500, ...overrides
  });

export function receiptSource(items: LocalSaleReceiptItemSource[], overrides: Partial<LocalSaleReceiptSource> = {}): LocalSaleReceiptSource {
  const subtotal = items.reduce((sum, line) => sum + BigInt(line.subtotalCents), 0n);
  const discount = BigInt(overrides.ticketDiscountCents ?? "0");
  return {
    saleId: "a8f4k2d1-0000-4000-8000-000000000000",
    status: "COMPLETED",
    // 18:43 en Argentina (UTC-3).
    completedAt: "2026-10-04T21:43:00Z",
    branchName: "Central",
    operatorName: "Juan",
    totalCents: String(subtotal - discount),
    ticketDiscountBps: 0,
    ticketDiscountCents: "0",
    payment: { method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED" },
    items,
    ...overrides
  };
}
