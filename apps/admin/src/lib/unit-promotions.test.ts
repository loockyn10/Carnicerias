import { describe, expect, it } from "vitest";

import { describeBranchPromotion, parseBranchPromotionForm, parsePackSizeUnits } from "./unit-promotions";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

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

describe("parseBranchPromotionForm (promoción global de sucursal)", () => {
  it("cada 3 unidades, 15 % → 3 y 1500 bps", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "central", every_units: "3", discount_percent: "15", active: "on" })))
      .toEqual({ branchId: "central", everyUnits: 3, discountBps: 1_500, active: true });
  });

  it("acepta coma decimal y hasta 2 decimales", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "b", every_units: "4", discount_percent: "12,5", active: "on" })).discountBps).toBe(1_250);
  });

  it("desactivar sólo necesita la sucursal", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "central", every_units: "", discount_percent: "" })))
      .toEqual({ branchId: "central", everyUnits: 0, discountBps: 0, active: false });
  });

  it.each([
    { every_units: "1", discount_percent: "15" },
    { every_units: "3", discount_percent: "0" },
    { every_units: "3", discount_percent: "100" },
    { every_units: "tres", discount_percent: "15" },
    { every_units: "3", discount_percent: "abc" },
    { every_units: "1001", discount_percent: "15" }
  ])("rechaza %j", (values) => {
    expect(() => parseBranchPromotionForm(form({ branch_id: "central", active: "on", ...values }))).toThrow();
  });

  it("exige la sucursal", () => {
    expect(() => parseBranchPromotionForm(form({ every_units: "3", discount_percent: "15", active: "on" }))).toThrow();
  });

  it("describe la regla para la lista", () => {
    expect(describeBranchPromotion(3, 1_500)).toBe("Cada 3 unidades del mismo producto, 15% OFF");
    expect(describeBranchPromotion(4, 1_250)).toBe("Cada 4 unidades del mismo producto, 12,5% OFF");
  });
});
