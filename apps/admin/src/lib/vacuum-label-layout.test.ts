import { describe, expect, it } from "vitest";

import { sampleLabelData } from "./test-support/vacuum-fixtures";
import { decodeEan13Modules, EAN13_MODULE_COUNT } from "./vacuum-ean";
import { buildInfoLabelLayout, buildPriceLabelLayout, buildVacuumLabelLayout, wrapText, type VacuumLabelLayout } from "./vacuum-label-layout";
import { resolveVacuumLabelDims, VACUUM_LABEL_DEFAULTS } from "./vacuum-label-spec";

const DIMS = resolveVacuumLabelDims(null);
const textOf = (layout: VacuumLabelLayout, id: string) => layout.texts.find((text) => text.id === id);
const allText = (layout: VacuumLabelLayout) => layout.texts.map((text) => text.text).join("\n");

/** Reconstruye los módulos del código a partir de las barras dibujadas (verifica el dibujo, no sólo el número). */
function modulesFromBars(layout: VacuumLabelLayout): string {
  const first = layout.bars[0];
  if (!first) throw new Error("no bars");
  // El módulo es el ancho de la barra de la guarda de inicio (1 módulo).
  const moduleMm = first.width;
  const bits = Array.from({ length: EAN13_MODULE_COUNT }, () => "0");
  for (const bar of layout.bars) {
    const start = Math.round((bar.x - first.x) / moduleMm);
    const width = Math.round(bar.width / moduleMm);
    for (let index = start; index < start + width; index += 1) bits[index] = "1";
  }
  return bits.join("");
}

describe("medidas configurables", () => {
  it("los valores por defecto son constantes centralizadas y se pueden sobrescribir", () => {
    expect(DIMS).toEqual(VACUUM_LABEL_DEFAULTS);
    expect(resolveVacuumLabelDims({ widthMm: 58, infoHeightMm: 50, priceHeightMm: 30 })).toEqual({ widthMm: 58, infoHeightMm: 50, priceHeightMm: 30 });
  });

  it("ignora medidas fuera de rango o inválidas", () => {
    expect(resolveVacuumLabelDims({ widthMm: 5, infoHeightMm: Number.NaN, priceHeightMm: 999 })).toEqual(VACUUM_LABEL_DEFAULTS);
  });

  it("el mismo template se adapta a otro alto sin reescribirse (58×40 → 58×50)", () => {
    const small = buildInfoLabelLayout(sampleLabelData(), { widthMm: 58, infoHeightMm: 40, priceHeightMm: 40 });
    const tall = buildInfoLabelLayout(sampleLabelData(), { widthMm: 58, infoHeightMm: 50, priceHeightMm: 40 });
    expect([small.widthMm, small.heightMm]).toEqual([58, 40]);
    expect([tall.widthMm, tall.heightMm]).toEqual([58, 50]);
    expect(allText(tall)).toBe(allText(small));
  });
});

