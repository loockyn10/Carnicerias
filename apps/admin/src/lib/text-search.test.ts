import { describe, expect, it } from "vitest";

import { normalizeSearchText } from "./text-search";

describe("normalizeSearchText", () => {
  it("matches regardless of accents and case", () => {
    expect(normalizeSearchText("Vacío")).toBe(normalizeSearchText("vacio"));
    expect(normalizeSearchText("VACÍO")).toBe(normalizeSearchText("vacio"));
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSearchText("  Chorizo  ")).toBe("chorizo");
  });
});
