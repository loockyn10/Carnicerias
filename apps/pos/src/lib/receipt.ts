/**
 * Modelo común del ticket impreso (NO fiscal). Lógica pura: sin Tauri, sin React, sin red.
 *
 * `SaleReceipt` es una representación inmutable armada ÚNICAMENTE desde los snapshots que la venta guardó en
 * SQLite (`local_sales`, `local_sale_items`, `local_payments`; ver `get_sale_receipt_source` en Rust). Jamás
 * se recalcula contra el catálogo, el precio, el Pack o la promoción de hoy: una reimpresión histórica no
 * puede cambiar porque después cambió la configuración comercial.
 */

import type { LocalSaleReceiptSource, LocalSaleReceiptItemSource } from "./local-database";

/** Cómo se explica el descuento de una línea (un solo descuento por línea, D-063). */
export type ReceiptPromotion =
  | { kind: "PACK"; discountBps: number }
  | { kind: "BRANCH"; minimumUnits: number; discountBps: number }
  | { kind: "PACK_FIXED_TOTAL" }
  | { kind: "PERCENTAGE"; discountBps: number }
  | { kind: "FIXED_PRICE_PER_KG"; pricePerKgCents: bigint };

export interface ReceiptLine {
  productName: string;
  unitType: "WEIGHT" | "UNIT";
  /** Unidades REALES (un pack de 8 son 8). Sólo UNIT. */
  quantityUnits: number | null;
  /** Sólo WEIGHT. */
  weightGrams: number | null;
  /** Precio de lista de ese momento, por kg o por unidad. */
  originalUnitPrice: bigint;
  /** Precio efectivamente cobrado por kg o por unidad (con promoción y recargo ya incluidos). */
  chargedUnitPrice: bigint;
  manualPrice: boolean;
  manualUnitPrice: bigint | null;
  packCount: number | null;
  packSizeUnitsSnapshot: number | null;
  packDiscountBps: number | null;
  branchPromotionMinimumUnits: number | null;
  branchPromotionDiscountBps: number | null;
  promotion: ReceiptPromotion | null;
  /** Monto descontado por la promoción/pack de la línea (>= 0). */
  promotionDiscount: bigint;
  /** Recargo de tarjeta de la línea (>= 0). */
  cardSurcharge: bigint;
  lineSubtotal: bigint;
}

export interface SaleReceipt {
  saleId: string;
  /** ISO-8601 del momento de la venta. */
  soldAt: string;
  branchName: string | null;
  operatorName: string | null;
  /** CASH / DEBIT / CREDIT / TRANSFER / OTHER (nombre interno: se traduce al imprimir). */
  paymentMethod: string;
  /** "MERCADOPAGO" o null (medio manual). */
  paymentProvider: string | null;
  lines: ReceiptLine[];
  /** Suma de las líneas, antes del descuento general. */
  subtotal: bigint;
  ticketDiscountBps: number;
  ticketDiscount: bigint;
  total: bigint;
}

// ---------------------------------------------------------------------------
// ¿Se puede imprimir como ticket final?
// ---------------------------------------------------------------------------

export type ReceiptBlockReason = "NOT_COMPLETED" | "PAYMENT_PENDING" | "PAYMENT_CANCELLED" | "PAYMENT_NOT_CONFIRMED";

export type ReceiptPrintability = { printable: true } | { printable: false; reason: ReceiptBlockReason; message: string };

const BLOCK_MESSAGES: Record<ReceiptBlockReason, string> = {
  NOT_COMPLETED: "La venta no está completada: no se imprime como ticket de compra.",
  PAYMENT_PENDING: "El pago de Mercado Pago todavía no está confirmado: el ticket se imprime cuando se acredita.",
  PAYMENT_CANCELLED: "El cobro no se concretó (venta anulada): no hay ticket de compra para imprimir.",
  PAYMENT_NOT_CONFIRMED: "El pago no está confirmado: no se imprime como ticket de compra."
};

/**
 * Sólo una venta COMPLETED con el cobro confirmado es un ticket final. Un medio manual (sin proveedor) está
 * "completado" al registrarse; un cobro Mercado Pago recién cuando el servidor lo confirmó (`CONFIRMED`).
 * `PENDING_PAYMENT` (PENDING / ERROR del caché local), `CANCELLED` y `EXPIRED` nunca se imprimen como final.
 */
