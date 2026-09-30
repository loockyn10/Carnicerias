import { describe, expect, it } from "vitest";

import { buildBarcodeIndex, buildCategoryTabs, hasStock, normalizeBarcode, partitionByStock, productMatchesCategory, resolveScan, type CatalogProductLike, type CategoryDirectoryEntryLike } from "./catalog";

const embutidos: CategoryDirectoryEntryLike = { id: "embutidos", name: "Embutidos", colorHex: "#ff0000", sortOrder: 1 };
const cerdo: CategoryDirectoryEntryLike = { id: "cerdo", name: "Cerdo", colorHex: "#00ff00", sortOrder: 0 };

const chorizo: CatalogProductLike = { categoryIds: ["cerdo", "embutidos"] }; // principal: Cerdo, también en Embutidos
const vacio: CatalogProductLike = { categoryIds: ["vacuno"] };

describe("buildCategoryTabs", () => {
  it("builds one tab per directory entry, sorted by order — independent of any product", () => {
    expect(buildCategoryTabs([embutidos, cerdo])).toEqual([
      { id: "cerdo", name: "Cerdo", color: "#00ff00", order: 0 },
      { id: "embutidos", name: "Embutidos", color: "#ff0000", order: 1 }
    ]);
  });

  it("still builds a tab for a category that is only ever a secondary assignment (never a principal)", () => {
    // "Embutidos" is in the directory (server sent it because Chorizo is assigned to it, even
    // though Chorizo's own principal is Cerdo) — buildCategoryTabs doesn't need to know that,
    // it just reflects whatever the server considered part of the directory.
    expect(buildCategoryTabs([embutidos])).toEqual([{ id: "embutidos", name: "Embutidos", color: "#ff0000", order: 1 }]);
  });
});

describe("productMatchesCategory", () => {
  it("matches a product under its principal category", () => {
    expect(productMatchesCategory(chorizo, "cerdo")).toBe(true);
  });

  it("matches a multi-category product under an additional category too", () => {
    expect(productMatchesCategory(chorizo, "embutidos")).toBe(true);
  });

  it("does not match an unrelated category", () => {
    expect(productMatchesCategory(chorizo, "vacuno")).toBe(false);
  });

  it("\"ALL\" matches any product", () => {
    expect(productMatchesCategory(chorizo, "ALL")).toBe(true);
    expect(productMatchesCategory(vacio, "ALL")).toBe(true);
  });
});

describe("hasStock / partitionByStock", () => {
  // Grams. Real values, not rounded: 0 / -200 g / -1 kg are sin stock, 10 g (0.01 kg) and 1350 g are available.
  const stock = new Map<string, number>([["vacio", 8000], ["peceto", 0], ["bondiola", -1000], ["costilla", 10], ["asado", 1350], ["merma", -200]]);

  it("treats strictly positive stock as available, including fractions of a kilo", () => {
    expect(hasStock(stock, "vacio")).toBe(true);
    expect(hasStock(stock, "costilla")).toBe(true); // 0.01 kg
    expect(hasStock(stock, "asado")).toBe(true); // 1.35 kg
  });

  it("treats zero, negative and never-moved products as sin stock", () => {
    expect(hasStock(stock, "peceto")).toBe(false); // 0 kg
    expect(hasStock(stock, "merma")).toBe(false); // -0.2 kg
    expect(hasStock(stock, "bondiola")).toBe(false); // -1 kg
    expect(hasStock(stock, "sin-movimientos")).toBe(false);
  });

  it("does not disable anything while stock has never been synced (unknown, not zero)", () => {
    expect(hasStock(null, "peceto")).toBe(true);
    expect(partitionByStock([{ productId: "peceto" }], null)).toEqual({ available: [{ productId: "peceto" }], outOfStock: [] });
  });

  it("puts available products first and keeps the original order inside each group", () => {
    const products = [{ productId: "peceto" }, { productId: "vacio" }, { productId: "bondiola" }, { productId: "asado" }];
    expect(partitionByStock(products, stock)).toEqual({
      available: [{ productId: "vacio" }, { productId: "asado" }],
      outOfStock: [{ productId: "peceto" }, { productId: "bondiola" }]
    });
  });

  it("flips a product to available once a restock snapshot replaces zero, and back to sin stock when sold out", () => {
    expect(hasStock(new Map([["peceto", 0]]), "peceto")).toBe(false);
    expect(hasStock(new Map([["peceto", 10_000]]), "peceto")).toBe(true); // Reposición +10 kg
    expect(hasStock(new Map([["peceto", 10_000 - 10_000]]), "peceto")).toBe(false); // sold the rest
  });
});

describe("barcode scan resolution", () => {
  const coca = { productId: "coca", unitType: "UNIT" as const, barcodes: ["7790895000010", "7790895000027"] };
  const vacio = { productId: "vacio", unitType: "WEIGHT" as const, barcodes: ["2000000000011"] };
  const agua = { productId: "agua", unitType: "UNIT" as const, barcodes: ["7791111111111"] };
  const index = buildBarcodeIndex([coca, vacio, agua]);
  const stock = new Map<string, number>([["coca", 24], ["vacio", 8000], ["agua", 0]]);

  it("normalizes like the server (trim, no spaces, upper-case)", () => {
    expect(normalizeBarcode(" 7790895000010\n")).toBe("7790895000010");
    expect(normalizeBarcode("abc 123")).toBe("ABC123");
    expect(normalizeBarcode("   ")).toBeNull();
  });

  it("a known UNIT barcode with stock adds exactly one unit", () => {
    expect(resolveScan(index, stock, "7790895000010")).toEqual({ kind: "ADD_UNIT", product: coca });
    expect(resolveScan(index, stock, "7790895000027")).toEqual({ kind: "ADD_UNIT", product: coca });
  });

  it("an unknown barcode is NOT_FOUND (never guessed, never added)", () => {
    expect(resolveScan(index, stock, "0000000000000")).toEqual({ kind: "NOT_FOUND", code: "0000000000000" });
  });

  it("a product of the branch with zero stock is NO_STOCK, even though it exists in the catalog", () => {
    expect(resolveScan(index, stock, "7791111111111")).toEqual({ kind: "NO_STOCK", product: agua });
  });

  it("a product absent from the synced stock snapshot reads as no stock once a snapshot exists", () => {
    expect(resolveScan(index, new Map(), "7790895000010")).toEqual({ kind: "NO_STOCK", product: coca });
  });

  it("with no stock snapshot at all (never synced) nothing is blocked, like the rest of the catalog", () => {
    expect(resolveScan(index, null, "7791111111111")).toEqual({ kind: "ADD_UNIT", product: agua });
  });

  it("a WEIGHT product keeps the weigh flow: the scan opens the weight dialog, it never becomes a unit sale", () => {
    expect(resolveScan(index, stock, "2000000000011")).toEqual({ kind: "OPEN_WEIGHT", product: vacio });
  });

  it("a blank code resolves to nothing at all", () => {
    expect(resolveScan(index, stock, "  ")).toBeNull();
  });

  it("a product that is not in this branch catalog (not enabled here) resolves exactly like an unknown code", () => {
    const avenidaIndex = buildBarcodeIndex([vacio]); // the branch catalog has no Coca Cola
    expect(resolveScan(avenidaIndex, stock, "7790895000010")).toEqual({ kind: "NOT_FOUND", code: "7790895000010" });
    expect(resolveScan(avenidaIndex, stock, "2000000000011")).toEqual({ kind: "OPEN_WEIGHT", product: vacio });
  });
});
