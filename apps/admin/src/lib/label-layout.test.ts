import { describe, expect, it } from "vitest";

import { textWidthPt } from "./label-font";
import { buildLabelLayout, textExtentMm, type LabelLayout, type LabelText } from "./label-layout";
import { LABEL_HEIGHT_MM, LABEL_PAD_BOTTOM_MM, LABEL_PAD_TOP_MM, LABEL_PAD_X_MM, LABEL_TYPE, LABEL_WIDTH_MM, MM_PER_PT } from "./label-spec";
import { buildProductLabel, type ProductLabelInput } from "./product-label";
import { must } from "./test-support/must";

const bulk = { minimumUnits: 3, discountBps: 1_500 };
const layoutOf = (input: ProductLabelInput) => buildLabelLayout(buildProductLabel(input));
const promo = (name: string, list: bigint) => layoutOf({ name, unitType: "UNIT", listPriceCents: list, bulk });
const simple = (name: string, list: bigint) => layoutOf({ name, unitType: "UNIT", listPriceCents: list, bulk: null });
const weight = (name: string, list: bigint) => layoutOf({ name, unitType: "WEIGHT", listPriceCents: list, bulk: null });
const text = (layout: LabelLayout, id: string): LabelText => {
  const found = layout.texts.find((entry) => entry.id === id);
  if (!found) throw new Error(`falta ${id}`);
  return found;
};
const ids = (layout: LabelLayout) => layout.texts.map((entry) => entry.id);

const samples: [string, LabelLayout][] = [
  ["bicarbonato (oferta)", promo("Bicarbonato Alicante x 50", 90_000n)],
  ["mayonesa (oferta, nombre en 2 líneas)", promo("Mayonesa Hellmann's 250gr", 205_000n)],
  ["precio con centavos", promo("Aceite Cañuelas", 625_000n)],
  ["sin promo", simple("Aceite Cañuelas 900ml", 625_000n)],
  ["por kg", weight("Molida vacuna", 1_100_000n)],
  ["nombre larguísimo", promo("Aceite de girasol alto oleico Cañuelas botella plástica 1,5 litros x 12 unidades surtido", 205_000n)],
  ["precio larguísimo", promo("Producto caro", 123_456_789n)],
  ["sin precio", layoutOf({ name: "Sin precio", unitType: "UNIT", listPriceCents: null, bulk: null })]
];