export function receiptPrintability(sale: { status: string; provider: string | null; verificationStatus: string | null }): ReceiptPrintability {
  const blocked = (reason: ReceiptBlockReason): ReceiptPrintability => ({ printable: false, reason, message: BLOCK_MESSAGES[reason] });
  if (sale.status !== "COMPLETED") return blocked("NOT_COMPLETED");
  if (sale.provider === null) return { printable: true };
  switch (sale.verificationStatus) {
    case "CONFIRMED":
      return { printable: true };
    case "PENDING":
    case "ERROR":
      return blocked("PAYMENT_PENDING");
    case "CANCELLED":
    case "EXPIRED":
      return blocked("PAYMENT_CANCELLED");
    default:
      return blocked("PAYMENT_NOT_CONFIRMED");
  }
}

export function canPrintReceipt(sale: { status: string; provider: string | null; verificationStatus: string | null }): boolean {
  return receiptPrintability(sale).printable;
}

// ---------------------------------------------------------------------------
// Snapshots de la venta -> SaleReceipt
// ---------------------------------------------------------------------------

function promotionOf(item: LocalSaleReceiptItemSource): ReceiptPromotion | null {
  if (item.manualPriceApplied) return null;
  if (item.soldAsPack && item.packDiscountBps !== null) return { kind: "PACK", discountBps: item.packDiscountBps };
  if (item.branchPromotionMinimumUnits !== null && item.branchPromotionDiscountBps !== null) {
    return { kind: "BRANCH", minimumUnits: item.branchPromotionMinimumUnits, discountBps: item.branchPromotionDiscountBps };
  }
  if (item.promotionMode === "PACK_FIXED_TOTAL") return { kind: "PACK_FIXED_TOTAL" };
  if (item.discountType === "PERCENTAGE" && item.discountValue !== null) return { kind: "PERCENTAGE", discountBps: item.discountValue };
  if (item.discountType === "FIXED_PRICE_PER_KG" && item.discountValue !== null) {
    return { kind: "FIXED_PRICE_PER_KG", pricePerKgCents: BigInt(item.discountValue) };
  }
  return null;
}

function lineOf(item: LocalSaleReceiptItemSource): ReceiptLine {
  const isWeight = item.weightGrams !== null;
  return {
    productName: item.productName,
    unitType: isWeight ? "WEIGHT" : "UNIT",
    quantityUnits: isWeight ? null : item.quantityUnits,
    weightGrams: isWeight ? item.weightGrams : null,
    originalUnitPrice: BigInt(item.originalPriceCents),
    chargedUnitPrice: BigInt(item.chargedPriceCents),
    manualPrice: item.manualPriceApplied,
    manualUnitPrice: item.manualUnitPriceCents === null ? null : BigInt(item.manualUnitPriceCents),
    packCount: item.soldAsPack ? item.packCount : null,
    packSizeUnitsSnapshot: item.soldAsPack ? item.packSizeUnitsSnapshot : null,
    packDiscountBps: item.soldAsPack ? item.packDiscountBps : null,
    branchPromotionMinimumUnits: item.branchPromotionMinimumUnits,
    branchPromotionDiscountBps: item.branchPromotionDiscountBps,
    promotion: promotionOf(item),
    promotionDiscount: BigInt(item.promotionDiscountCents),
    cardSurcharge: BigInt(item.cardSurchargeCents),
    lineSubtotal: BigInt(item.subtotalCents)
  };
}

/**
 * Arma el recibo de una venta. El total es siempre el cobrado (`total_cents`) y el subtotal se deriva de él más
 * el descuento general, así `subtotal - descuento = total` sin importar cómo se redondeó cada línea.
 */
export function buildSaleReceipt(source: LocalSaleReceiptSource): SaleReceipt {
  const total = BigInt(source.totalCents);
  const ticketDiscount = BigInt(source.ticketDiscountCents);
  return {
    saleId: source.saleId,
    soldAt: source.completedAt,
    branchName: source.branchName,
    operatorName: source.operatorName,
    paymentMethod: source.payment?.method ?? "OTHER",
    paymentProvider: source.payment?.provider ?? null,
    lines: source.items.map(lineOf),
    subtotal: total + ticketDiscount,
    ticketDiscountBps: source.ticketDiscountBps,
    ticketDiscount,
    total
  };
}
