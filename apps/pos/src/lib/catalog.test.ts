import { describe, expect, it } from "vitest";

import { buildCategoryTabs, productMatchesCategory, type CatalogProductLike, type CategoryDirectoryEntryLike } from "./catalog";

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
