import { describe, expect, test } from "vitest";

import { buildBranchStockRows, filterBranchStockRows, normalizeStockSearch, type BranchStockPlanEntry, type BranchStockProductMeta } from "./branch-stock";

// This module only reshapes an already-aggregated plan (one row per
// branch x product, e.g. from get_replenishment_plan) into a matrix. It never
// touches stock_movements directly — how RETURN/cancellation/waste/purchase
// net into currentQuantity is validated at the ledger/RPC layer
// (supabase/tests/operational_pilot.test.sql), not here.

const META = new Map<string, BranchStockProductMeta>();

describe("buildBranchStockRows", () => {
  test("aggregates one row per product with one cell per branch", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Vacío de cerdo", unitType: "WEIGHT", currentQuantity: 0, minimumQuantity: 2000 },
      { branchId: "b2", productId: "p1", productName: "Vacío de cerdo", unitType: "WEIGHT", currentQuantity: 18400, minimumQuantity: 2000 },
      { branchId: "b1", productId: "p2", productName: "Matambre", unitType: "WEIGHT", currentQuantity: 7200, minimumQuantity: 1000 },
      { branchId: "b2", productId: "p2", productName: "Matambre", unitType: "WEIGHT", currentQuantity: 4800, minimumQuantity: 1000 }
    ];

    const rows = buildBranchStockRows(entries, META);

    expect(rows).toHaveLength(2);
    const vacio = rows.find((row) => row.productId === "p1");
    expect(vacio?.cells.b1?.current).toBe(0);
    expect(vacio?.cells.b2?.current).toBe(18400);
    const matambre = rows.find((row) => row.productId === "p2");
    expect(matambre?.cells.b1?.current).toBe(7200);
    expect(matambre?.cells.b2?.current).toBe(4800);
  });

  test("sorts rows alphabetically ignoring accents (es locale)", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Vacío", unitType: "WEIGHT", currentQuantity: 1000, minimumQuantity: 0 },
      { branchId: "b1", productId: "p2", productName: "Asado", unitType: "WEIGHT", currentQuantity: 1000, minimumQuantity: 0 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows.map((row) => row.productName)).toEqual(["Asado", "Vacío"]);
  });

  test("a product present in only one branch has no cell for the others", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Bife", unitType: "WEIGHT", currentQuantity: 3000, minimumQuantity: 500 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.cells.b1).toBeDefined();
    expect(rows[0]?.cells.b2).toBeUndefined();
  });

  test("a product with no plan entries never appears (nothing to aggregate)", () => {
    const rows = buildBranchStockRows([], META);
    expect(rows).toHaveLength(0);
  });

  test("current <= 0 is CRÍTICO / Sin stock, even with no configured minimum", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Chorizo", unitType: "WEIGHT", currentQuantity: 0, minimumQuantity: 0 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.cells.b1).toEqual({ current: 0, label: "CRÍTICO", rank: 0 });
  });

  test("a negative current quantity (oversold / overcorrected ledger) still reads as Sin stock, not a crash", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Bondiola", unitType: "WEIGHT", currentQuantity: -500, minimumQuantity: 1000 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.cells.b1?.rank).toBe(0);
    expect(rows[0]?.cells.b1?.current).toBe(-500);
  });

  test("current positive but under a configured minimum is ALTO (stock bajo), reusing stockPriority's threshold", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Costilla", unitType: "WEIGHT", currentQuantity: 500, minimumQuantity: 2000 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.cells.b1?.label).toBe("ALTO");
    expect(rows[0]?.cells.b1?.rank).toBe(1);
  });

  test("current at or above minimum is DISPONIBLE", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Peceto", unitType: "WEIGHT", currentQuantity: 5000, minimumQuantity: 2000 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.cells.b1?.label).toBe("DISPONIBLE");
  });

  test("preserves unitType per product (WEIGHT)", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Asado", unitType: "WEIGHT", currentQuantity: 5000, minimumQuantity: 0 }
    ];
    expect(buildBranchStockRows(entries, META)[0]?.unitType).toBe("WEIGHT");
  });

  test("preserves unitType per product (UNIT)", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Milanesas de pollo", unitType: "UNIT", currentQuantity: 12, minimumQuantity: 6 }
    ];
    const rows = buildBranchStockRows(entries, META);
    expect(rows[0]?.unitType).toBe("UNIT");
    expect(rows[0]?.cells.b1?.current).toBe(12);
  });

  test("maps sku and categoryId from product metadata, defaulting to null when missing", () => {
    const entries: BranchStockPlanEntry[] = [
      { branchId: "b1", productId: "p1", productName: "Vacío", unitType: "WEIGHT", currentQuantity: 1000, minimumQuantity: 0 },
      { branchId: "b1", productId: "p2", productName: "Sin metadata", unitType: "WEIGHT", currentQuantity: 1000, minimumQuantity: 0 }
    ];
    const meta = new Map<string, BranchStockProductMeta>([["p1", { sku: "VAC-001", categoryId: "cat-cerdo" }]]);
    const rows = buildBranchStockRows(entries, meta);
    expect(rows.find((row) => row.productId === "p1")).toMatchObject({ sku: "VAC-001", categoryId: "cat-cerdo" });
    expect(rows.find((row) => row.productId === "p2")).toMatchObject({ sku: null, categoryId: null });
  });
});

