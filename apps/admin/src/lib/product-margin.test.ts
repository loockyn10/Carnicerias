import { describe, expect, it } from "vitest";

import { bpsToPercentField, describeMarginRule, effectiveMarginRule, parseCurrentCustomMargin, parseCustomMarginForm, parseCustomMarginPercent } from "./product-margin";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("effectiveMarginRule: prioridad propio > categoría excluida (manual) > global", () => {
  it("sin margen propio y categoría normal → margen global (ACEITE 40 %)", () => {
    expect(effectiveMarginRule({ customMarginBps: null, globalMarginBps: 4_000, excludedCategory: false })).toEqual({ kind: "GLOBAL", bps: 4_000 });
  });

  it("margen propio 30 % con global 40 % → usa el 30 % (YERBA)", () => {
    expect(effectiveMarginRule({ customMarginBps: 3_000, globalMarginBps: 4_000, excludedCategory: false })).toEqual({ kind: "CUSTOM", bps: 3_000 });
  });

  it("categoría excluida sin margen propio → precio manual (VACÍO)", () => {
    expect(effectiveMarginRule({ customMarginBps: null, globalMarginBps: 4_000, excludedCategory: true })).toEqual({ kind: "MANUAL", bps: null });
  });

  it("categoría excluida CON margen propio 25 % → automático con ese margen", () => {
    expect(effectiveMarginRule({ customMarginBps: 2_500, globalMarginBps: 4_000, excludedCategory: true })).toEqual({ kind: "CUSTOM", bps: 2_500 });
  });

  it("el margen propio funciona aunque no haya margen global; sin ninguno → sin margen", () => {
    expect(effectiveMarginRule({ customMarginBps: 2_500, globalMarginBps: null, excludedCategory: false })).toEqual({ kind: "CUSTOM", bps: 2_500 });
    expect(effectiveMarginRule({ customMarginBps: null, globalMarginBps: null, excludedCategory: false })).toEqual({ kind: "NONE", bps: null });
  });

  it("describe la regla como en la carga masiva: Global 40% / Propio 30% / Precio manual", () => {
    expect(describeMarginRule({ kind: "GLOBAL", bps: 4_000 })).toBe("Global 40%");
    expect(describeMarginRule({ kind: "CUSTOM", bps: 3_000 })).toBe("Propio 30%");
    expect(describeMarginRule({ kind: "CUSTOM", bps: 3_250 })).toBe("Propio 32,5%");
    expect(describeMarginRule({ kind: "MANUAL", bps: null })).toBe("Precio manual");
    expect(describeMarginRule({ kind: "NONE", bps: null })).toBe("Sin margen");
  });
});

describe("parseCustomMarginPercent: basis points enteros, mismos límites que el margen global", () => {
  it.each([["30", 3_000], ["32,5", 3_250], ["32.50", 3_250], ["0,01", 1], ["99,99", 9_999], ["25", 2_500]])("%s → %d", (raw, bps) => {
    expect(parseCustomMarginPercent(raw)).toBe(bps);
    expect(Number.isInteger(parseCustomMarginPercent(raw))).toBe(true);
  });

  it.each([["0"], ["100"], ["100,01"], ["-5"], ["abc"], [""], ["  "], ["12,345"], ["1e1"], ["30%"]])("rechaza %j", (raw) => {
    expect(() => parseCustomMarginPercent(raw)).toThrow(/margen personalizado/i);
  });

  it("bps ↔ campo del formulario", () => {
    expect(bpsToPercentField(3_000)).toBe("30");
    expect(bpsToPercentField(3_250)).toBe("32.5");
    expect(bpsToPercentField(null)).toBe("");
  });
});

describe("parseCustomMarginForm: el editor del producto", () => {
  it("«usar configuración general» (o precio manual) → sin margen propio (null), aunque haya un número escrito", () => {
    expect(parseCustomMarginForm(form({ margin_mode: "default", custom_margin: "30" }))).toBeNull();
    expect(parseCustomMarginForm(form({}))).toBeNull();
  });

  it("«usar margen personalizado» + 30 → 3000", () => {
    expect(parseCustomMarginForm(form({ margin_mode: "custom", custom_margin: "30" }))).toBe(3_000);
    expect(parseCustomMarginForm(form({ margin_mode: "custom", custom_margin: "25,5" }))).toBe(2_550);
  });

  it("«usar margen personalizado» sin número o fuera de rango → error (no se escribe nada)", () => {
    expect(() => parseCustomMarginForm(form({ margin_mode: "custom", custom_margin: "" }))).toThrow(/Completá/);
    expect(() => parseCustomMarginForm(form({ margin_mode: "custom", custom_margin: "100" }))).toThrow(/margen personalizado/i);
    expect(() => parseCustomMarginForm(form({ margin_mode: "custom", custom_margin: "0" }))).toThrow(/mayor a 0/);
  });

  it("el margen vigente que viaja como referencia: vacío o inválido → no tenía", () => {
    expect(parseCurrentCustomMargin("3000")).toBe(3_000);
    expect(parseCurrentCustomMargin("")).toBeNull();
    expect(parseCurrentCustomMargin("abc")).toBeNull();
    expect(parseCurrentCustomMargin("0")).toBeNull();
    expect(parseCurrentCustomMargin("10000")).toBeNull();
  });
});
