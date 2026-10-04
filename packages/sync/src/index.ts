import type { PaymentMethod, TicketLine } from "@carnicerias/types";

export const OFFLINE_AUTHORIZATION_HOURS = 24;
export const OUTBOX_BASE_DELAY_MS = 2_000;
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;

export type SyncState = "offline" | "online" | "syncing" | "error";
export type OutboxStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED";

export interface SyncStatusSnapshot {
  state: SyncState;
  pendingCount: number;
  syncingCurrent: number;
  syncingTotal: number;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  pullReceived?: number;
  pushPendingBefore?: number;
  pushSucceeded?: number;
  pushFailed?: number;
  pushPendingAfter?: number;
}

export interface OfflineSaleItemPayload {
  id: string;
  productId: string;
  productNameSnapshot: string;
  /** Exactly one of weightGrams/quantityUnits is ever present, matching the product's own
   * unit_type — see docs/DOMAIN_RULES.md. */
  weightGrams?: number;
  quantityUnits?: number;
  pricePerKgCents: string;
  originalPricePerKgCents?: string;
  discountRuleId?: string | null;
  discountType?: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue?: string | null;
  promotionMode?: "THRESHOLD" | "PACK_FIXED_TOTAL" | null;
  discountCents?: string;
  cashDiscountBps?: string;
  cashDiscountCents?: string;
  cardSurchargeCents?: string;
  promotionDiscountCents?: string;
  costCentsSnapshot?: string | null;
  profitMarkupBpsSnapshot?: string | null;
  subtotalCents: string;
  /** Precio manual del POS de Central (D-061). Las tres claves existen sólo en una línea manual; el
   * resto de los payloads no cambia. `pricePerKgCents` de esa línea ES el precio manual (sin promoción,
   * recargo ni ajuste por medio de pago) y `originalPricePerKgCents` el precio normal del catálogo. */
  manualPriceApplied?: true;
  manualUnitPriceCents?: string;
  manualAdjustmentCents?: string;
  /** Pack de un producto UNIT: `quantityUnits` son las unidades REALES (packCount × packSizeUnitsSnapshot) y todas llevan
   * `packDiscountBps` (el % propio del producto en la versión `packConfigId`). Las claves existen sólo en una línea vendida
   * como pack; el resto de los payloads no cambia. El servidor y SQLite revalidan la aritmética; tamaño y porcentaje son un
   * snapshot de esa versión, nunca se releen del producto. */
  soldAsPack?: true;
  packCount?: number;
  packSizeUnitsSnapshot?: number;
  /** Versión del pack con la que se vendió: el servidor la valida (existe, es del producto, coincide con el snapshot). */
  packConfigId?: string;
  packDiscountBps?: number;
  packDiscountCents?: string;
  /** Promoción global de la sucursal ("desde N unidades, X %" sobre TODA la línea) aplicada a la línea: cinco claves de
   * snapshot, sólo si aplicó. `branchPromotionDiscountedUnits` = `quantityUnits`. (El formato anterior "cada N" usaba
   * `branchPromotionEveryUnits`; el POS actual nunca lo envía y el servidor sólo lo acepta de ventas ya hechas.) */
  branchPromotionId?: string;
  branchPromotionMinimumUnits?: number;
  branchPromotionDiscountBps?: number;
  branchPromotionDiscountedUnits?: number;
  branchPromotionDiscountCents?: string;
}

/** Proveedor que debe verificar el cobro. Hoy sólo Mercado Pago, siempre sobre method TRANSFER
 * (mismo precio, sin recargo): el servidor deja el pago PENDING hasta que el backend lo confirme. */
export type PaymentProvider = "MERCADOPAGO";

export interface OfflinePaymentPayload {
  id: string;
  method: PaymentMethod;
  amountCents: string;
  /** Ausente para efectivo/transferencia manual/tarjeta: el payload de esas ventas no cambia. */
  provider?: PaymentProvider;
}

export interface OfflineStockMovementPayload {
  id: string;
  productId: string;
  quantityGrams: string;
  occurredAt: string;
}

