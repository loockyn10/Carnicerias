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
  weightGrams: number;
  pricePerKgCents: string;
  originalPricePerKgCents?: string;
  discountRuleId?: string | null;
  discountType?: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue?: string | null;
  discountCents?: string;
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
  deviceId: string;
  ticket: TicketLine[];
  paymentMethod: PaymentMethod;
  now?: Date;
  createId?: () => string;
}

export interface OutboxRecord {
  id: string;
  aggregateType: "SALE";
  aggregateId: string;
  operation: "UPSERT";
  payload: OfflineSalePayload;
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
  categorySortOrder: number;
  categoryActive: boolean;
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  productActive: boolean;
  pricePerKgCents: string;
  priceValidFrom: string;
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
  const items = input.ticket.map((line) => ({
    id: createId(),
    productId: line.productId,
    productNameSnapshot: line.productName,
    weightGrams: line.weightGrams,
    pricePerKgCents: line.pricePerKgCents.toString(),
    originalPricePerKgCents: (line.originalPricePerKgCents ?? line.pricePerKgCents).toString(),
    discountRuleId: line.discountRuleId ?? null,
    discountType: line.discountType ?? null,
    discountValue: line.discountValue?.toString() ?? null,
    discountCents: (line.discountCents ?? 0n).toString(),
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
      quantityGrams: (-BigInt(item.weightGrams)).toString(),
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
