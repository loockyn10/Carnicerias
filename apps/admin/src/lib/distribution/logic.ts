import { shiftIsoDate } from "../date-range";
import { formatIsoDate, moneyText, weightText } from "../vacuum";
import type {
  AvailableProduct, Delivery, DeliveryItem, DistributionStats, ReferenceDelivery, Reconciliation, ReturnRow, StatsProduct
} from "./model";

/** Reglas puras de la pantalla de Distribución (sin red ni React): se prueban solas y espejan las validaciones de las RPC para avisar antes de ir al servidor. */

// ---------------------------------------------------------------------------------------------------------------------
// Preparación de entregas
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductLine {
  productId: string;
  productName: string;
  packages: number;
  grams: number;
  cents: bigint;
  lots: string[];
  /** Vencimiento más próximo de los paquetes de la línea. */
  nextExpiry: string | null;
}

/** Agrupa los paquetes de una entrega por producto (detalle y remito). */
export function groupItemsByProduct(items: readonly DeliveryItem[]): ProductLine[] {
  const lines = new Map<string, ProductLine>();
  for (const item of items) {
    const line = lines.get(item.productId) ?? { productId: item.productId, productName: item.productName, packages: 0, grams: 0, cents: 0n, lots: [], nextExpiry: null };
    line.packages += 1;
    line.grams += item.weightGrams;
    line.cents += item.unitCents;
    if (!line.lots.includes(item.lot)) line.lots.push(item.lot);
    if (line.nextExpiry === null || item.expiresOn < line.nextExpiry) line.nextExpiry = item.expiresOn;
    lines.set(item.productId, line);
  }
  return [...lines.values()].toSorted((a, b) => a.productName.localeCompare(b.productName, "es"));
}

export interface ReplenishmentSuggestion {
  productId: string;
  productName: string;
  /** Lo que se entregó la vez anterior. */
  previous: number;
  /** Lo que hay disponible hoy para distribuir. */
  available: number;
  /** Lo que se propone agregar (nunca más de lo disponible). */
  quantity: number;
  /** Lo que faltaría para repetir la entrega anterior. */
  missing: number;
}

/**
 * Propuesta de reposición: las mismas cantidades por producto que la entrega anterior, acotadas a lo disponible. Es SÓLO una propuesta que el usuario revisa:
 * nunca se crea ni se confirma una entrega sola.
 */
export function suggestReplenishment(reference: ReferenceDelivery | null, available: readonly AvailableProduct[]): ReplenishmentSuggestion[] {
  if (reference === null) return [];
  const stock = new Map(available.map((product) => [product.productId, product.packages]));
  return reference.products.map((product) => {
    const have = stock.get(product.productId) ?? 0;
    const quantity = Math.min(product.quantity, have);
    return { productId: product.productId, productName: product.productName, previous: product.quantity, available: have, quantity, missing: product.quantity - quantity };
  });
}

/** Próxima fecha (a partir de `from`, inclusive) que cae en el día de reposición habitual (1 = lunes … 7 = domingo). */
export function nextRestockDate(weekday: number | null, from: string): string | null {
  if (weekday === null || weekday < 1 || weekday > 7) return null;
  const jsDay = new Date(`${from}T12:00:00Z`).getUTCDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  return shiftIsoDate(from, (weekday - isoDay + 7) % 7);
}

