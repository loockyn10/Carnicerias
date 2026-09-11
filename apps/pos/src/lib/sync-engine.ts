import type { Json } from "@carnicerias/database";
import {
  nextAttemptAt,
  type CatalogPullPayload,
  type SyncStatusSnapshot
} from "@carnicerias/sync";

import { localDatabase, type LocalRuntime } from "./local-database";
import { supabase } from "./supabase";

interface SyncUser {
  id: string;
  email: string;
}

type StatusListener = (status: SyncStatusSnapshot) => void;

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
  return pull;
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

  listener({
    state: "syncing",
    pendingCount: runtime.pendingCount,
    syncingCurrent: 0,
    syncingTotal: runtime.pendingCount,
    lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
    lastError: null
  });

  let pullReceived = 0;
  let pushSucceeded = 0;
  let pushFailed = 0;
  const pushPendingBefore = runtime.pendingCount;
  try {
    const pull = await applyPull(runtime, user);
    pullReceived = pull.catalog.length;
    const due = await localDatabase.dueOutbox(new Date().toISOString());
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
      const hasDiscount = event.payload.items.some((item) => item.discountCents !== undefined && item.discountCents !== "0");
      const { error } = await supabase.rpc(hasDiscount ? "sync_discounted_offline_sale" : "sync_offline_sale", {
        p_device_id: runtime.deviceId,
        p_event_id: event.id,
        p_payload: event.payload as unknown as Json
      });
      if (error) {
        await localDatabase.markFailed(
          event.id,
          error.message,
          nextAttemptAt(event.attempts + 1)
        );
        pushFailed += 1;
        throw error;
      }
      await localDatabase.markSynced(event.id, new Date().toISOString());
      pushSucceeded += 1;
    }

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
