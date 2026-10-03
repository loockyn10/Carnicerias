import { invoke } from "@tauri-apps/api/core";

import type {
  BranchStockSnapshot,
  CatalogPullPayload,
  OfflineSalePayload,
  OutboxRecord
} from "@carnicerias/sync";

export interface LocalDiscountRow {
  id: string;
  productId: string;
  branchId: string | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: string | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: string | null;
}
export interface LocalCommercialConfig { cashDiscountBps: number; discounts: LocalDiscountRow[]; announcements: { id: string; title: string; message: string; type: string; priority: number; branchId: string | null }[]; }

export interface LocalRuntime {
  deviceId: string;
  organizationId: string | null;
  branchId: string | null;
  branchName: string | null;
  profileId: string | null;
  userEmail: string | null;
  roleName: string | null;
  deviceStatus: "UNREGISTERED" | "ACTIVE" | "DISABLED";
  authorizationExpiresAt: string | null;
  catalogCursor: number;
  pendingCount: number;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  localSalesCount: number;
}

export interface LocalCatalogRow {
  organizationId: string;
  branchId: string;
  branchName: string;
  categoryId: string;
  categoryName: string;
  categoryColorHex: string | null;
  categorySortOrder: number;
  categoryIds: string[];
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  pricePerKgCents: string;
  priceValidFrom: string;
  barcodes: string[];
}

/** The POS tab directory row — see get_local_categories / apply_catalog_pull in the Tauri
 * backend. Independent of any product's principal category. */
export interface LocalCategoryRow {
  id: string;
  name: string;
  colorHex: string | null;
  sortOrder: number;
}

/** Device-branch stock as the Tauri backend computes it: last server snapshot minus this device's
 * own sales the snapshot can't include yet. `snapshotApplied: false` = never synced (unknown). */
export interface LocalBranchStock {
  snapshotApplied: boolean;
  items: { productId: string; quantityGrams: number }[];
}

export interface LocalSaleReceipt {
  saleId: string;
  totalCents: string;
  totalWeightGrams: string;
  completedAt: string;
}

export interface RecentLocalSale {
  saleId: string;
  status: string;
  totalCents: string;
  totalWeightGrams: string;
  completedAt: string;
  syncedAt: string | null;
  /** "MERCADOPAGO" si el cobro lo verifica Mercado Pago; null = medio manual. */
  provider: string | null;
  /** Estado de verificación cacheado del pago (NOT_REQUIRED para medios manuales). */
  verificationStatus: string | null;
}
/** Venta local declarada Mercado Pago cuyo pago el servidor todavía no confirmó (caché local). */
export interface PendingProviderPayment {
  saleId: string;
  totalCents: string;
  completedAt: string;
  verificationStatus: string;
}
export interface OutboxSummary { pending: number; syncing: number; failed: number; synced: number; lastError: string | null; }
export interface OperatorRosterRow { profileId: string; displayName: string; roleName: string; hasPin: boolean; hasShiftIssue: boolean }
export interface VerifiedOperatorInput { profileId: string; displayName: string; roleName: string; operatorToken: string; validUntil: string }
export interface LocalOperator extends OperatorRosterRow { operatorToken: string | null; validUntil: string | null }
export interface LocalShift { shiftId: string; employeeId: string; clockInAt: string; clockOutAt: string | null; clockInSource: "ONLINE" | "OFFLINE" | "ADMIN_CORRECTION"; clockOutSource: "ONLINE" | "OFFLINE" | "ADMIN_CORRECTION" | null; status: "OPEN" | "CLOSED" | "REQUIRES_REVIEW" }
export interface CloseActiveOperatorResult { clockOutCreated: boolean; shift: LocalShift | null }

export const isDesktopRuntime = () => typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

function desktopOnly<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) throw new Error("This operation requires the Tauri desktop runtime");
  return invoke<T>(command, args);
}

async function desktopVoid(command: string, args?: Record<string, unknown>): Promise<void> {
  await desktopOnly<unknown>(command, args);
}

