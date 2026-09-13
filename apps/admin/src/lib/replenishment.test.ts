import { describe, expect, it } from "vitest";

import { calculateReplenishment } from "./replenishment";

const base = {
  branchId: "branch",
  branchName: "Centro",
  productId: "product",
  productName: "Filet",
  unitType: "WEIGHT" as const,
  minimumQuantity: 10_000,
  manualTargetQuantity: 10_000,
  salesDays: 7,
  targetCoverageDays: 3
};

describe("smart replenishment", () => {
  it("combines recent sales and the manual target", () => {
    const row = calculateReplenishment({ ...base, currentQuantity: 2_000, soldRecentQuantity: 35_000 });
    expect(row.averageDailyQuantity).toBe(5_000);
    expect(row.coverageDays).toBe(0.4);
    expect(row.dynamicTargetQuantity).toBe(15_000);
    expect(row.desiredStockQuantity).toBe(15_000);
    expect(row.suggestedQuantity).toBe(13_000);
    expect(row.priority).toBe("CRITICAL");
  });

  it("does not invent coverage without recent sales", () => {
    const row = calculateReplenishment({ ...base, currentQuantity: 3_000, soldRecentQuantity: 0 });
    expect(row.averageDailyQuantity).toBe(0);
    expect(row.coverageDays).toBeNull();
    expect(row.dynamicTargetQuantity).toBe(0);
    expect(row.suggestedQuantity).toBe(7_000);
  });

  it("uses integer units for UNIT products", () => {
    const row = calculateReplenishment({ ...base, unitType: "UNIT", currentQuantity: 2, minimumQuantity: 0, manualTargetQuantity: 0, soldRecentQuantity: 21 });
    expect(row.averageDailyQuantity).toBe(3);
    expect(row.dynamicTargetQuantity).toBe(9);
    expect(row.suggestedQuantity).toBe(7);
  });

  it("shows a negative ledger balance as shortage and replenishes through zero", () => {
    const row = calculateReplenishment({ ...base, currentQuantity: -3_000, soldRecentQuantity: 0 });
    expect(row.coverageDays).toBeNull();
    expect(row.suggestedQuantity).toBe(13_000);
    expect(row.priority).toBe("CRITICAL");
  });
});