export interface OfflineSalePayload {
  schemaVersion: 1;
  eventId: string;
  saleId: string;
  organizationId: string;
  branchId: string;
  profileId: string;
  operatorToken?: string;
  deviceId: string;
  status: "COMPLETED";
  /** Total realmente cobrado (= suma de líneas menos `ticketDiscountCents`). */
  totalCents: string;
  totalWeightGrams: string;
  createdAt: string;
  completedAt: string;
  /** Descuento general del ticket (D-061). Las tres claves existen sólo si hay descuento: una venta
   * sin descuento mantiene exactamente su payload anterior. */
  ticketDiscountBps?: string;
  ticketDiscountCents?: string;
  /** Suma de las líneas antes del descuento general. */
  subtotalCents?: string;
  items: OfflineSaleItemPayload[];
  payment: OfflinePaymentPayload;
  stockMovements: OfflineStockMovementPayload[];
}

export interface CreateOfflineSaleInput {
  organizationId: string;
  branchId: string;
  profileId: string;
  operatorToken?: string;
  deviceId: string;
  ticket: TicketLine[];
  paymentMethod: PaymentMethod;
  /** Sólo "MERCADOPAGO" y sólo con paymentMethod "TRANSFER" (si no, createOfflineSale lanza). */
  paymentProvider?: PaymentProvider;
  /** Descuento general del ticket en basis points y su importe, calculados por el POS con
   * `calculateTicketDiscount` (business-logic). Backend y SQLite los recalculan y los rechazan si no coinciden. */
  ticketDiscount?: { bps: bigint; cents: bigint };
  now?: Date;
  createId?: () => string;
}

export interface OfflineTimeEventPayload {
  schemaVersion: 1;
  eventId: string;
  shiftId: string;
  employeeId: string;
  deviceId: string;
  operatorToken: string;
  action: "CLOCK_IN" | "CLOCK_OUT";
  occurredAt: string;
}

export interface OutboxRecord {
  id: string;
  aggregateType: "SALE" | "SHIFT";
  aggregateId: string;
  operation: "UPSERT" | "EVENT";
  payload: OfflineSalePayload | OfflineTimeEventPayload;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string;
  lastError: string | null;
}

export interface CatalogPullRow {
  organizationId: string;
  branchId: string;
  branchName: string;
  branchActive: boolean;
  categoryId: string;
  categoryName: string;
  categoryColorHex: string | null;
  categorySortOrder: number;
  categoryActive: boolean;
  /** Contrato anterior, conservado por compatibilidad: un producto tiene UNA sola categoría, así que contiene siempre
   * exactamente [categoryId]. La fuente de verdad es categoryId/Name/ColorHex; nunca hay categorías secundarias. */
  categoryIds: string[];
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  productActive: boolean;
  pricePerKgCents: string;
  priceValidFrom: string;
  /** Normalized barcodes of the product (scanner codes). Optional: a server that predates them
   * simply omits the key. Stored in SQLite so scans resolve locally/offline. */
  barcodes?: string[];
  /** Unidades por pack (sólo UNIT; null/ausente = sin pack). Viaja con el producto por el cursor del catálogo. */
  packSizeUnits?: number | null;
  /** Id de la versión vigente del pack: viaja con el tamaño y se guarda en cada línea vendida como Pack. */
  packConfigId?: string | null;
  /** Descuento de esa versión del pack (basis points, 1..9999): el % propio del producto. Ausente en un servidor anterior (20 %). */
  packDiscountBps?: number | null;
}

/** Promoción global de una sucursal para sus productos UNIT ("desde N unidades, X % sobre toda la línea"). Foto completa en cada pull. */
export interface CatalogBranchPromotion {
  id: string;
  scope: "ALL_UNIT_PRODUCTS";
  /** Cantidad mínima del mismo producto desde la cual aplica a TODAS las unidades de la línea. */
  minimumUnits: number;
  discountBps: number;
}

