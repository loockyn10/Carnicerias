import { describe, expect, it } from "vitest";

import { CAPABILITY_MAX_AGE_MS, parsePesosToCents, parseQuickCreateResult, parseScanResolveResult, readQuickProductCreate, shouldRefreshQuickProductCreate, validateQuickProduct, writeQuickProductCreate } from "./quick-product";

describe("parsePesosToCents", () => {
  it("accepts plain, decimal (comma or dot) and thousands-grouped amounts", () => {
    expect(parsePesosToCents("1200")).toBe(120_000n);
    expect(parsePesosToCents("1200,5")).toBe(120_050n);
    expect(parsePesosToCents("1200.50")).toBe(120_050n);
    expect(parsePesosToCents("$ 800")).toBe(80_000n);
    expect(parsePesosToCents("1.200")).toBe(120_000n); // 3 digits after the dot = thousands, never 1,200 decimals
    expect(parsePesosToCents("1.200,50")).toBe(120_050n);
    expect(parsePesosToCents("1.234.567")).toBe(123_456_700n);
  });

  it("rejects anything that is not an amount", () => {
    for (const raw of ["", "  ", "abc", "12,345", "-5", "1,2,3", "1..200", "12e3", "1200,"]) expect(parsePesosToCents(raw)).toBeNull();
  });

  it("rejects an absurd amount (typo guard)", () => {
    expect(parsePesosToCents("99999999999")).toBeNull();
  });
});

describe("validateQuickProduct", () => {
  it("name and price are required; cost is optional", () => {
    expect(validateQuickProduct({ name: "Galletitas X", cost: "", price: "1200" })).toEqual({ ok: true, name: "Galletitas X", priceCents: 120_000n, costCents: null });
    expect(validateQuickProduct({ name: "  Galletitas   X ", cost: "800", price: "1200" })).toEqual({ ok: true, name: "Galletitas X", priceCents: 120_000n, costCents: 80_000n });
  });

  it("reports each missing/invalid required field without stopping at the first", () => {
    expect(validateQuickProduct({ name: " ", cost: "", price: "" })).toEqual({
      ok: false,
      errors: { name: "Escribí el nombre del producto", price: "Escribí el precio de venta" }
    });
    const bad = validateQuickProduct({ name: "x", cost: "abc", price: "0" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["cost", "price"]);
  });

  it("a typed zero cost is an error, not a silent 'no cost'", () => {
    const result = validateQuickProduct({ name: "x", cost: "0", price: "10" });
    expect(result.ok).toBe(false);
  });

  it("rejects a name over 120 characters", () => {
    expect(validateQuickProduct({ name: "a".repeat(121), cost: "", price: "10" }).ok).toBe(false);
  });
});

describe("parseQuickCreateResult", () => {
  const row = {
    organizationId: "org", branchId: "central", branchName: "Central", categoryId: "alm", categoryName: "Almacen",
    categoryColorHex: null, categorySortOrder: 0, categoryIds: ["alm"], productId: "p1", productName: "Galletitas X",
    productSku: null, unitType: "UNIT", pricePerKgCents: "120000", barcodes: ["7799999999999"]
  };

  it("reads a created / already-existing sellable product", () => {
    expect(parseQuickCreateResult({ status: "CREATED", product: row })).toEqual({ status: "CREATED", product: row });
    expect(parseQuickCreateResult({ status: "EXISTS_SELLABLE", product: row }).status).toBe("EXISTS_SELLABLE");
    expect(parseQuickCreateResult({ status: "EXISTS_ENABLED", product: row })).toEqual({ status: "EXISTS_ENABLED", product: row });
  });

  it("reads the non-sellable duplicate case", () => {
    expect(parseQuickCreateResult({ status: "EXISTS_UNSELLABLE", productName: "Coca" })).toEqual({ status: "EXISTS_UNSELLABLE", productName: "Coca" });
  });

  it("the scan resolver answers NOT_FOUND or an existing product, never CREATED", () => {
    expect(parseScanResolveResult({ status: "NOT_FOUND" })).toEqual({ status: "NOT_FOUND" });
    expect(parseScanResolveResult({ status: "EXISTS_ENABLED", product: row }).status).toBe("EXISTS_ENABLED");
    expect(parseScanResolveResult({ status: "EXISTS_UNSELLABLE", productName: "X" }).status).toBe("EXISTS_UNSELLABLE");
    expect(() => parseScanResolveResult({ status: "CREATED", product: row })).toThrow();
  });

  it("rejects malformed server answers instead of guessing", () => {
    expect(() => parseQuickCreateResult(null)).toThrow();
    expect(() => parseQuickCreateResult({ status: "WHATEVER" })).toThrow();
    expect(() => parseQuickCreateResult({ status: "CREATED", product: { ...row, pricePerKgCents: "12.5" } })).toThrow();
    expect(() => parseQuickCreateResult({ status: "CREATED", product: { ...row, unitType: "BOX" } })).toThrow();
  });
});

describe("quick create capability memory", () => {
  function memory() {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
  }

  it("is false until the server said yes for THIS branch", () => {
    const storage = memory();
    expect(readQuickProductCreate("central", storage)).toBe(false);
    writeQuickProductCreate("central", true, storage);
    expect(readQuickProductCreate("central", storage)).toBe(true);
    expect(readQuickProductCreate("avenida", storage)).toBe(false); // device re-bound to another branch
    expect(readQuickProductCreate(null, storage)).toBe(false);
  });

  it("a later 'no' revokes it, and broken storage never enables anything", () => {
    const storage = memory();
    writeQuickProductCreate("central", true, storage);
    writeQuickProductCreate("central", false, storage);
    expect(readQuickProductCreate("central", storage)).toBe(false);
    expect(readQuickProductCreate("central", { getItem: () => "{not json", setItem: () => undefined })).toBe(false);
    expect(readQuickProductCreate("central", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined })).toBe(false);
    expect(readQuickProductCreate("central", null)).toBe(false);
  });

  it("asks the server again only when nothing is remembered for the branch or the answer is stale", () => {
    const storage = memory();
    expect(shouldRefreshQuickProductCreate("central", storage, 1_000)).toBe(true);
    writeQuickProductCreate("central", false, storage, 1_000);
    expect(shouldRefreshQuickProductCreate("central", storage, 1_000 + CAPABILITY_MAX_AGE_MS)).toBe(false);
    expect(shouldRefreshQuickProductCreate("central", storage, 1_001 + CAPABILITY_MAX_AGE_MS)).toBe(true);
    expect(shouldRefreshQuickProductCreate("avenida", storage, 1_000)).toBe(true);
    expect(shouldRefreshQuickProductCreate("central", null)).toBe(false); // nowhere to remember it: never ask
  });
});
