import { describe, expect, it } from "vitest";

import { describeBranchPromotion, parseCurrentPackSize, parsePackSizeUnits } from "./unit-promotions";

describe("parsePackSizeUnits (unidades por pack de la ficha del producto)", () => {
  it("vacío = sin pack", () => {
    expect(parsePackSizeUnits("")).toBeNull();
    expect(parsePackSizeUnits("   ")).toBeNull();
  });

  it("acepta un entero entre 2 y 10000", () => {
    expect(parsePackSizeUnits("8")).toBe(8);
    expect(parsePackSizeUnits(" 12 ")).toBe(12);
    expect(parsePackSizeUnits("2")).toBe(2);
    expect(parsePackSizeUnits("10000")).toBe(10_000);
  });

  it.each(["1", "0", "-3", "2,5", "2.5", "abc", "10001", "8 u"])("rechaza %j", (raw) => {
    expect(() => parsePackSizeUnits(raw)).toThrow();
  });
});

describe("parseCurrentPackSize (lo vigente que el formulario trae oculto)", () => {
  it("sin pack", () => {
    expect(parseCurrentPackSize("")).toBeNull();
    expect(parseCurrentPackSize("abc")).toBeNull();
  });
  it("con pack: las unidades guardadas", () => {
    expect(parseCurrentPackSize("8")).toBe(8);
    expect(parseCurrentPackSize(" 12 ")).toBe(12);
  });
});

describe("describeBranchPromotion (promoción global vigente, sólo lectura)", () => {
  it("describe la regla para la lista como 'desde N', nunca 'cada N'", () => {
    expect(describeBranchPromotion(3, 1_500)).toBe("15% OFF desde 3 unidades");
    expect(describeBranchPromotion(4, 1_250)).toBe("12,5% OFF desde 4 unidades");
    expect(describeBranchPromotion(3, 1_500)).not.toMatch(/cada/i);
  });
});