/** The POS category tab directory: every active category that is the (single) category of at least one
 * product enabled in the device branch. */
export interface CatalogCategoryDirectoryEntry {
  id: string;
  name: string;
  colorHex: string | null;
  sortOrder: number;
}

export interface CatalogPullPayload {
  cursor: number;
  serverTime: string;
  authorizationExpiresAt: string;
  organizationId: string;
  branchId: string;
  branchName: string;
  branchActive: boolean;
  deviceStatus: "ACTIVE" | "DISABLED";
  categories: CatalogCategoryDirectoryEntry[];
  /** Promociones globales "desde N" activas de la sucursal del dispositivo (foto completa; ausente en un servidor anterior). Clave
   * propia: `branchPromotions` (la que leía un POS de antes de la regla "desde N") el servidor la entrega vacía y este POS no la lee. */
  branchPromotionsFromMinimum?: CatalogBranchPromotion[];
  roleName: string;
  catalog: CatalogPullRow[];
  removedProductIds: string[];
}

/** Server stock snapshot for the device branch (get_pos_branch_stock). Always a full snapshot,
 * never a delta. `quantityGrams` is the signed ledger sum as a decimal string (grams for WEIGHT,
 * units for UNIT); a product with no movements in the branch is absent, i.e. zero. */
export interface BranchStockSnapshot {
  serverTime: string;
  branchId: string;
  items: { productId: string; quantityGrams: string }[];
}

