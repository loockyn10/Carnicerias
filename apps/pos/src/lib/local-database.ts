import { invoke } from "@tauri-apps/api/core";

import type {
  CatalogPullPayload,
  OfflineSalePayload,
  OutboxRecord
} from "@carnicerias/sync";

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
  categorySortOrder: number;
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  pricePerKgCents: string;
  priceValidFrom: string;
}

export interface LocalSaleReceipt {
  saleId: string;
  totalCents: string;
  totalWeightGrams: string;
  completedAt: string;
}

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
  applyPull: (pull: CatalogPullPayload, profileId: string, userEmail: string) =>
    desktopVoid("apply_catalog_pull", { pull, profileId, userEmail }),
  confirmSale: (sale: OfflineSalePayload) =>
    desktopOnly<LocalSaleReceipt>("confirm_local_sale", { sale }),
  dueOutbox: (currentTime: string) =>
    desktopOnly<OutboxRecord[]>("get_due_outbox", { currentTime }),
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