describe("normalizeStockSearch", () => {
  test("is case-insensitive", () => {
    expect(normalizeStockSearch("VACÍO")).toBe(normalizeStockSearch("vacío"));
  });

  test("strips accents so 'vacio' matches text containing 'Vacío'", () => {
    expect(normalizeStockSearch("vacio")).toBe(normalizeStockSearch("Vacío"));
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeStockSearch("  vacio  ")).toBe("vacio");
  });
});

describe("filterBranchStockRows", () => {
  const rows = buildBranchStockRows(
    [
      { branchId: "b1", productId: "p1", productName: "Vacío de cerdo", unitType: "WEIGHT", currentQuantity: 0, minimumQuantity: 0 },
      { branchId: "b1", productId: "p2", productName: "Matambre", unitType: "WEIGHT", currentQuantity: 5000, minimumQuantity: 0 },
      { branchId: "b1", productId: "p3", productName: "Asado", unitType: "WEIGHT", currentQuantity: 5000, minimumQuantity: 0 }
    ],
    new Map<string, BranchStockProductMeta>([
      ["p1", { sku: "VAC-001", categoryId: "cat-cerdo" }],
      ["p2", { sku: null, categoryId: "cat-vacuno" }],
      ["p3", { sku: null, categoryId: "cat-vacuno" }]
    ])
  );

  test("an unaccented partial search finds an accented product name", () => {
    const result = filterBranchStockRows(rows, { search: "vacio", categoryId: "" });
    expect(result.map((row) => row.productName)).toEqual(["Vacío de cerdo"]);
  });

  test("matches by SKU too", () => {
    const result = filterBranchStockRows(rows, { search: "vac-001", categoryId: "" });
    expect(result.map((row) => row.productId)).toEqual(["p1"]);
  });

  test("empty search returns every row", () => {
    expect(filterBranchStockRows(rows, { search: "", categoryId: "" })).toHaveLength(3);
  });

  test("a search with no match returns an empty list, not an error", () => {
    expect(filterBranchStockRows(rows, { search: "salmon", categoryId: "" })).toHaveLength(0);
  });

  test("filters by category", () => {
    const result = filterBranchStockRows(rows, { search: "", categoryId: "cat-vacuno" });
    expect(result.map((row) => row.productId).sort()).toEqual(["p2", "p3"]);
  });

  test("combines search and category filters", () => {
    const result = filterBranchStockRows(rows, { search: "matambre", categoryId: "cat-vacuno" });
    expect(result.map((row) => row.productId)).toEqual(["p2"]);
    expect(filterBranchStockRows(rows, { search: "matambre", categoryId: "cat-cerdo" })).toHaveLength(0);
  });
});