export function createOfflineSale(input: CreateOfflineSaleInput): OfflineSalePayload {
  if (input.ticket.length < 1 || input.ticket.length > 100) {
    throw new Error("A sale must contain between 1 and 100 items");
  }
  if (input.paymentProvider && input.paymentMethod !== "TRANSFER") {
    throw new Error("A payment provider is only valid on a TRANSFER payment");
  }

  const createId = input.createId ?? crypto.randomUUID.bind(crypto);
  const timestamp = (input.now ?? new Date()).toISOString();
  const saleId = createId();
  const eventId = createId();
  const items: OfflineSaleItemPayload[] = input.ticket.map((line) => ({
    id: createId(),
    productId: line.productId,
    productNameSnapshot: line.productName,
    // Exactly one of the two, matching the product's own unit_type — never both, never neither
    // (the omitted key is genuinely absent, not present-with-undefined, so it never reaches the
    // wire at all once JSON-serialized).
    ...(line.quantityUnits != null ? { quantityUnits: line.quantityUnits } : { weightGrams: line.weightGrams }),
    pricePerKgCents: line.pricePerKgCents.toString(),
    originalPricePerKgCents: (line.originalPricePerKgCents ?? line.pricePerKgCents).toString(),
    discountRuleId: line.discountRuleId ?? null,
    discountType: line.discountType ?? null,
    discountValue: line.discountValue?.toString() ?? null,
    promotionMode: line.promotionMode ?? null,
    discountCents: (line.discountCents ?? 0n).toString(),
    cashDiscountBps: (line.cashDiscountBps ?? 0n).toString(),
    cashDiscountCents: (line.cashDiscountCents ?? 0n).toString(),
    cardSurchargeCents: (line.cardSurchargeCents ?? 0n).toString(),
    promotionDiscountCents: (line.promotionDiscountCents ?? (line.discountCents ?? 0n) - (line.cashDiscountCents ?? 0n)).toString(),
    costCentsSnapshot: line.costCentsSnapshot?.toString() ?? null,
    profitMarkupBpsSnapshot: line.profitMarkupBpsSnapshot?.toString() ?? null,
    subtotalCents: line.subtotalCents.toString(),
    ...(line.manualPriceApplied
      ? {
          manualPriceApplied: true as const,
          manualUnitPriceCents: (line.manualUnitPriceCents ?? line.pricePerKgCents).toString(),
          manualAdjustmentCents: (line.manualAdjustmentCents ?? 0n).toString()
        }
      : {}),
    // Pack y promoción de sucursal: sólo cuando la línea realmente los lleva ahora (una línea con precio manual nunca).
    ...(line.soldAsPack && !line.manualPriceApplied && line.quantityUnits != null
      ? {
          soldAsPack: true as const,
          packCount: line.packCount ?? 0,
          packSizeUnitsSnapshot: line.packSizeUnitsSnapshot ?? 0,
          // Sin versión la línea no se omite: el servidor (y Rust) la rechazan, en vez de aceptar un pack sin respaldo.
          ...(line.packConfigId ? { packConfigId: line.packConfigId } : {}),
          packDiscountBps: line.packDiscountBps ?? 0,
          packDiscountCents: (line.packDiscountCents ?? 0n).toString()
        }
      : {}),
    ...(line.branchPromotionId && !line.soldAsPack && !line.manualPriceApplied && line.quantityUnits != null
      ? {
          branchPromotionId: line.branchPromotionId,
          branchPromotionMinimumUnits: line.branchPromotionMinimumUnits ?? 0,
          branchPromotionDiscountBps: line.branchPromotionDiscountBps ?? 0,
          branchPromotionDiscountedUnits: line.branchPromotionDiscountedUnits ?? 0,
          branchPromotionDiscountCents: (line.branchPromotionDiscountCents ?? 0n).toString()
        }
      : {})
  }));
  const itemsSubtotalCents = input.ticket.reduce((total, line) => total + line.subtotalCents, 0n);
  const ticketDiscountCents = input.ticketDiscount?.cents ?? 0n;
  const ticketDiscountBps = input.ticketDiscount?.bps ?? 0n;
  if (ticketDiscountCents < 0n || ticketDiscountBps < 0n || ticketDiscountBps > 10_000n || ticketDiscountCents > itemsSubtotalCents
      || (ticketDiscountBps === 0n && ticketDiscountCents !== 0n)) {
    throw new Error("The ticket discount is invalid");
  }
  const totalCents = itemsSubtotalCents - ticketDiscountCents;
  if (totalCents <= 0n) throw new Error("A sale total must be greater than zero");
  const totalWeightGrams = input.ticket.reduce((total, line) => total + BigInt(line.weightGrams), 0n);

  return {
    schemaVersion: 1,
    eventId,
    saleId,
    organizationId: input.organizationId,
    branchId: input.branchId,
    profileId: input.profileId,
    ...(input.operatorToken ? { operatorToken: input.operatorToken } : {}),
    deviceId: input.deviceId,
    status: "COMPLETED",
    totalCents: totalCents.toString(),
    totalWeightGrams: totalWeightGrams.toString(),
    createdAt: timestamp,
    completedAt: timestamp,
    ...(ticketDiscountBps > 0n
      ? {
          ticketDiscountBps: ticketDiscountBps.toString(),
          ticketDiscountCents: ticketDiscountCents.toString(),
          subtotalCents: itemsSubtotalCents.toString()
        }
      : {}),
    items,
    payment: {
      id: createId(),
      method: input.paymentMethod,
      amountCents: totalCents.toString(),
      ...(input.paymentProvider ? { provider: input.paymentProvider } : {})
    },
    stockMovements: items.map((item) => ({
      id: createId(),
      productId: item.productId,
      // Reuses this same generic "quantity" column as a signed unit count for a UNIT line — same
      // precedent already set by PRODUCTION_YIELD for a UNIT desposte output, not a new
      // convention introduced here.
      quantityGrams: (-BigInt(item.quantityUnits ?? item.weightGrams ?? 0)).toString(),
      occurredAt: timestamp
    }))
  };
}

export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(OUTBOX_BASE_DELAY_MS * 2 ** exponent, OUTBOX_MAX_DELAY_MS);
}

export function nextAttemptAt(attempts: number, now = new Date()): string {
  return new Date(now.getTime() + retryDelayMs(attempts)).toISOString();
}

export function shouldAttempt(record: OutboxRecord, now = new Date()): boolean {
  return record.status !== "SYNCED" && new Date(record.nextAttemptAt).getTime() <= now.getTime();
}