export const localDatabase = {
  runtime: () => desktopOnly<LocalRuntime>("get_local_runtime"),
  catalog: (branchId: string) => desktopOnly<LocalCatalogRow[]>("get_local_catalog", { branchId }),
  categories: () => desktopOnly<LocalCategoryRow[]>("get_local_categories"),
  applyPull: (pull: CatalogPullPayload, profileId: string, userEmail: string) =>
    desktopVoid("apply_catalog_pull", { pull, profileId, userEmail }),
  branchStock: (branchId: string) => desktopOnly<LocalBranchStock>("get_local_branch_stock", { branchId }),
  applyBranchStock: (snapshot: BranchStockSnapshot) => desktopVoid("apply_branch_stock", { snapshot }),
  applyCommercialConfig: (config: unknown) => desktopVoid("apply_commercial_config", { config }),
  applyOperatorRoster: (operators: OperatorRosterRow[], maxShiftHours: number) => desktopVoid("apply_operator_roster", { operators, maxShiftHours }),
  operators: () => desktopOnly<LocalOperator[]>("get_local_operators"),
  cacheVerifiedOperator: (verification: VerifiedOperatorInput, pin: string) => desktopOnly<LocalOperator>("cache_verified_operator", { verification, pin }),
  verifyLocalOperator: (profileId: string, pin: string) => desktopOnly<LocalOperator>("verify_local_operator", { profileId, pin }),
  activeOperator: () => desktopOnly<LocalOperator | null>("get_active_operator"),
  clearActiveOperator: () => desktopVoid("clear_active_operator"),
  currentShift: (employeeId: string) => desktopOnly<LocalShift | null>("get_local_current_shift", { employeeId }),
  clearReconciledShift: (employeeId: string) => desktopVoid("clear_reconciled_local_shift", { employeeId }),
  applyServerShift: (shift: LocalShift) => desktopVoid("apply_server_shift", { shift }),
  recordOfflineTimeEvent: (action: "CLOCK_IN" | "CLOCK_OUT") => desktopOnly<LocalShift>("record_offline_time_event", { action }),
  closeActiveOperatorShift: () => desktopOnly<CloseActiveOperatorResult>("close_active_operator_shift"),
  recordShiftHeartbeatLocal: () => desktopOnly<string | null>("record_shift_heartbeat_local"),
  commercialConfig: () => desktopOnly<LocalCommercialConfig>("get_local_commercial_config"),
  confirmSale: (sale: OfflineSalePayload) =>
    desktopOnly<LocalSaleReceipt>("confirm_local_sale", { sale }),
  recentSales: (limit = 10) => desktopOnly<RecentLocalSale[]>("get_recent_local_sales", { limit }),
  /** Cobros Mercado Pago que se pueden retomar (PENDING / ERROR). `includeStale` suma los de más de 12 h
   * (sólo para reconciliarlos contra el servidor; el aviso de pantalla no los muestra). */
  pendingProviderPayments: (limit = 10, includeStale = false) => desktopOnly<PendingProviderPayment[]>("get_pending_provider_payments", { limit, includeStale }),
  /** Recuerda en SQLite si la transferencia manual está prohibida en la sucursal del dispositivo. */
  setManualTransferPolicy: (branchId: string, allowed: boolean) => desktopVoid("set_manual_transfer_policy", { branchId, allowed }),
  /** Recuerda en SQLite si este POS es el de Central (único donde valen el precio manual y el descuento general, D-061). */
  setFlexiblePricingBranch: (branchId: string, enabled: boolean) => desktopVoid("set_flexible_pricing_branch", { branchId, enabled }),
  setPaymentVerification: (saleId: string, status: string) => desktopOnly<boolean>("set_local_payment_verification", { saleId, status }),
  dueOutbox: (currentTime: string) =>
    desktopOnly<OutboxRecord[]>("get_due_outbox", { currentTime }),
  outboxSummary: () => desktopOnly<OutboxSummary>("get_outbox_summary"),
  markSyncing: (eventId: string, attemptedAt: string) =>
    desktopVoid("mark_outbox_syncing", { eventId, attemptedAt }),
  markSynced: (eventId: string, syncedAt: string) =>
    desktopVoid("mark_outbox_synced", { eventId, syncedAt }),
  markFailed: (eventId: string, error: string, nextAttemptAt: string) =>
    desktopVoid("mark_outbox_failed", { eventId, error, nextAttemptAt }),
  forceRetry: (eventId: string) => desktopVoid("force_outbox_retry", { eventId }),
  forceLastRetry: () => desktopOnly<string | null>("force_last_outbox_retry"),
  clearAuthorization: () => desktopVoid("clear_offline_authorization")
};
