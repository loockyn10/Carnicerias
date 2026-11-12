import { describe, expect, it } from "vitest";

import { capHeightEm, textWidthPt } from "./label-font";
import { must } from "./test-support/must";
import { sampleLabelData } from "./test-support/vacuum-fixtures";
import { decodeEan13Modules, EAN13_MODULE_COUNT } from "./vacuum-ean";
import { assertLabelDates, buildInfoLabelLayout, buildPriceLabelLayout, buildVacuumLabelLayout, VacuumLabelError, wrapText, type VacuumLabelData, type VacuumLabelLayout } from "./vacuum-label-layout";
import { MM_PER_PT, resolveVacuumLabelDims, THERMAL_DOT_MM, VACUUM_LABEL_DEFAULTS, VACUUM_LABEL_PAD, VACUUM_PRICE_TYPE } from "./vacuum-label-spec";

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

  it("lleva las fechas de elaboración y vencimiento, pero no el lote ni la información sanitaria", () => {
    expect(allText(layout)).toContain("ELAB: 01/11/2026");
    expect(allText(layout)).toContain("VENCE: 08/11/2026");
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

describe("etiqueta COMERCIAL 55 × 44 mm", () => {
  const LEFT = VACUUM_LABEL_PAD.xMm;
  const RIGHT = 55 - VACUUM_LABEL_PAD.xMm;
  const cases: [string, Partial<VacuumLabelData>][] = [
    ["datos de ejemplo", {}],
    ["nombre largo (2 líneas)", { productName: "Bife ancho de chorizo especial premium madurado 21 días envasado" }],
    ["precio de seis cifras", { weightGrams: 4_350, pricePerKgCents: 2_999_900n, totalCents: 13_049_565n }],
    ["peso y precio por kg máximos", { weightGrams: 99_999, pricePerKgCents: 99_999_900n, totalCents: 999_989_000n }],
    ["peso mínimo y total chico", { weightGrams: 50, pricePerKgCents: 1_450_000n, totalCents: 72_500n }]
  ];

  const widthMm = (id: string, layout: VacuumLabelLayout) => {
    const text = must(textOf(layout, id));
    return textWidthPt(text.text, text.sizePt, text.style) * MM_PER_PT;
  };
  const extent = (id: string, layout: VacuumLabelLayout): [number, number] => {
    const text = must(textOf(layout, id));
    const w = widthMm(id, layout);
    return text.anchor === "middle" ? [text.x - w / 2, text.x + w / 2] : text.anchor === "end" ? [text.x - w, text.x] : [text.x, text.x + w];
  };

  it("usa el papel por defecto de 55 × 44 mm (una sola etiqueta por hoja)", () => {
    const layout = buildPriceLabelLayout(sampleLabelData(), DIMS);
    expect([layout.widthMm, layout.heightMm]).toEqual([55, 44]);
    expect(VACUUM_LABEL_DEFAULTS).toEqual({ widthMm: 55, infoHeightMm: 44, priceHeightMm: 44 });
  });

  it("las fechas van en UNA fila: ELAB a la izquierda y VENCE a la derecha, en la misma línea base y con el mismo tamaño", () => {
    const layout = buildPriceLabelLayout(sampleLabelData(), DIMS);
    const elab = must(textOf(layout, "elab"));
    const vence = must(textOf(layout, "vence"));
    expect(elab.text).toBe("ELAB: 01/11/2026");
    expect(vence.text).toBe("VENCE: 08/11/2026");
    expect(elab.y).toBe(vence.y);
    expect(elab.sizePt).toBe(vence.sizePt);
    expect(elab.anchor).toBe("start");
    expect(vence.anchor).toBe("end");
    expect(extent("elab", layout)[1] + VACUUM_PRICE_TYPE.dates.minGapMm).toBeLessThanOrEqual(extent("vence", layout)[0] + 1e-6);
  });

  it("las fechas son legibles: nunca bajan de 6 pt (≈ 2,1 mm de cuerpo) y se muestran con el formato DD/MM/AAAA", () => {
    for (const [, overrides] of cases) {
      const layout = buildPriceLabelLayout(sampleLabelData(overrides), DIMS);
      expect(must(textOf(layout, "elab")).sizePt).toBeGreaterThanOrEqual(VACUUM_PRICE_TYPE.dates.minPt);
      expect(must(textOf(layout, "elab")).text).toMatch(/^ELAB: \d{2}\/\d{2}\/\d{4}$/);
      expect(must(textOf(layout, "vence")).text).toMatch(/^VENCE: \d{2}\/\d{2}\/\d{4}$/);
    }
  });

  it("muestra las fechas que trae el paquete, tal cual, sin calcular el vencimiento desde la vida útil", () => {
    // 01/11 + 7 días daría 08/11; el paquete registró otro vencimiento y ese es el que se imprime.
    const layout = buildPriceLabelLayout(sampleLabelData({ packedOn: "2026-11-01", expiresOn: "2026-11-30" }), DIMS);
    expect(textOf(layout, "vence")?.text).toBe("VENCE: 30/11/2026");
  });

  it("un borrador sin fecha deja el hueco a la vista (no inventa una fecha)", () => {
    const layout = buildPriceLabelLayout(sampleLabelData({ packedOn: "", expiresOn: "" }), DIMS);
    expect(textOf(layout, "elab")?.text).toBe("ELAB: --/--/----");
    expect(textOf(layout, "vence")?.text).toBe("VENCE: --/--/----");
  });

  it.each(cases)("%s: todo entra, sin recortes, sin superposición y sin desborde", (_name, overrides) => {
    const layout = buildPriceLabelLayout(sampleLabelData(overrides), DIMS);
    expect(layout.overflow).toBe(false);
    for (const text of layout.texts) {
      expect(text.text).not.toContain("…");
      const [from, to] = extent(text.id, layout);
      expect(from).toBeGreaterThanOrEqual(LEFT - 1e-6);
      expect(to).toBeLessThanOrEqual(RIGHT + 1e-6);
      expect(text.y).toBeLessThanOrEqual(layout.heightMm - VACUUM_LABEL_PAD.bottomMm + 1e-6);
    }
    // Filas (por línea base) en orden y sin pisarse: el tope de cada fila queda por debajo de la línea base de la anterior.
    const rows = [...new Set(layout.texts.map((text) => text.y))].sort((a, b) => a - b);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1] ?? 0;
      const tops = layout.texts.filter((text) => text.y === rows[index]).map((text) => text.y - capHeightEm(text.style) * text.sizePt * MM_PER_PT);
      expect(Math.min(...tops)).toBeGreaterThanOrEqual(previous - 1e-6);
    }
    const lastTextAboveBars = Math.max(...layout.texts.filter((text) => !text.id.startsWith("ean-")).map((text) => text.y));
    for (const bar of layout.bars) { expect(bar.y).toBeGreaterThan(lastTextAboveBars); expect(bar.y + bar.height).toBeLessThanOrEqual(layout.heightMm - VACUUM_LABEL_PAD.bottomMm + 1e-6); }
  });

  it.each(cases)("%s: prioridad visual (precio > peso > precio/kg > fechas > dígitos del EAN) y el precio sigue siendo lo más grande", (_name, overrides) => {
    const layout = buildPriceLabelLayout(sampleLabelData(overrides), DIMS);
    const pt = (id: string) => must(textOf(layout, id)).sizePt;
    expect(pt("price")).toBeGreaterThan(pt("weight"));
    expect(pt("weight")).toBeGreaterThanOrEqual(pt("per-kg"));
    expect(pt("per-kg")).toBeGreaterThan(pt("elab"));
    expect(pt("elab")).toBeGreaterThanOrEqual(pt("ean-digits-left"));
    expect(pt("name-1")).toBeLessThan(pt("price"));
    // Orden vertical: producto, precio, peso, fechas, código.
    const y = (id: string) => must(textOf(layout, id)).y;
    expect(y("name-1")).toBeLessThan(y("price"));
    expect(y("price")).toBeLessThan(y("weight"));
    expect(y("weight")).toBeLessThan(y("elab"));
    expect(y("elab")).toBeLessThan(must(layout.bars[0]).y);
  });

  it("peso y precio por kg comparten fila (peso a la izquierda, precio/kg a la derecha)", () => {
    const layout = buildPriceLabelLayout(sampleLabelData(), DIMS);
    expect(must(textOf(layout, "weight")).y).toBe(must(textOf(layout, "per-kg")).y);
    expect(must(textOf(layout, "weight")).anchor).toBe("start");
    expect(must(textOf(layout, "per-kg")).anchor).toBe("end");
  });

  it.each(cases)("%s: EAN-13 legible a 203 dpi (módulo de puntos enteros, zonas de silencio y altura)", (_name, overrides) => {
    const layout = buildPriceLabelLayout(sampleLabelData(overrides), DIMS);
    const first = must(layout.bars[0]);
    const last = must(layout.bars[layout.bars.length - 1]);
    const moduleMm = first.width;
    const dots = moduleMm / THERMAL_DOT_MM;
    expect(Math.abs(dots - Math.round(dots))).toBeLessThan(0.01);
    expect(Math.round(dots)).toBeGreaterThanOrEqual(3);
    // Zonas de silencio del estándar: 11 módulos a la izquierda y 7 a la derecha, dentro de la etiqueta.
    expect(first.x).toBeGreaterThanOrEqual(11 * moduleMm);
    expect(55 - (last.x + last.width)).toBeGreaterThanOrEqual(7 * moduleMm);
    // El código no se achica por meter las fechas: alto mínimo del 90 % del diseño.
    expect(first.height).toBeGreaterThanOrEqual(VACUUM_PRICE_TYPE.barcode.heightMm * VACUUM_PRICE_TYPE.barcode.minHeightScale - 1e-6);
    // Y decodifica exactamente al EAN-13 con importe incorporado.
    expect(decodeEan13Modules(modulesFromBars(layout))).toBe("2000718052504");
  });

  it("con otro EAN cambian sólo las barras y los dígitos; el resto de la etiqueta no se mueve", () => {
    const a = buildPriceLabelLayout(sampleLabelData(), DIMS);
    const b = buildPriceLabelLayout(sampleLabelData({ ean13: "2000718052504" }), DIMS);
    expect(a.texts).toEqual(b.texts);
  });

  it("si el ancho no alcanza para una fila, las fechas se apilan sin recortarse", () => {
    const narrow = buildPriceLabelLayout(sampleLabelData(), { widthMm: 34, infoHeightMm: 44, priceHeightMm: 60 });
    expect(textOf(narrow, "elab")?.text).toBe("ELAB: 01/11/2026");
    expect(textOf(narrow, "vence")?.text).toBe("VENCE: 08/11/2026");
    expect(must(textOf(narrow, "elab")).y).toBeLessThan(must(textOf(narrow, "vence")).y);
  });
});

describe("assertLabelDates", () => {
  it("acepta fechas válidas", () => {
    expect(() => { assertLabelDates({ packedOn: "2026-11-01", expiresOn: "2026-11-08" }); }).not.toThrow();
  });

  it("rechaza con un mensaje claro una elaboración o un vencimiento faltante o inválido", () => {
    expect(() => { assertLabelDates({ packedOn: "", expiresOn: "2026-11-08" }); }).toThrow(/fecha de elaboración/);
    expect(() => { assertLabelDates({ packedOn: "2026-11-01", expiresOn: "" }); }).toThrow(/fecha de vencimiento/);
    expect(() => { assertLabelDates({ packedOn: "2026-02-30", expiresOn: "2026-11-08" }); }).toThrow(VacuumLabelError);
    expect(() => { assertLabelDates({ packedOn: "2026-11-08", expiresOn: "2026-11-01" }); }).toThrow(/anterior a la elaboración/);
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
