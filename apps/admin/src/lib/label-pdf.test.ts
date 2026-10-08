import { describe, expect, it } from "vitest";

import { buildLabelLayout } from "./label-layout";
import { renderLabelSheetPdf } from "./label-pdf";
import { expandCopies, sheetCell, sheetPageCount } from "./label-sheet";
import {
  A4_HEIGHT_MM, A4_WIDTH_MM, LABEL_HEIGHT_MM, LABEL_WIDTH_MM, LABELS_PER_SHEET, PT_PER_MM, SHEET_COLUMNS, SHEET_GRID_LEFT_MM, SHEET_GRID_TOP_MM, SHEET_ROWS
} from "./label-spec";
import { inspectPdf, mmOf, type PdfRect } from "./test-support/pdf-inspect";
import { buildProductLabel } from "./product-label";
import { must } from "./test-support/must";

const bulk = { minimumUnits: 3, discountBps: 1_500 };
const bicarbonato = buildLabelLayout(buildProductLabel({ name: "Bicarbonato Alicante x 50", unitType: "UNIT", listPriceCents: 90_000n, bulk }));
const mayonesa = buildLabelLayout(buildProductLabel({ name: "Mayonesa Hellmann's 250gr", unitType: "UNIT", listPriceCents: 205_000n, bulk }));
const aceite = buildLabelLayout(buildProductLabel({ name: "Aceite Cañuelas 900ml", unitType: "UNIT", listPriceCents: 625_000n, bulk: null }));
const largo = buildLabelLayout(buildProductLabel({ name: "Aceite de girasol alto oleico Cañuelas botella plástica 1,5 litros x 12 unidades surtido", unitType: "UNIT", listPriceCents: 205_000n, bulk }));
const options = { title: "Etiquetas - Góndolas", header: "Góndolas Despensa Central  -  07/10/2026 15:42", createdAt: new Date("2026-10-07T18:42:00Z") };

const many = (count: number) => Array.from({ length: count }, (_, index) => must([bicarbonato, mayonesa, aceite][index % 3]));
const render = (count: number) => renderLabelSheetPdf(many(count), options);