/** Días que faltan para el vencimiento (negativo = vencido). */
export function daysUntil(isoDate: string, from: string): number {
  return Math.round((new Date(`${isoDate}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// Remito operativo
// ---------------------------------------------------------------------------------------------------------------------

export const REMITO_DISCLAIMER = "Documento operativo interno de entrega de mercadería. NO es un remito ni una factura fiscal y no reemplaza a ninguno.";

export interface RemitoModel {
  title: string;
  disclaimer: string;
  numberLabel: string;
  statusLabel: string;
  isDraft: boolean;
  deliveryDate: string;
  originBranchName: string;
  commercialModeLabel: string;
  recipient: { name: string; legalName: string | null; taxId: string | null; site: string; address: string | null; city: string | null; phone: string | null; contactName: string | null };
  lines: { productName: string; packages: number; kilograms: string; value: string; lots: string }[];
  packages: { code: string; productName: string; lot: string; weight: string; packedOn: string; expiresOn: string; value: string }[];
  totals: { packages: number; kilograms: string; value: string };
  preparedBy: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  notes: string | null;
}

function formatCuit(taxId: string | null): string | null {
  return taxId !== null && /^\d{11}$/.test(taxId) ? `${taxId.slice(0, 2)}-${taxId.slice(2, 10)}-${taxId.slice(10)}` : taxId;
}

/** Datos del remito: para una entrega confirmada se usa SIEMPRE el destinatario congelado al confirmar (no el estado actual del cliente). */
export function buildRemito(delivery: Delivery): RemitoModel {
  const recipient = delivery.recipient;
  const lines = groupItemsByProduct(delivery.items);
  return {
    title: "REMITO OPERATIVO DE ENTREGA", disclaimer: REMITO_DISCLAIMER, numberLabel: delivery.numberLabel,
    statusLabel: delivery.status === "CONFIRMED" ? "Despachada" : delivery.status === "CANCELLED" ? "Cancelada" : "Borrador (sin confirmar)",
    isDraft: delivery.status !== "CONFIRMED", deliveryDate: formatIsoDate(delivery.deliveryDate), originBranchName: delivery.originBranchName,
    commercialModeLabel: delivery.commercialMode === "WHOLESALE" ? "Venta mayorista" : "Consignación",
    recipient: recipient
      ? { name: recipient.clientTradeName, legalName: recipient.clientLegalName, taxId: formatCuit(recipient.taxId), site: recipient.siteName, address: recipient.address, city: recipient.city, phone: recipient.phone, contactName: recipient.contactName }
      : { name: delivery.client.tradeName, legalName: delivery.client.legalName, taxId: formatCuit(delivery.client.taxId), site: delivery.site.name, address: delivery.site.address, city: delivery.site.city, phone: delivery.site.phone, contactName: delivery.site.contactName },
    lines: lines.map((line) => ({ productName: line.productName, packages: line.packages, kilograms: weightText(line.grams), value: moneyText(line.cents), lots: line.lots.join(", ") })),
    packages: delivery.items.map((item) => ({
      code: item.logisticCode ?? "—", productName: item.productName, lot: item.lot, weight: weightText(item.weightGrams), packedOn: formatIsoDate(item.packedOn), expiresOn: formatIsoDate(item.expiresOn), value: moneyText(item.unitCents)
    })),
    totals: { packages: delivery.packageCount, kilograms: weightText(delivery.totalGrams), value: moneyText(delivery.totalCents) },
    preparedBy: delivery.createdBy, confirmedBy: delivery.confirmedBy, confirmedAt: delivery.confirmedAt, notes: delivery.notes
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conciliación y devoluciones
// ---------------------------------------------------------------------------------------------------------------------

export interface ReconciliationDifference {
  kind: "OVER_REPORTED" | "UNEXPLAINED" | "EXPIRED_AT_SUPERMARKET";
  productName: string;
  quantity: number;
  message: string;
}

/** Diferencias detectadas en una entrega: informes de más, paquetes sin explicar y paquetes vencidos que siguen en el supermercado. */
export function reconciliationDifferences(reconciliation: Reconciliation): ReconciliationDifference[] {
  const differences: ReconciliationDifference[] = [];
  for (const product of reconciliation.products) {
    if (product.overReported) differences.push({ kind: "OVER_REPORTED", productName: product.productName, quantity: -product.pending, message: `Se informó ${String(-product.pending)} de más de ${product.productName}` });
    else if (product.pending > 0) differences.push({ kind: "UNEXPLAINED", productName: product.productName, quantity: product.pending, message: `${String(product.pending)} ${product.productName} sin vender ni devolver` });
  }
  const expired = new Map<string, number>();
  for (const pkg of reconciliation.packages) if (pkg.outcome === "PENDING" && pkg.expired && pkg.returnStatus === null) expired.set(pkg.productName, (expired.get(pkg.productName) ?? 0) + 1);
  for (const [productName, quantity] of expired) differences.push({ kind: "EXPIRED_AT_SUPERMARKET", productName, quantity, message: `${String(quantity)} ${productName} vencido${quantity === 1 ? "" : "s"} en el supermercado` });
  return differences;
}

export interface ReturnGate {
  canReceive: boolean;
  canStartInspection: boolean;
  canDecide: boolean;
  /** Por qué NO se puede aprobar el reingreso (vacío = se puede). Espeja las reglas del servidor y del check de la tabla. */
  approveBlockers: string[];
}

/** Qué se puede hacer con una devolución según su estado y lo verificado. El servidor vuelve a validar todo. */
export function returnGate(row: Pick<ReturnRow, "status" | "expiresOn" | "packagingState" | "conservationVerified">, today: string): ReturnGate {
  const inHand = row.status === "IN_QUARANTINE" || row.status === "PENDING_INSPECTION";
  const blockers: string[] = [];
  if (row.expiresOn < today) blockers.push("El paquete está vencido");
  if (row.packagingState !== "INTACT") blockers.push(row.packagingState === null ? "Falta informar el estado del envase" : "El envase no está intacto");
  if (row.conservationVerified !== true) blockers.push("Las condiciones de conservación no están verificadas");
  return { canReceive: row.status === "PENDING_RECEIPT", canStartInspection: row.status === "IN_QUARANTINE", canDecide: inHand || row.status === "REJECTED", approveBlockers: inHand ? blockers : ["Sólo se aprueba un paquete en cuarentena o en inspección"] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Estadísticas
// ---------------------------------------------------------------------------------------------------------------------

export function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1).replace(".", ",")} %`;
}

/** Cortes más vendidos: confirmado + estimado, de mayor a menor. */
export function topSold(products: readonly StatsProduct[], limit = 5): StatsProduct[] {
  return products.filter((product) => product.soldConfirmed + product.soldEstimated > 0)
    .toSorted((a, b) => b.soldConfirmed + b.soldEstimated - (a.soldConfirmed + a.soldEstimated) || a.productName.localeCompare(b.productName, "es")).slice(0, limit);
}

/** Cortes con mayor porcentaje de devolución (con un mínimo de paquetes entregados para que un 1 de 1 no engañe). */
export function topReturns(products: readonly StatsProduct[], limit = 5, minDelivered = 3): StatsProduct[] {
  return products.filter((product) => product.delivered >= minDelivered && product.returned > 0)
    .toSorted((a, b) => (b.returnPct ?? 0) - (a.returnPct ?? 0) || b.returned - a.returned).slice(0, limit);
}

/** Rotación general del período (confirmada, y con la estimación aparte). */
export function overallRotation(stats: DistributionStats): { confirmedPct: number | null; withEstimatePct: number | null } {
  const delivered = stats.delivered.packages;
  if (delivered === 0) return { confirmedPct: null, withEstimatePct: null };
  const round = (value: number) => Math.round(value * 10) / 10;
  return { confirmedPct: round((100 * stats.confirmed.packages) / delivered), withEstimatePct: round((100 * (stats.confirmed.packages + stats.estimated.packages)) / delivered) };
}