describe("layout: especificación 60 × 40 mm", () => {
  it("la etiqueta mide exactamente 60 × 40 mm (relación 1,5)", () => {
    for (const [, layout] of samples) expect(layout.widthMm / layout.heightMm).toBe(1.5);
    for (const [, layout] of samples) expect([layout.widthMm, layout.heightMm]).toEqual([60, 40]);
  });

  it("oferta UNIT: orden vertical OFERTA → nombre → POR N UNIDADES → Descuento → precio → fila PRECIO NORMAL", () => {
    const layout = promo("Bicarbonato Alicante x 50", 90_000n);
    expect(ids(layout)).toEqual(["headline", "name-1", "condition", "discount", "price", "normal-label", "normal-price"]);
    const baselines = ["headline", "name-1", "condition", "discount", "price", "normal-label"].map((id) => text(layout, id).y);
    expect([...baselines].sort((a, b) => a - b)).toEqual(baselines);
    expect(text(layout, "normal-label").y).toBe(text(layout, "normal-price").y);
  });

  it("tipografía: OFERTA!!! en negrita cursiva grande, nombre/condición/descuento en negrita, todo centrado salvo la fila inferior", () => {
    const layout = promo("Bicarbonato Alicante x 50", 90_000n);
    expect(text(layout, "headline")).toMatchObject({ text: "OFERTA!!!", style: "boldItalic", sizePt: LABEL_TYPE.headline.pt, anchor: "middle", x: 30 });
    expect(text(layout, "name-1")).toMatchObject({ style: "bold", sizePt: LABEL_TYPE.name.maxPt, anchor: "middle" });
    expect(text(layout, "condition")).toMatchObject({ text: "POR 3 UNIDADES", style: "bold", sizePt: LABEL_TYPE.condition.pt, anchor: "middle" });
    expect(text(layout, "discount")).toMatchObject({ text: "Descuento 15%", style: "bold", sizePt: LABEL_TYPE.discount.pt, anchor: "middle" });
    expect(text(layout, "normal-label")).toMatchObject({ text: "PRECIO NORMAL", anchor: "start", x: LABEL_PAD_X_MM });
    expect(text(layout, "normal-price")).toMatchObject({ text: "$ 900", anchor: "end", x: LABEL_WIDTH_MM - LABEL_PAD_X_MM });
  });

  it("«POR 3 UNIDADES» va subrayado (una línea fina bajo su línea base, del ancho del texto)", () => {
    const layout = promo("Bicarbonato Alicante x 50", 90_000n);
    const condition = text(layout, "condition");
    const rule = layout.rules.find((entry) => entry.id === "condition-underline");
    expect(rule).toBeDefined();
    expect(rule?.y1).toBeGreaterThan(condition.y);
    expect(rule?.y1).toBe(rule?.y2);
    const width = textWidthPt(condition.text, condition.sizePt, condition.style) * MM_PER_PT;
    expect((rule?.x2 ?? 0) - (rule?.x1 ?? 0)).toBeCloseTo(width, 1);
    expect(rule?.widthMm).toBeGreaterThan(0.1);
    expect(rule?.widthMm).toBeLessThan(0.5);
    // las variantes sin oferta no llevan subrayado
    expect(simple("Aceite", 625_000n).rules).toEqual([]);
  });

  it("el precio es SIEMPRE el elemento más grande de la etiqueta", () => {
    for (const [name, layout] of samples) {
      const price = text(layout, "price");
      const others = layout.texts.filter((entry) => entry.id !== "price" && entry.id !== "price-suffix");
      for (const other of others) expect(price.sizePt, `${name}: ${other.id}`).toBeGreaterThan(other.sizePt);
    }
    expect(text(promo("Bicarbonato Alicante x 50", 90_000n), "price").sizePt).toBe(LABEL_TYPE.price.promoMaxPt);
  });

  it("sin promoción: nombre, «PRECIO», precio grande y «PRECIO UNITARIO» (sin OFERTA, sin POR N UNIDADES, sin Descuento)", () => {
    const layout = simple("Mayonesa Hellmann's 250gr", 205_000n);
    expect(ids(layout)).toEqual(["name-1", "name-2", "top-label", "price", "foot-label"].filter((id) => ids(layout).includes(id)));
    expect(text(layout, "top-label").text).toBe("PRECIO");
    expect(text(layout, "price").text).toBe("$ 2.050");
    expect(text(layout, "foot-label").text).toBe("PRECIO UNITARIO");
    const joined = layout.texts.map((entry) => entry.text).join("|");
    expect(joined).not.toMatch(/OFERTA|POR \d|Descuento|NORMAL/);
    expect(text(layout, "price").sizePt).toBe(LABEL_TYPE.price.simpleMaxPt);
  });

  it("por kg: «/kg» pequeño pegado al precio, en la misma línea base, y el conjunto centrado", () => {
    const layout = weight("Molida vacuna", 1_100_000n);
    const price = text(layout, "price");
    const suffix = text(layout, "price-suffix");
    expect(suffix.text).toBe("/kg");
    expect(suffix.y).toBe(price.y);
    expect(suffix.sizePt).toBeCloseTo(price.sizePt * LABEL_TYPE.priceSuffix.scale, 1);
    const left = textExtentMm(price).left;
    const right = textExtentMm(suffix).right;
    expect((left + right) / 2).toBeCloseTo(30, 0);
  });

  it("ningún texto invade el margen interno lateral ni se sale del alto útil (todas las variantes, incluso nombre y precio larguísimos)", () => {
    for (const [name, layout] of samples) {
      for (const entry of layout.texts) {
        const { left, right } = textExtentMm(entry);
        expect(left, `${name}: ${entry.id} izquierda`).toBeGreaterThanOrEqual(LABEL_PAD_X_MM - 0.05);
        expect(right, `${name}: ${entry.id} derecha`).toBeLessThanOrEqual(LABEL_WIDTH_MM - LABEL_PAD_X_MM + 0.05);
        expect(entry.y, `${name}: ${entry.id} arriba`).toBeGreaterThan(LABEL_PAD_TOP_MM);
        expect(entry.y, `${name}: ${entry.id} abajo`).toBeLessThanOrEqual(LABEL_HEIGHT_MM - LABEL_PAD_BOTTOM_MM + 0.05);
      }
    }
  });

  it("el tope de cada texto no pisa al anterior (separación vertical positiva entre bloques)", () => {
    for (const [name, layout] of samples) {
      const ordered = [...layout.texts].filter((entry) => entry.id !== "price-suffix" && entry.id !== "normal-price").sort((a, b) => a.y - b.y);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = must(ordered[index - 1]);
        const current = must(ordered[index]);
        const currentTop = current.y - current.sizePt * MM_PER_PT * 0.718;
        expect(currentTop, `${name}: ${previous.id} → ${current.id}`).toBeGreaterThan(previous.y + 0.5);
      }
    }
  });

  it("en la fila inferior «PRECIO NORMAL» y su precio no se superponen", () => {
    for (const [, layout] of samples.filter(([, entry]) => entry.variant === "PROMO")) {
      const label = textExtentMm(text(layout, "normal-label"));
      const price = textExtentMm(text(layout, "normal-price"));
      expect(label.right + 1).toBeLessThan(price.left);
    }
  });

  it("nombre: hasta 2 líneas; el nombre largo reduce la letra (piso 7 pt) y, si aun así no entra, se corta con «...»", () => {
    const short = promo("Bicarbonato Alicante x 50", 90_000n);
    expect(ids(short).filter((id) => id.startsWith("name-"))).toEqual(["name-1"]);
    const medium = promo("Mayonesa Hellmann's Light Premium 250gr", 205_000n);
    expect(ids(medium).filter((id) => id.startsWith("name-"))).toEqual(["name-1", "name-2"]);
    // con 2 líneas el alto es justo: la tipografía se reduce apenas (≤ 10 %) para conservar el aire entre bloques
    expect(text(medium, "name-1").sizePt).toBeGreaterThanOrEqual(LABEL_TYPE.name.maxPt * 0.9);
    expect(text(medium, "name-1").sizePt).toBeLessThanOrEqual(LABEL_TYPE.name.maxPt);
    const long = must(samples.find(([name]) => name === "nombre larguísimo")?.[1]);
    expect(ids(long).filter((id) => id.startsWith("name-"))).toHaveLength(2);
    expect(text(long, "name-1").sizePt).toBeLessThan(LABEL_TYPE.name.maxPt);
    expect(text(long, "name-1").sizePt).toBeGreaterThanOrEqual(LABEL_TYPE.name.minPt);
    expect(text(long, "name-2").text.endsWith("...")).toBe(true);
    // un nombre de 2 líneas ya no ocupa el lugar de otros elementos: sigue entrando todo
    expect(text(long, "normal-label").y).toBeLessThanOrEqual(LABEL_HEIGHT_MM - LABEL_PAD_BOTTOM_MM + 0.05);
  });

  it("un precio muy largo se achica para entrar a lo ancho pero sigue siendo el más grande", () => {
    const layout = must(samples.find(([name]) => name === "precio larguísimo")?.[1]);
    expect(text(layout, "price").sizePt).toBeLessThan(LABEL_TYPE.price.promoMaxPt);
    expect(text(layout, "price").sizePt).toBeGreaterThanOrEqual(LABEL_TYPE.price.minPt);
  });

  it("aprovecha el alto de 40 mm: el contenido ocupa casi todo el alto útil", () => {
    for (const [name, layout] of samples.filter(([, entry]) => entry.variant === "PROMO")) {
      const first = must(layout.texts[0]);
      const last = must(layout.texts[layout.texts.length - 1]);
      expect(first.y - first.sizePt * MM_PER_PT * 0.718, name).toBeLessThan(LABEL_PAD_TOP_MM + 2);
      expect(LABEL_HEIGHT_MM - last.y, name).toBeLessThan(LABEL_PAD_BOTTOM_MM + 2);
    }
  });

  it("es determinístico: los mismos datos dan exactamente el mismo layout", () => {
    expect(promo("Mayonesa Hellmann's 250gr", 205_000n)).toEqual(promo("Mayonesa Hellmann's 250gr", 205_000n));
  });
});
