import type { SyncStatusSnapshot } from "@carnicerias/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  applyPull: vi.fn(),
  applyCommercialConfig: vi.fn(),
  applyOperatorRoster: vi.fn(),
  dueOutbox: vi.fn(),
  markSyncing: vi.fn(),
  markSynced: vi.fn(),
  markFailed: vi.fn(),
  clearAuthorization: vi.fn(),
  rpc: vi.fn()
}));

vi.mock("./local-database", () => ({
  localDatabase: {
    runtime: mocks.runtime,
    applyPull: mocks.applyPull,
    applyCommercialConfig: mocks.applyCommercialConfig,
    applyOperatorRoster: mocks.applyOperatorRoster,
    dueOutbox: mocks.dueOutbox,
    markSyncing: mocks.markSyncing,
    markSynced: mocks.markSynced,
    markFailed: mocks.markFailed,
    clearAuthorization: mocks.clearAuthorization
  }
}));

vi.mock("./supabase", () => ({ supabase: { rpc: mocks.rpc } }));

import { BACKGROUND_SYNC_INTERVAL_MS, startBackgroundSyncPolling, synchronizeDesktop } from "./sync-engine";

const runtime = {
  deviceId: "device",
  organizationId: "organization",
  branchId: "branch",
  branchName: "Centro",
  profileId: "profile",
  userEmail: "pos@example.test",
  roleName: "Administrador",
  deviceStatus: "ACTIVE" as const,
  authorizationExpiresAt: "2099-01-01T00:00:00Z",
  catalogCursor: 1,
  pendingCount: 0,
  lastSuccessfulSyncAt: "2026-09-14T10:00:00Z",
  lastError: null,
  localSalesCount: 0
};

const pull = {
  cursor: 1,
  serverTime: "2026-09-14T10:00:10Z",
  authorizationExpiresAt: "2099-01-01T00:00:00Z",
  organizationId: "organization",
  branchId: "branch",
  branchName: "Centro",
  branchActive: true,
  deviceStatus: "ACTIVE",
  roleName: "Administrador",
  catalog: [],
  removedProductIds: []
};

describe("desktop synchronization status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
    mocks.applyPull.mockResolvedValue(undefined);
    mocks.applyCommercialConfig.mockResolvedValue(undefined);
    mocks.applyOperatorRoster.mockResolvedValue(undefined);
    mocks.markSyncing.mockResolvedValue(undefined);
    mocks.markSynced.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "pull_pos_state") return Promise.resolve({ data: pull, error: null });
      if (name === "get_pos_commercial_config") return Promise.resolve({ data: {}, error: null });
      if (name === "get_pos_operator_roster") return Promise.resolve({ data: { operators: [], maxShiftHours: 12 }, error: null });
      return Promise.resolve({ data: {}, error: null });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the stable online state when a background cycle has no due outbox work", async () => {
    mocks.runtime.mockResolvedValue(runtime);
    mocks.dueOutbox.mockResolvedValue([]);
    const statuses: SyncStatusSnapshot[] = [];

    await synchronizeDesktop(
      { id: "profile", email: "pos@example.test" },
      (status) => statuses.push(status)
    );

    expect(statuses.map((status) => status.state)).toEqual(["online"]);
    expect(statuses.some((status) => status.syncingTotal === 0 && status.state === "syncing")).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("publishes real progress and pushes a due local operation", async () => {
    const pendingRuntime = { ...runtime, pendingCount: 1 };
    mocks.runtime.mockResolvedValueOnce(pendingRuntime).mockResolvedValueOnce(runtime);
    mocks.dueOutbox.mockResolvedValue([{
      id: "event",
      aggregateType: "SALE",
      aggregateId: "sale",
      operation: "UPSERT",
      payload: {},
      status: "PENDING",
      attempts: 0,
      createdAt: "2026-09-14T10:00:00Z",
      lastAttemptAt: null,
      nextAttemptAt: "2026-09-14T10:00:00Z",
      lastError: null
    }]);
    const statuses: SyncStatusSnapshot[] = [];

    await synchronizeDesktop(
      { id: "profile", email: "pos@example.test" },
      (status) => statuses.push(status)
    );

    expect(statuses.map(({ state, syncingCurrent, syncingTotal }) => ({ state, syncingCurrent, syncingTotal }))).toEqual([
      { state: "syncing", syncingCurrent: 0, syncingTotal: 1 },
      { state: "syncing", syncingCurrent: 1, syncingTotal: 1 },
      { state: "online", syncingCurrent: 0, syncingTotal: 0 }
    ]);
    expect(mocks.markSyncing).toHaveBeenCalledOnce();
    expect(mocks.markSynced).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("sync_offline_sale", expect.objectContaining({ p_event_id: "event" }));
  });

  it("stays offline without requests and resumes the pull after reconnection", async () => {
    mocks.runtime.mockResolvedValue(runtime);
    mocks.dueOutbox.mockResolvedValue([]);
    vi.stubGlobal("navigator", { onLine: false });
    const offlineStatuses: SyncStatusSnapshot[] = [];

    await synchronizeDesktop(
      { id: "profile", email: "pos@example.test" },
      (status) => offlineStatuses.push(status)
    );

    expect(offlineStatuses.map((status) => status.state)).toEqual(["offline"]);
    expect(mocks.rpc).not.toHaveBeenCalled();

    vi.stubGlobal("navigator", { onLine: true });
    const onlineStatuses: SyncStatusSnapshot[] = [];
    await synchronizeDesktop(
      { id: "profile", email: "pos@example.test" },
      (status) => onlineStatuses.push(status)
    );

    expect(onlineStatuses.map((status) => status.state)).toEqual(["online"]);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("runs once at startup and only on the intentional polling cadence during one idle minute", async () => {
    vi.useFakeTimers();
    const runSync = vi.fn(() => Promise.resolve());
    const stop = startBackgroundSyncPolling(runSync);

    expect(runSync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(BACKGROUND_SYNC_INTERVAL_MS).toBe(10_000);
    expect(runSync).toHaveBeenCalledTimes(7);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runSync).toHaveBeenCalledTimes(7);
  });
});