describe("etiqueta de PRECIO", () => {
  const layout = buildPriceLabelLayout(sampleLabelData(), DIMS);

  it("tiene el corte, el precio final, el peso, el precio por kg y el EAN-13", () => {
    expect(textOf(layout, "name-1")?.text).toBe("Vacío");
    expect(textOf(layout, "price")?.text).toBe("$18.052,50");
    expect(textOf(layout, "weight")?.text).toBe("1,245 kg");
    expect(textOf(layout, "per-kg")?.text).toBe("$14.500/kg");
    const digits = [textOf(layout, "ean-digit-first"), textOf(layout, "ean-digits-left"), textOf(layout, "ean-digits-right")].map((text) => text?.text ?? "").join("");
    expect(digits).toBe("2000718052504");
  });

  it("el precio es el texto más grande de la etiqueta", () => {
    const price = textOf(layout, "price")?.sizePt ?? 0;
    for (const text of layout.texts) if (text.id !== "price") expect(text.sizePt).toBeLessThan(price);
  });

  it("no lleva información sanitaria ni de elaboración", () => {
    expect(allText(layout)).not.toMatch(/LOTE|ELABORACI|VENCIMIENTO|Conservar/i);
  });

  it("dibuja barras que decodifican exactamente al EAN-13", () => {
    expect(decodeEan13Modules(modulesFromBars(layout))).toBe("2000718052504");
  });

  it("todo cae dentro del papel", () => {
    for (const text of layout.texts) { expect(text.x).toBeGreaterThanOrEqual(0); expect(text.x).toBeLessThanOrEqual(layout.widthMm); expect(text.y).toBeLessThanOrEqual(layout.heightMm); }
    for (const bar of layout.bars) { expect(bar.x).toBeGreaterThanOrEqual(0); expect(bar.x + bar.width).toBeLessThanOrEqual(layout.widthMm); expect(bar.y + bar.height).toBeLessThanOrEqual(layout.heightMm); }
    expect(layout.overflow).toBe(false);
  });

  it("el preview respeta las proporciones del papel", () => {
    expect(layout.widthMm / layout.heightMm).toBeCloseTo(DIMS.widthMm / DIMS.priceHeightMm, 5);
  });

  it("cambiar el peso o el precio cambia el texto del precio y del peso", () => {
    const other = buildPriceLabelLayout(sampleLabelData({ weightGrams: 800, totalCents: 1_160_000n }), DIMS);
    expect(textOf(other, "price")?.text).toBe("$11.600");
    expect(textOf(other, "weight")?.text).toBe("0,800 kg");
  });

  it("sin esquema EAN configurado muestra el faltante y no dibuja barras", () => {
    const missing = buildPriceLabelLayout(sampleLabelData({ ean13: null }), DIMS);
    expect(missing.bars).toHaveLength(0);
    expect(textOf(missing, "ean-missing")?.text).toBe("EAN-13 SIN CONFIGURAR");
  });

  it("no dibuja un EAN inválido", () => {
    const invalid = buildPriceLabelLayout(sampleLabelData({ ean13: "2000718052505" }), DIMS);
    expect(invalid.bars).toHaveLength(0);
    expect(textOf(invalid, "ean-missing")).toBeDefined();
  });

  it("un nombre largo se achica o recorta pero la etiqueta no se desborda", () => {
    const long = buildPriceLabelLayout(sampleLabelData({ productName: "Bife ancho de chorizo especial premium madurado 21 días envasado" }), DIMS);
    expect(long.overflow).toBe(false);
    const lines = long.texts.filter((text) => text.id.startsWith("name-"));
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});

describe("etiqueta INFORMATIVA", () => {
  const layout = buildInfoLabelLayout(sampleLabelData(), DIMS);

  it("tiene corte, elaboración, vencimiento, lote, peso neto y conservación", () => {
    expect(textOf(layout, "name-1")?.text).toBe("Vacío");
    expect(textOf(layout, "dates-value-left")?.text).toBe("01/11/2026");
    expect(textOf(layout, "dates-value-right")?.text).toBe("08/11/2026");
    expect(textOf(layout, "lot-value-left")?.text).toBe("A1-261101-0001");
    expect(textOf(layout, "lot-value-right")?.text).toBe("1,245 kg");
    expect(allText(layout)).toContain("Conservar entre 0 y 4 °C");
    expect(allText(layout)).toContain("ELABORACIÓN");
    expect(allText(layout)).toContain("VENCIMIENTO");
  });

  it("incluye los datos del establecimiento configurados y omite los que no hay", () => {
    expect(allText(layout)).toContain("Carnicería Fran");
    expect(allText(layout)).toContain("Av. Siempreviva 742");
    expect(allText(layout)).toContain("Establecimiento Nº 1");
    const bare = buildInfoLabelLayout(sampleLabelData({ businessName: null, address: null, establishmentInfo: null, extraText: null, conservationText: null }), DIMS);
    expect(allText(bare)).not.toContain("Carnicería Fran");
    expect(bare.rules.find((rule) => rule.id === "rule-footer")).toBeUndefined();
  });

  it("imprime el texto adicional configurado", () => {
    expect(allText(buildInfoLabelLayout(sampleLabelData({ extraText: "Producto envasado al vacío" }), DIMS))).toContain("Producto envasado al vacío");
  });

  it("no afirma ningún cumplimiento regulatorio por su cuenta", () => {
    const bare = buildInfoLabelLayout(sampleLabelData({ businessName: null, address: null, establishmentInfo: null, extraText: null, conservationText: null }), DIMS);
    expect(allText(bare)).not.toMatch(/SENASA|ANMAT|habilitaci|RNE|RNPA|c[óo]digo alimentario/i);
  });

  it("no lleva el precio ni el código de barras", () => {
    expect(layout.bars).toHaveLength(0);
    expect(allText(layout)).not.toContain("$");
  });

  it("el lote de un borrador todavía no existe y lo aclara", () => {
    expect(allText(buildInfoLabelLayout(sampleLabelData({ lot: null }), DIMS))).toContain("se asigna al registrar");
  });

  it("entra en 58 × 40 con los textos de ejemplo", () => {
    expect(layout.overflow).toBe(false);
    for (const text of layout.texts) expect(text.y).toBeLessThanOrEqual(layout.heightMm);
  });

  it("marca desborde si el alto configurado no alcanza", () => {
    const tiny = buildInfoLabelLayout(sampleLabelData({ extraText: "x ".repeat(80) }), { widthMm: 58, infoHeightMm: 20, priceHeightMm: 40 });
    expect(tiny.overflow).toBe(true);
  });
});

describe("wrapText", () => {
  it("respeta el máximo de líneas y termina en puntos suspensivos", () => {
    const lines = wrapText("uno dos tres cuatro cinco seis siete ocho nueve diez once doce", 20, 7, "regular", 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  it("parte una palabra más larga que la línea", () => {
    const lines = wrapText("Supercalifragilisticoespialidosoextraordinariamentelargo", 15, 7, "regular", 5);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("").replace("…", "")).toContain("Supercal");
  });

  it("devuelve vacío para un texto vacío", () => {
    expect(wrapText("   ", 20, 7, "regular", 3)).toEqual([]);
  });
});

describe("buildVacuumLabelLayout", () => {
  it("elige el template por tipo", () => {
    expect(buildVacuumLabelLayout("INFO", sampleLabelData(), DIMS).kind).toBe("INFO");
    expect(buildVacuumLabelLayout("PRICE", sampleLabelData(), DIMS).kind).toBe("PRICE");
  });
});
