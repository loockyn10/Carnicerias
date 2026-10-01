import type { Json } from "@carnicerias/database";
import {
  nextAttemptAt,
  type BranchStockSnapshot,
  type CatalogPullPayload,
  type OfflineSalePayload,
  type SyncStatusSnapshot
} from "@carnicerias/sync";

import { localDatabase, type LocalRuntime } from "./local-database";
import { shouldRefreshQuickProductCreate, writeQuickProductCreate } from "./quick-product";
import { supabase } from "./supabase";

interface SyncUser {
  id: string;
  email: string;
}

type StatusListener = (status: SyncStatusSnapshot) => void;

export const BACKGROUND_SYNC_INTERVAL_MS = 60_000;

export function startBackgroundSyncPolling(runSync: () => Promise<void>): () => void {
  void runSync();
  const interval = globalThis.setInterval(() => void runSync(), BACKGROUND_SYNC_INTERVAL_MS);
  return () => globalThis.clearInterval(interval);
}

function describePushError(error: { message: string; code?: string; details?: string | null; hint?: string | null }): string {
  return [error.code ? `[${error.code}]` : null, error.message, error.details, error.hint ? `Hint: ${error.hint}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function asPullPayload(value: Json): CatalogPullPayload {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Supabase returned an invalid catalog payload");
  }
  return value as unknown as CatalogPullPayload;
}

async function applyPull(runtime: LocalRuntime, user: SyncUser): Promise<CatalogPullPayload> {
  const { data, error } = await supabase.rpc("pull_pos_state", {
    p_device_id: runtime.deviceId,
    p_after_sequence: runtime.catalogCursor
  });
  if (error) {
    if (error.code === "42501") await localDatabase.clearAuthorization();
    throw error;
  }
  const pull = asPullPayload(data);
  await localDatabase.applyPull(pull, user.id, user.email);
  const config = await supabase.rpc("get_pos_commercial_config", { p_branch_id: pull.branchId });
  if (config.error) throw config.error;
  await localDatabase.applyCommercialConfig(config.data);
  const roster = await supabase.rpc("get_pos_operator_roster", { p_device_id: runtime.deviceId });
  if (roster.error) throw roster.error;
  const rosterPayload = roster.data as unknown as { operators: { profileId: string; displayName: string; roleName: string; hasPin: boolean; hasShiftIssue: boolean }[]; maxShiftHours: number };
  await localDatabase.applyOperatorRoster(rosterPayload.operators, rosterPayload.maxShiftHours);
  return pull;
}

/**
 * Refreshes the branch stock projection the POS catalog uses to tell "disponible" from "sin stock".
 * Runs AFTER the outbox push on purpose: a sale pushed this cycle is then already part of the
 * server sum, so the snapshot and this device's pending-sale adjustment never disagree. Best-effort
 * and isolated from the rest of the sync: a failure (offline, RPC not deployed yet) just leaves the
 * last snapshot (or "unknown") in place and must never fail catalog/sales/timekeeping sync.
 */
async function refreshBranchStock(runtime: LocalRuntime): Promise<void> {
  if (!runtime.branchId) return;
  try {
    const { data, error } = await supabase.rpc("get_pos_branch_stock", { p_branch_id: runtime.branchId });
    if (error) throw error;
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("Invalid stock payload");
    await localDatabase.applyBranchStock(data as unknown as BranchStockSnapshot);
  } catch (stockError) {
    console.warn("Branch stock refresh skipped:", stockError);
  }
}

/**
 * Learns (rarely, see CAPABILITY_MAX_AGE_MS) whether this device is the POS of Central, which is the
 * only one allowed to create products from a scan. Best-effort like the stock refresh: offline or
 * an older server without the RPC just keeps the last remembered answer; it never fails the sync.
 */
async function refreshDeviceCapabilities(runtime: LocalRuntime): Promise<void> {
  const branchId = runtime.branchId;
  if (!branchId || !shouldRefreshQuickProductCreate(branchId)) return;
  try {
    const { data, error } = await supabase.rpc("get_pos_device_capabilities", { p_device_id: runtime.deviceId });
    if (error) throw error;
    const capabilities = data as { branchId?: unknown; quickProductCreate?: unknown } | null;
    if (capabilities?.branchId !== branchId || typeof capabilities.quickProductCreate !== "boolean") throw new Error("Invalid capabilities payload");
    writeQuickProductCreate(branchId, capabilities.quickProductCreate);
  } catch (capabilityError) {
    console.warn("Device capabilities refresh skipped:", capabilityError);
  }
}

export async function registerDesktopDevice(
  runtime: LocalRuntime,
  branchId: string,
  user: SyncUser
): Promise<CatalogPullPayload> {
  const { data, error } = await supabase.rpc("register_pos_device", {
    p_device_id: runtime.deviceId,
    p_branch_id: branchId,
    p_label: `POS ${runtime.deviceId.slice(0, 8)}`
  });
  if (error) throw error;
  const pull = asPullPayload(data);
  await localDatabase.applyPull(pull, user.id, user.email);
  const config = await supabase.rpc("get_pos_commercial_config", { p_branch_id: pull.branchId });
  if (config.error) throw config.error;
  await localDatabase.applyCommercialConfig(config.data);
  const roster = await supabase.rpc("get_pos_operator_roster", { p_device_id: runtime.deviceId });
  if (roster.error) throw roster.error;
  const rosterPayload = roster.data as unknown as { operators: { profileId: string; displayName: string; roleName: string; hasPin: boolean; hasShiftIssue: boolean }[]; maxShiftHours: number };
  await localDatabase.applyOperatorRoster(rosterPayload.operators, rosterPayload.maxShiftHours);
  return pull;
}

export async function synchronizeDesktop(
  user: SyncUser,
  listener: StatusListener
): Promise<LocalRuntime> {
  if (!navigator.onLine) {
    const runtime = await localDatabase.runtime();
    listener({
      state: "offline",
      pendingCount: runtime.pendingCount,
      syncingCurrent: 0,
      syncingTotal: runtime.pendingCount,
      lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
      lastError: runtime.lastError
    });
    return runtime;
  }

  let runtime = await localDatabase.runtime();
  if (!runtime.branchId || runtime.deviceStatus !== "ACTIVE") return runtime;

  let pullReceived = 0;
  let pushSucceeded = 0;
  let pushFailed = 0;
  const pushPendingBefore = runtime.pendingCount;
  try {
    const pull = await applyPull(runtime, user);
    pullReceived = pull.catalog.length;
    const due = await localDatabase.dueOutbox(new Date().toISOString());
    if (due.length > 0) {
      listener({
        state: "syncing",
        pendingCount: runtime.pendingCount,
        syncingCurrent: 0,
        syncingTotal: due.length,
        lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
        lastError: null
      });
    }
    for (const [index, event] of due.entries()) {
      listener({
        state: "syncing",
        pendingCount: runtime.pendingCount,
        syncingCurrent: index + 1,
        syncingTotal: due.length,
        lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
        lastError: null
      });
      const attemptedAt = new Date().toISOString();
      await localDatabase.markSyncing(event.id, attemptedAt);
      const syncResult = event.aggregateType === "SHIFT"
        ? await supabase.rpc("sync_offline_time_event", {
            p_device_id: runtime.deviceId, p_event_id: event.id, p_payload: event.payload as unknown as Json
          })
        : (() => {
            const sale = event.payload as OfflineSalePayload;
            return sale.operatorToken
              ? supabase.rpc("sync_pos_operator_offline_sale", {
                  p_device_id: runtime.deviceId, p_event_id: event.id, p_payload: sale as unknown as Json,
                  p_operator_profile_id: sale.profileId, p_operator_token: sale.operatorToken
                })
              : supabase.rpc("sync_offline_sale", { p_device_id: runtime.deviceId, p_event_id: event.id, p_payload: sale as unknown as Json });
          })();
      const { error } = await syncResult;
      if (error) {
        const diagnostic = describePushError(error);
        await localDatabase.markFailed(
          event.id,
          diagnostic,
          nextAttemptAt(event.attempts + 1)
        );
        pushFailed += 1;
        throw new Error(diagnostic);
      }
      await localDatabase.markSynced(event.id, new Date().toISOString());
      pushSucceeded += 1;
    }

    await refreshBranchStock(runtime);
    await refreshDeviceCapabilities(runtime);
    runtime = await localDatabase.runtime();
    listener({
      state: "online",
      pendingCount: runtime.pendingCount,
      syncingCurrent: 0,
      syncingTotal: 0,
      lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
      lastError: null,
      pullReceived, pushPendingBefore, pushSucceeded, pushFailed, pushPendingAfter: runtime.pendingCount
    });
    return runtime;
  } catch (error) {
    // A stuck outbox event (or a failed pull) must not freeze stock visibility: whatever was
    // pushed before the failure is already in the server sum, and what wasn't stays subtracted locally.
    await refreshBranchStock(runtime);
    runtime = await localDatabase.runtime();
    listener({
      state: "error",
      pendingCount: runtime.pendingCount,
      syncingCurrent: 0,
      syncingTotal: runtime.pendingCount,
      lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
      lastError: error instanceof Error ? error.message : "Synchronization failed",
      pullReceived, pushPendingBefore, pushSucceeded, pushFailed, pushPendingAfter: runtime.pendingCount
    });
    throw error;
  }
}
