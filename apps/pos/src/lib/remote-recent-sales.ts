import type { LocalSaleReceiptSource, RecentLocalSale } from "./local-database";

export const RECENT_SALES_LIMIT = 25;

export interface RecentSaleView extends RecentLocalSale {
  /** Local keeps offline reprinting available; remote is already durable in the branch backend. */
  origin: "LOCAL" | "REMOTE";
  terminalLabel: string | null;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, context: string): JsonRecord {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`Respuesta inválida de ${context}`);
  return value as JsonRecord;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Respuesta inválida: ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Respuesta inválida: ${field}`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Respuesta inválida: ${field}`);
  return value;
}

function asRecentSale(value: unknown): RecentSaleView {
  const sale = record(value, "ventas recientes");
  return {
    saleId: string(sale.saleId, "saleId"),
    status: string(sale.status, "status"),
    totalCents: string(sale.totalCents, "totalCents"),
    totalWeightGrams: string(sale.totalWeightGrams, "totalWeightGrams"),
    completedAt: string(sale.completedAt, "completedAt"),
    syncedAt: string(sale.syncedAt, "syncedAt"),
    provider: nullableString(sale.provider, "provider"),
    verificationStatus: nullableString(sale.verificationStatus, "verificationStatus"),
    origin: "REMOTE",
    terminalLabel: nullableString(sale.terminalLabel, "terminalLabel")
  };
}

/** Only the compact headers travel in the polling response; receipt detail is loaded on demand. */
export function readRemoteRecentSales(value: unknown): RecentSaleView[] {
  const payload = record(value, "ventas recientes");
  if (!Array.isArray(payload.sales)) throw new Error("Respuesta inválida: sales");
  return payload.sales.map(asRecentSale);
}

function asReceiptItem(value: unknown): LocalSaleReceiptSource["items"][number] {
  const item = record(value, "ticket remoto");
  return {
    productName: string(item.productName, "productName"),
    weightGrams: nullableNumber(item.weightGrams, "weightGrams"),
    quantityUnits: nullableNumber(item.quantityUnits, "quantityUnits"),
    chargedPriceCents: string(item.chargedPriceCents, "chargedPriceCents"),
    originalPriceCents: string(item.originalPriceCents, "originalPriceCents"),
    subtotalCents: string(item.subtotalCents, "subtotalCents"),
    promotionDiscountCents: string(item.promotionDiscountCents, "promotionDiscountCents"),
    cardSurchargeCents: string(item.cardSurchargeCents, "cardSurchargeCents"),
    promotionMode: nullableString(item.promotionMode, "promotionMode"),
    discountType: nullableString(item.discountType, "discountType"),
    discountValue: nullableNumber(item.discountValue, "discountValue"),
    manualPriceApplied: boolean(item.manualPriceApplied, "manualPriceApplied"),
    manualUnitPriceCents: nullableString(item.manualUnitPriceCents, "manualUnitPriceCents"),
    soldAsPack: boolean(item.soldAsPack, "soldAsPack"),
    packCount: nullableNumber(item.packCount, "packCount"),
    packSizeUnitsSnapshot: nullableNumber(item.packSizeUnitsSnapshot, "packSizeUnitsSnapshot"),
    packDiscountBps: nullableNumber(item.packDiscountBps, "packDiscountBps"),
    branchPromotionMinimumUnits: nullableNumber(item.branchPromotionMinimumUnits, "branchPromotionMinimumUnits"),
    branchPromotionDiscountBps: nullableNumber(item.branchPromotionDiscountBps, "branchPromotionDiscountBps")
  };
}

/** Converts the immutable server-side snapshots into the same input used by the local receipt renderer. */
export function readRemoteSaleReceipt(value: unknown): LocalSaleReceiptSource | null {
  if (value === null) return null;
  const source = record(value, "ticket remoto");
  const payment = source.payment === null || source.payment === undefined
    ? null
    : (() => {
      const item = record(source.payment, "payment");
      return {
        method: string(item.method, "payment.method"),
        provider: nullableString(item.provider, "payment.provider"),
        verificationStatus: string(item.verificationStatus, "payment.verificationStatus")
      };
    })();
  if (!Array.isArray(source.items)) throw new Error("Respuesta inválida: items");
  return {
    saleId: string(source.saleId, "saleId"),
    status: string(source.status, "status"),
    completedAt: string(source.completedAt, "completedAt"),
    branchName: nullableString(source.branchName, "branchName"),
    operatorName: nullableString(source.operatorName, "operatorName"),
    totalCents: string(source.totalCents, "totalCents"),
    ticketDiscountBps: nullableNumber(source.ticketDiscountBps, "ticketDiscountBps") ?? 0,
    ticketDiscountCents: string(source.ticketDiscountCents, "ticketDiscountCents"),
    payment,
    items: source.items.map(asReceiptItem)
  };
}

function fromLocal(sale: RecentLocalSale): RecentSaleView {
  return { ...sale, origin: "LOCAL", terminalLabel: null };
}

/**
 * A local row wins for a duplicate sale id: it preserves the offline receipt cache on the originating
 * computer. The UUID is the only deduplication key; timestamp and amount are never identifiers.
 */
export function mergeRecentSales(local: readonly RecentLocalSale[], remote: readonly RecentSaleView[], limit = RECENT_SALES_LIMIT): RecentSaleView[] {
  const bySaleId = new Map<string, RecentSaleView>();
  for (const sale of remote) bySaleId.set(sale.saleId, sale);
  for (const sale of local) bySaleId.set(sale.saleId, fromLocal(sale));
  return [...bySaleId.values()]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.saleId.localeCompare(left.saleId))
    .slice(0, limit);
}
