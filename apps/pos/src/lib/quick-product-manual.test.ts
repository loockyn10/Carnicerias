import { describe, expect, it } from "vitest";

import { normalizeQuickProductCode, validateQuickProduct } from "./quick-product";

// Alta manual desde el «+» del encabezado: el código se escribe (o se escanea) dentro del modal.
describe("alta manual desde el «+» (código escrito en el modal)", () => {
  it("normalizes the typed code like the server does (no spaces, upper case) and rejects what the server would reject", () => {
    expect(normalizeQuickProductCode(" 7790272 001029 ")).toBe("7790272001029");
    expect(normalizeQuickProductCode("abc-12.3")).toBe("ABC-12.3");
    for (const raw of ["", "  ", "ab", "-ABC", "AB C#", "ñandú", "A".repeat(65)]) expect(normalizeQuickProductCode(raw)).toBeNull();
    expect(normalizeQuickProductCode("A".repeat(64))).toBe("A".repeat(64));
  });

  it("with a typed code the form needs it, and returns it normalized", () => {
    expect(validateQuickProduct({ code: " 779 0272001029", name: "Galletitas X", cost: "", price: "1200" }))
      .toEqual({ ok: true, code: "7790272001029", name: "Galletitas X", priceCents: 120_000n, costCents: null });
    expect(validateQuickProduct({ code: "  ", name: "Galletitas X", cost: "", price: "1200" }))
      .toEqual({ ok: false, errors: { code: "Escaneá o escribí el código de barras" } });
    const invalid = validateQuickProduct({ code: "a", name: "", cost: "", price: "" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(Object.keys(invalid.errors).sort()).toEqual(["code", "name", "price"]);
  });

  it("the scan flow (no typed code) is unchanged: the result carries no code", () => {
    const result = validateQuickProduct({ name: "Galletitas X", cost: "", price: "1200" });
    expect(result).toEqual({ ok: true, name: "Galletitas X", priceCents: 120_000n, costCents: null });
    expect("code" in result).toBe(false);
  });
});
