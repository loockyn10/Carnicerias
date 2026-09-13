import { describe, expect, it } from "vitest";

import { comparisonBps, formatBps, sortProductAnalytics, type ProductAnalytics } from "./analytics";

const product = (overrides: Partial<ProductAnalytics>): ProductAnalytics => ({
  productId: crypto.randomUUID(), productName: "Producto", unitType: "WEIGHT",
  categoryId: crypto.randomUUID(), categoryName: "Categoría", quantity: 1_000,
  revenueCents: 1_000, costCents: 800, grossProfitCents: 200,
  profitabilityBps: 2_500, profitPerMeasureCents: 200, missingCostItems: 0,
  ...overrides
});

describe("profitability analytics presentation", () => {
  it("calculates exact signed period comparisons in basis points", () => {
    expect(comparisonBps(1_124, 1_000)).toBe(1_240);
    expect(comparisonBps(876, 1_000)).toBe(-1_240);
    expect(comparisonBps(100, 0)).toBeNull();
  });

  it("sorts unavailable historical profitability after complete snapshots", () => {
    const legacy = product({ productName: "Legacy", grossProfitCents: null, profitabilityBps: null });
    const filet = product({ productName: "Filet", grossProfitCents: 15_000 });
    const morcilla = product({ productName: "Morcilla", grossProfitCents: 30_000 });
    expect(sortProductAnalytics([legacy, filet, morcilla], "profit").map((row) => row.productName)).toEqual(["Morcilla", "Filet", "Legacy"]);
    expect(formatBps(null)).toBe("No disponible");
  });
});