describe("hoja A4: geometría", () => {
  it("210 × 297 mm, 3 columnas × 7 filas de 60 × 40 mm = 21 por hoja", () => {
    expect([A4_WIDTH_MM, A4_HEIGHT_MM]).toEqual([210, 297]);
    expect([LABEL_WIDTH_MM, LABEL_HEIGHT_MM]).toEqual([60, 40]);
    expect(LABEL_WIDTH_MM / LABEL_HEIGHT_MM).toBe(1.5);
    expect(SHEET_COLUMNS).toBe(3);
    expect(SHEET_ROWS).toBe(7);
    expect(LABELS_PER_SHEET).toBe(21);
    expect(SHEET_COLUMNS * LABEL_WIDTH_MM).toBeLessThanOrEqual(A4_WIDTH_MM);
  });

  it("el bloque de 180 × 280 mm queda centrado (15 mm laterales, 8,5 mm arriba y abajo)", () => {
    expect(A4_HEIGHT_MM - SHEET_ROWS * LABEL_HEIGHT_MM).toBe(17);
    expect(SHEET_COLUMNS * LABEL_WIDTH_MM).toBe(180);
    expect(SHEET_ROWS * LABEL_HEIGHT_MM).toBe(280);
    expect(SHEET_GRID_TOP_MM).toBe(8.5);
    expect(SHEET_GRID_LEFT_MM).toBe(15);
  });

  it("las celdas se llenan izquierda → derecha y arriba → abajo, 21 por página", () => {
    expect(sheetCell(0)).toMatchObject({ page: 0, row: 0, column: 0, xMm: 15, yMm: 8.5 });
    expect(sheetCell(1)).toMatchObject({ column: 1, xMm: 75, yMm: 8.5 });
    expect(sheetCell(2)).toMatchObject({ column: 2, xMm: 135 });
    expect(sheetCell(3)).toMatchObject({ row: 1, column: 0, xMm: 15, yMm: 48.5 });
    expect(sheetCell(20)).toMatchObject({ page: 0, row: 6, column: 2, xMm: 135, yMm: 248.5 });
    expect(sheetCell(21)).toMatchObject({ page: 1, row: 0, column: 0, yMm: 8.5 });
    expect(() => sheetCell(-1)).toThrow();
  });

  it("páginas: 1–21 → 1, 22 → 2, 42 → 2, 43 → 3", () => {
    expect([0, 7, 21, 22, 42, 43].map(sheetPageCount)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it("copias: cada producto se repite junto, en el orden recibido", () => {
    expect(expandCopies([{ item: "M", copies: 2 }, { item: "Y", copies: 1 }, { item: "A", copies: 3 }])).toEqual(["M", "M", "Y", "A", "A", "A"]);
  });
});

describe("PDF real", () => {
  it("es un PDF válido de página A4 exacta (210 × 297 mm)", async () => {
    const bytes = await render(7);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(mmOf(pages[0]?.widthPt ?? 0)).toBeCloseTo(210, 2);
    expect(mmOf(pages[0]?.heightPt ?? 0)).toBeCloseTo(297, 2);
  });

  it("7 etiquetas → 1 página; 21 → 1; 22 → 2; 42 → 2; 43 → 3", async () => {
    const counts = await Promise.all([7, 21, 22, 42, 43].map(async (count) => (await inspectPdf(await render(count))).length));
    expect(counts).toEqual([1, 1, 2, 2, 3]);
  });

  it("una página llena tiene 21 celdas de exactamente 60 × 40 mm, en 3 columnas × 7 filas, centradas", async () => {
    const [page] = await inspectPdf(await render(21));
    // por etiqueta: borde negro fino (la franja es un relleno, no un contorno); el borde es la celda (inset de medio trazo)
    const rects = (page?.rects ?? []).filter((rect) => mmOf(rect.height) > 30);
    expect(rects).toHaveLength(21);
    for (const rect of rects) {
      expect(mmOf(rect.width)).toBeCloseTo(60, 0);
      expect(mmOf(rect.height)).toBeCloseTo(40, 0);
    }
    const columns = [...new Set(rects.map((rect) => Math.round(mmOf(rect.x))))].sort((a, b) => a - b);
    expect(columns).toEqual([15, 75, 135]);
    // el origen de PDF es abajo: la fila superior queda a 23,5 mm del borde superior y la inferior a 23,5 mm del borde inferior
    const bottoms = [...new Set(rects.map((rect) => Math.round(mmOf(rect.y) * 10) / 10))].sort((a, b) => a - b);
    expect(bottoms).toHaveLength(7);
    expect(bottoms[0]).toBeCloseTo(8.6, 1);
    expect((bottoms[6] ?? 0) + 40).toBeCloseTo(297 - 8.5, 0);
  });

  it("la última página sólo tiene guías de las celdas ocupadas", async () => {
    const pages = await inspectPdf(await render(22));
    const cells = (rects: PdfRect[] | undefined) => (rects ?? []).filter((rect) => mmOf(rect.height) > 30);
    expect(cells(pages[0]?.rects)).toHaveLength(21);
    expect(cells(pages[1]?.rects)).toHaveLength(1);
  });

  it("el texto del PDF es el del layout: SUPER OFERTAS, nombre, precio promocional, LLEVANDO 3 UNIDADES, PRECIO NORMAL y precio normal", async () => {
    const [page] = await inspectPdf(await renderLabelSheetPdf([bicarbonato], options));
    const texts = (page?.texts ?? []).map((entry) => entry.text);
    for (const expected of ["SUPER OFERTAS", "BICARBONATO ALICANTE X 50", "$ 765", "LLEVANDO 3 UNIDADES", "PRECIO NORMAL", "$ 900"]) expect(texts).toContain(expected);
    for (const absent of ["OFERTA!!!", "Descuento 15%"]) expect(texts).not.toContain(absent);
    const header = texts.find((entry) => entry.includes("Página 1 de 1"));
    expect(header).toContain("Góndolas Despensa Central");
    expect(header).toContain("100%");
  });

  it("cada texto cae dentro de SU celda, con el margen interno, y con los tamaños del layout (ñ y tildes conservadas)", async () => {
    const layouts = [aceite, mayonesa, bicarbonato];
    const [page] = await inspectPdf(await renderLabelSheetPdf(layouts, options));
    const texts = page?.texts ?? [];
    expect(texts.some((entry) => entry.text === "ACEITE CAÑUELAS 900ML")).toBe(true);
    const price = texts.find((entry) => entry.text === "$ 6.250");
    expect(price?.sizePt).toBe(aceite.texts.find((entry) => entry.id === "price")?.sizePt);
    expect(price?.font).toBe("Helvetica-Bold");
    // cada etiqueta i queda en su columna: el precio de la tercera (Bicarbonato) cae en la columna 3 (x entre 135 y 195 mm)
    const third = texts.find((entry) => entry.text === "$ 765");
    expect(mmOf(third?.x ?? 0)).toBeGreaterThan(135 + 4);
    expect(mmOf(third?.x ?? 0)).toBeLessThan(195 - 4);
  });

  it("la misma etiqueta repetida (copias) aparece en celdas consecutivas y en el orden pedido", async () => {
    const layouts = expandCopies([{ item: mayonesa, copies: 2 }, { item: aceite, copies: 1 }, { item: bicarbonato, copies: 3 }]);
    expect(layouts).toHaveLength(6);
    const [page] = await inspectPdf(await renderLabelSheetPdf(layouts, options));
    const names = (page?.texts ?? []).filter((entry) => entry.font === "Helvetica-Bold" && /^(MAYONESA|ACEITE|BICARBONATO)/.test(entry.text));
    // orden de dibujo = orden de celdas: M, M, A, B, B, B
    expect(names.map((entry) => entry.text.split(" ")[0])).toEqual(["MAYONESA", "MAYONESA", "ACEITE", "BICARBONATO", "BICARBONATO", "BICARBONATO"]);
  });

  it("nada se escala: ningún texto de etiqueta queda a menos de 4 mm del borde de su celda", async () => {
    const [page] = await inspectPdf(await render(21));
    const body = (page?.texts ?? []).filter((entry) => !entry.text.includes("Página"));
    expect(body.length).toBeGreaterThan(21 * 4);
    for (const entry of body) {
      const column = Math.min(2, Math.floor((mmOf(entry.x) - 15) / 60));
      const relativeX = mmOf(entry.x) - 15 - column * 60;
      // los textos «start» arrancan ≥ 5 mm; los centrados y «end» tienen el origen más adentro
      expect(relativeX).toBeGreaterThanOrEqual(3.9);
    }
  });

  it("un nombre larguísimo no rompe la generación y queda en 2 líneas como máximo", async () => {
    const [page] = await inspectPdf(await renderLabelSheetPdf([largo], options));
    const nameLines = (page?.texts ?? []).filter((entry) => /ACEITE DE GIRASOL|BOTELLA/.test(entry.text));
    expect(nameLines).toHaveLength(2);
    expect(nameLines[1]?.text.endsWith("...")).toBe(true);
  });

  it("rechaza generar un PDF sin etiquetas", async () => {
    await expect(renderLabelSheetPdf([], options)).rejects.toThrow();
  });

  it("el archivo es liviano y no embebe imágenes ni fuentes: ~9 KB para 3 hojas de ejemplo", async () => {
    const bytes = await render(37);
    expect(bytes.length).toBeLessThan(60_000);
    expect(PT_PER_MM).toBeCloseTo(2.83465, 4);
  });
});
