import { describe, expect, it } from "vitest";

import type { RecentLocalSale } from "./local-database";
import { mergeRecentSales, readRemoteRecentSales } from "./remote-recent-sales";

const local = (saleId: string, completedAt = "2026-10-19T12:00:00.000Z"): RecentLocalSale => ({
  saleId, status: "COMPLETED", totalCents: "120000", totalWeightGrams: "1000", completedAt,
  syncedAt: null, provider: null, verificationStatus: "NOT_REQUIRED"
});

const remotePayload = (saleId: string, completedAt = "2026-10-19T12:00:00.000Z", terminalLabel: string | null = "Caja B") => ({
  sales: [{ saleId, status: "COMPLETED", totalCents: "120000", totalWeightGrams: "1000", completedAt,
    syncedAt: completedAt, provider: null, verificationStatus: "NOT_REQUIRED", terminalLabel }]
});

describe("ventas recientes compartidas", () => {
  it("keeps a local offline sale until it reaches the remote branch history", () => {
    expect(mergeRecentSales([local("sale-a")], [])).toMatchObject([{ saleId: "sale-a", origin: "LOCAL", syncedAt: null }]);
  });

  it("includes a sale made by another terminal in the same branch", () => {
    const remote = readRemoteRecentSales(remotePayload("sale-b"));
    expect(mergeRecentSales([], remote)).toMatchObject([{ saleId: "sale-b", origin: "REMOTE", terminalLabel: "Caja B" }]);
  });

  it("deduplicates the synced local and remote representations strictly by sale id", () => {
    const remote = readRemoteRecentSales(remotePayload("sale-a"));
    const result = mergeRecentSales([local("sale-a")], remote);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ saleId: "sale-a", origin: "LOCAL" });
  });

  it("orders newest first with a stable sale-id tie breaker", () => {
    const remote = [
      ...readRemoteRecentSales(remotePayload("sale-b", "2026-10-19T12:00:00.000Z")),
      ...readRemoteRecentSales(remotePayload("sale-c", "2026-10-19T12:00:00.000Z"))
    ];
    expect(mergeRecentSales([local("sale-a", "2026-10-19T12:01:00.000Z")], remote).map((sale) => sale.saleId)).toEqual(["sale-a", "sale-c", "sale-b"]);
  });
});
