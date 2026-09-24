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
}

export interface OfflinePaymentPayload {
  id: string;
  method: PaymentMethod;
  amountCents: string;
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
  totalCents: string;
  totalWeightGrams: string;
  createdAt: string;
  completedAt: string;
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
  /** Every active category this product is assigned to (principal included). categoryId/Name/
   * ColorHex above stay the PRINCIPAL category — still the single source for the product card's
   * color/label; categoryIds is only used for multi-category filtering. */
  categoryIds: string[];
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  productActive: boolean;
  pricePerKgCents: string;
  priceValidFrom: string;
}

/** The POS category tab directory: every active category with at least one product assignment
 * (principal or "también aparece en"), independent of any single product's principal category —
 * a category used only as a secondary assignment still gets an entry here. */
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
  roleName: string;
  catalog: CatalogPullRow[];
  removedProductIds: string[];
}

export function createOfflineSale(input: CreateOfflineSaleInput): OfflineSalePayload {
  if (input.ticket.length < 1 || input.ticket.length > 100) {
    throw new Error("A sale must contain between 1 and 100 items");
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
    subtotalCents: line.subtotalCents.toString()
  }));
  const totalCents = input.ticket.reduce((total, line) => total + line.subtotalCents, 0n);
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
    items,
    payment: {
      id: createId(),
      method: input.paymentMethod,
      amountCents: totalCents.toString()
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
