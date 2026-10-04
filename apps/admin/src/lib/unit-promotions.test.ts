import { describe, expect, it } from "vitest";

import { describeBranchPromotion, parseBranchPromotionForm, parseCurrentPackConfig, parsePackConfigForm, parsePackDiscountBps, parsePackSizeUnits } from "./unit-promotions";

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

describe("parsePackDiscountBps (descuento del pack de la ficha del producto)", () => {
  it("vacío = sin valor", () => {
    expect(parsePackDiscountBps("")).toBeNull();
    expect(parsePackDiscountBps("  ")).toBeNull();
  });

  it("20, 25, 12,5 y 12.5 → basis points enteros (nunca un float)", () => {
    expect(parsePackDiscountBps("20")).toBe(2_000);
    expect(parsePackDiscountBps("25")).toBe(2_500);
    expect(parsePackDiscountBps(" 15 ")).toBe(1_500);
    expect(parsePackDiscountBps("12,5")).toBe(1_250);
    expect(parsePackDiscountBps("12.5")).toBe(1_250);
    expect(parsePackDiscountBps("0,01")).toBe(1);
    expect(parsePackDiscountBps("99,99")).toBe(9_999);
    expect(Number.isInteger(parsePackDiscountBps("33,33"))).toBe(true);
  });

  it.each(["0", "0,00", "100", "100,5", "150", "-5", "abc", "12,345", "20%", "1e1"])("rechaza %j", (raw) => {
    expect(() => parsePackDiscountBps(raw)).toThrow();
  });
});

describe("parsePackConfigForm (unidades por pack + descuento del pack, juntos)", () => {
  it("Leche A: 8 unidades al 20 %; Leche B: 8 al 25 %; Producto C: 12 al 15 %", () => {
    expect(parsePackConfigForm("8", "20")).toEqual({ packSizeUnits: 8, packDiscountBps: 2_000 });
    expect(parsePackConfigForm("8", "25")).toEqual({ packSizeUnits: 8, packDiscountBps: 2_500 });
    expect(parsePackConfigForm("12", "15")).toEqual({ packSizeUnits: 12, packDiscountBps: 1_500 });
  });

  it("sin unidades ni descuento = sin pack", () => {
    expect(parsePackConfigForm("", "")).toEqual({ packSizeUnits: null, packDiscountBps: null });
  });

  it("un pack sin descuento, o un descuento sin pack, es un error (nunca una configuración a medias)", () => {
    expect(() => parsePackConfigForm("8", "")).toThrow(/descuento del pack/i);
    expect(() => parsePackConfigForm("", "25")).toThrow(/unidades por pack/i);
  });

  it("rechaza unidades o descuento inválidos", () => {
    expect(() => parsePackConfigForm("1", "20")).toThrow();
    expect(() => parsePackConfigForm("8", "100")).toThrow();
    expect(() => parsePackConfigForm("8", "0")).toThrow();
    expect(() => parsePackConfigForm("8", "-1")).toThrow();
    expect(() => parsePackConfigForm("ocho", "20")).toThrow();
  });
});

describe("parseCurrentPackConfig (lo vigente que el formulario trae oculto)", () => {
  it("sin pack", () => {
    expect(parseCurrentPackConfig("", "")).toEqual({ packSizeUnits: null, packDiscountBps: null });
  });
  it("con pack: unidades y basis points guardados", () => {
    expect(parseCurrentPackConfig("8", "2500")).toEqual({ packSizeUnits: 8, packDiscountBps: 2_500 });
  });
});

describe("parseBranchPromotionForm (promoción global de sucursal)", () => {
  it("desde 3 unidades, 15 % → 3 y 1500 bps", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "central", minimum_units: "3", discount_percent: "15", active: "on" })))
      .toEqual({ branchId: "central", minimumUnits: 3, discountBps: 1_500, active: true });
  });

  it("acepta coma decimal y hasta 2 decimales", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "b", minimum_units: "4", discount_percent: "12,5", active: "on" })).discountBps).toBe(1_250);
  });

  it("desactivar sólo necesita la sucursal", () => {
    expect(parseBranchPromotionForm(form({ branch_id: "central", minimum_units: "", discount_percent: "" })))
      .toEqual({ branchId: "central", minimumUnits: 0, discountBps: 0, active: false });
  });

  it.each([
    { minimum_units: "1", discount_percent: "15" },
    { minimum_units: "3", discount_percent: "0" },
    { minimum_units: "3", discount_percent: "100" },
    { minimum_units: "tres", discount_percent: "15" },
    { minimum_units: "3", discount_percent: "abc" },
    { minimum_units: "1001", discount_percent: "15" }
  ])("rechaza %j", (values) => {
    expect(() => parseBranchPromotionForm(form({ branch_id: "central", active: "on", ...values }))).toThrow();
  });

  it("exige la sucursal", () => {
    expect(() => parseBranchPromotionForm(form({ minimum_units: "3", discount_percent: "15", active: "on" }))).toThrow();
  });

  it("describe la regla para la lista como 'desde N', nunca 'cada N'", () => {
    expect(describeBranchPromotion(3, 1_500)).toBe("15% OFF desde 3 unidades");
    expect(describeBranchPromotion(4, 1_250)).toBe("12,5% OFF desde 4 unidades");
    expect(describeBranchPromotion(3, 1_500)).not.toMatch(/cada/i);
  });
});
