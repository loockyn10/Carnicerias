/**
 * Boundary reserved for Phase 1B offline synchronization.
 * No transport or outbox behavior is implemented in Phase 1A.
 */
export interface SyncStatusSnapshot {
  state: "offline" | "online" | "syncing" | "error";
  pendingCount: number;
  lastSuccessfulSyncAt: string | null;
}

