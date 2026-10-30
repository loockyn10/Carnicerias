import { PDFDocument } from "pdf-lib";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OfferSignPagePreview } from "../components/offer-sign-preview";
import { buildOfferSign, isOfferSignFormat, OFFER_SIGN_FORMATS, paginateSigns, signPageCount, signsPerPage, type OfferSign, type OfferSignFormat } from "./offer-sign";
import {
  ANTON_CAP_EM, MM_PER_PT, OFFER_GUTTER_MM, OFFER_MARGIN_MM, OFFER_PAGE_MM, OFFER_PANEL_MM, buildSignLayout, buildSignPage, type SignBrand, type SignLayout
} from "./offer-sign-layout";
import { parseOfferSignRequest } from "./offer-sign-run";
import { renderOfferSignPdf } from "./offer-sign-pdf";
import { choricito, conCentavos, costilla, filetPechuga, hamburguesas, nombreLargo, pataMuslo } from "./test-support/offer-sign-fixtures";
import { must } from "./test-support/must";

const WITH_LOGO: SignBrand = { hasLogo: true, name: "SUPER OFERTAS" };
const sign = (row: Record<string, unknown>): OfferSign => must(buildOfferSign(row));
const pool = () => [choricito(), pataMuslo(), filetPechuga(), costilla(), hamburguesas(), nombreLargo(), conCentavos()];
/** `count` carteles con promociones distintas (el id se hace único para poder contar cada oferta exactamente una vez). */
const signs = (count: number): OfferSign[] => Array.from({ length: count }, (_, index) => ({ ...sign(must(pool()[index % pool().length])), promotionId: `promo-${String(index)}` }));

async function render(list: OfferSign[], format: OfferSignFormat) {
  const pages = paginateSigns(list, format).map((group) => buildSignPage(group, format, WITH_LOGO));
  return { pages, bytes: await renderOfferSignPdf(pages, { title: "Carteles", logoPng: null, createdAt: new Date("2026-10-13T12:00:00Z") }) };
}

const sizeOf = (layout: SignLayout, text: string) => must(layout.texts.find((entry) => entry.text === text), text).sizePt;

describe("selector y pedido", () => {
  it("ofrece 1, 2, 3, 4 y 6 por hoja, en ese orden", () => {
    expect(OFFER_SIGN_FORMATS.map((format) => format.perPage)).toEqual([1, 2, 3, 4, 6]);
    expect(isOfferSignFormat("MEDIUM_HALF")).toBe(true);
    expect(isOfferSignFormat("STRIP_HALF")).toBe(true);
    expect(isOfferSignFormat("X")).toBe(false);
    const valid = { branchId: "a0000000-0000-4000-8000-0000000000b1", promotionIds: ["a0000000-0000-4000-8000-000000000001"] };
    expect(parseOfferSignRequest({ ...valid, format: "MEDIUM_HALF" }).ok).toBe(true);
    expect(parseOfferSignRequest({ ...valid, format: "STRIP_HALF" }).ok).toBe(true);
  });
});

describe("4 por hoja (deriva del mediano) y 6 por hoja (deriva de la tira)", () => {
  it("paginación: 4-up 1→1, 4→1, 5→2, 8→2, 9→3 · 6-up 1→1, 6→1, 7→2, 12→2, 13→3", () => {
    for (const [count, pages] of [[1, 1], [4, 1], [5, 2], [8, 2], [9, 3]] as const) expect(signPageCount("MEDIUM_HALF", count)).toBe(pages);
    for (const [count, pages] of [[1, 1], [6, 1], [7, 2], [12, 2], [13, 3]] as const) expect(signPageCount("STRIP_HALF", count)).toBe(pages);
    expect(signsPerPage("MEDIUM_HALF")).toBe(4);
    expect(signsPerPage("STRIP_HALF")).toBe(6);
  });

  it("mismo ancho que su base y media altura (menos media separación)", () => {
    for (const [half, base] of [["MEDIUM_HALF", "MEDIUM"], ["STRIP_HALF", "STRIP"]] as const) {
      expect(OFFER_PANEL_MM[half].width).toBe(OFFER_PANEL_MM[base].width);
      expect(OFFER_PANEL_MM[half].height).toBeCloseTo((OFFER_PANEL_MM[base].height - OFFER_GUTTER_MM) / 2, 9);
      expect(2 * OFFER_PANEL_MM[half].height + OFFER_GUTTER_MM).toBeCloseTo(OFFER_PANEL_MM[base].height, 9);
    }
  });

  it("las ofertas de cada cantidad aparecen exactamente una vez, en el orden elegido, y no se pierde ninguna", async () => {
    for (const [format, counts] of [["MEDIUM_HALF", [1, 4, 5, 8, 9]], ["STRIP_HALF", [1, 6, 7, 12, 13]]] as const) {
      for (const count of counts) {
        const list = signs(count);
        const { pages, bytes } = await render(list, format);
        expect(pages).toHaveLength(signPageCount(format, count));
        expect((await PDFDocument.load(bytes)).getPageCount()).toBe(pages.length);
        const printed = pages.flatMap((page) => page.panels.map((panel) => panel.layout.texts.find((text) => text.text === "OFERTA")));
        expect(printed.every(Boolean)).toBe(true);
        expect(pages.reduce((total, page) => total + page.panels.length, 0)).toBe(count);
        expect(paginateSigns(list, format).flat().map((entry) => entry.promotionId)).toEqual(list.map((entry) => entry.promotionId));
      }
    }
  });

  it("4-up: dos columnas y dos filas dentro de la hoja; 6-up: tres columnas y dos filas", () => {
    for (const [format, columns] of [["MEDIUM_HALF", 2], ["STRIP_HALF", 3]] as const) {
      const { width, height } = OFFER_PANEL_MM[format];
      const page = buildSignPage(signs(columns * 2), format, WITH_LOGO);
      expect(page.panels).toHaveLength(columns * 2);
      const xs = [...new Set(page.panels.map((panel) => panel.x))];
      const ys = [...new Set(page.panels.map((panel) => panel.y))];
      expect(xs).toHaveLength(columns);
      expect(ys).toEqual([OFFER_MARGIN_MM, OFFER_MARGIN_MM + height + OFFER_GUTTER_MM]);
      expect(must(ys[1]) + height).toBeCloseTo(OFFER_PAGE_MM.height - OFFER_MARGIN_MM, 9);
      expect(Math.max(...xs) + width).toBeCloseTo(OFFER_PAGE_MM.width - OFFER_MARGIN_MM, 9);
      // Orden de lectura: fila 1 de izquierda a derecha y después fila 2.
      expect(page.panels.map((panel) => [panel.x, panel.y])).toEqual(ys.flatMap((y) => xs.map((x) => [x, y])));
    }
  });

  it("líneas de corte: las verticales de la base + una horizontal central, todas finas", () => {
    const baseRules = (base: "MEDIUM" | "STRIP") => buildSignPage(signs(3), base, WITH_LOGO).rules;
    for (const [half, base] of [["MEDIUM_HALF", "MEDIUM"], ["STRIP_HALF", "STRIP"]] as const) {
      const rules = buildSignPage(signs(6), half, WITH_LOGO).rules;
      const vertical = rules.filter((rule) => rule.x1 === rule.x2);
      expect(vertical).toEqual(baseRules(base).filter((rule) => rule.x1 === rule.x2));
      const horizontal = rules.filter((rule) => rule.y1 === rule.y2);
      expect(horizontal.length).toBeGreaterThanOrEqual(1);
      const middle = OFFER_MARGIN_MM + OFFER_PANEL_MM[half].height + OFFER_GUTTER_MM / 2;
      for (const rule of horizontal) expect(rule.y1).toBeCloseTo(middle, 9);
      expect(rules.every((rule) => rule.widthMm <= 0.25)).toBe(true);
    }
    // Los formatos de una fila no ganan ninguna línea horizontal.
    for (const format of ["POSTER", "MEDIUM", "STRIP"] as const) expect(buildSignPage(signs(1), format, WITH_LOGO).rules.some((rule) => rule.y1 === rule.y2)).toBe(false);
  });

  it("sin logo ni nombre del negocio; el resto de los textos es el mismo cartel", () => {
    for (const [half, base] of [["MEDIUM_HALF", "MEDIUM"], ["STRIP_HALF", "STRIP"]] as const) {
      for (const row of pool()) {
        const item = sign(row);
        const compact = buildSignLayout(item, half, WITH_LOGO);
        const full = buildSignLayout(item, base, WITH_LOGO);
        expect(compact.logo).toBeNull();
        expect(buildSignLayout(item, half, { hasLogo: false, name: "SUPER OFERTAS" }).texts.some((text) => text.text === "SUPER OFERTAS")).toBe(false);
        expect(full.logo).not.toBeNull();
        for (const word of ["OFERTA", item.condition, item.price.whole]) expect(compact.texts.some((text) => text.text === word), `${half}: ${word}`).toBe(true);
        expect(compact.texts.some((text) => text.text.startsWith(item.unitLabel)), `${half}: ${item.unitLabel}`).toBe(true);
        expect(compact.texts.some((text) => text.text === item.normalPrice)).toBe(Boolean(item.normalPrice));
      }
    }
  });

  it("todo entra en el cartel, el precio es lo más grande y no choca con el producto ni la condición", () => {
    for (const format of ["MEDIUM_HALF", "STRIP_HALF"] as const) {
      const { width, height } = OFFER_PANEL_MM[format];
      for (const row of pool()) {
        const layout = buildSignLayout(sign(row), format, WITH_LOGO);
        const price = must(layout.texts.find((text) => text.text === sign(row).price.whole));
        expect(price.sizePt).toBe(Math.max(...layout.texts.map((text) => text.sizePt)));
        const priceTop = price.y - ANTON_CAP_EM * price.sizePt * MM_PER_PT;
        const badge = must(layout.rects.find((rect) => rect.fill));
        expect(priceTop, `${format}: precio vs condición`).toBeGreaterThan(badge.y + badge.height);
        for (const text of layout.texts) {
          expect(text.y, `${format}: ${text.text} dentro`).toBeLessThanOrEqual(height);
          if (text.anchor === "middle") expect(text.x).toBeCloseTo(width / 2, 6);
        }
        // Nombre del producto: por encima de la condición, hasta 2 líneas.
        const nameLines = layout.texts.filter((text) => text.y < badge.y && text.text !== "OFERTA");
        expect(nameLines.length).toBeGreaterThanOrEqual(1);
        expect(nameLines.length).toBeLessThanOrEqual(2);
        for (const line of nameLines) expect(line.y).toBeLessThan(badge.y);
        // El precio de la hoja compacta sigue siendo grande (≥ 20 mm de alto de dígito).
        expect(ANTON_CAP_EM * price.sizePt * MM_PER_PT).toBeGreaterThanOrEqual(width < 100 ? 14 : 18);
      }
    }
  });

  it("1, 2 y 3 por hoja conservan su comportamiento (medidas, textos y logo)", () => {
    expect(OFFER_PANEL_MM.POSTER).toEqual({ width: 281, height: 194 });
    expect(OFFER_PANEL_MM.MEDIUM).toEqual({ width: 138, height: 194 });
    expect(OFFER_PANEL_MM.STRIP.height).toBe(194);
    expect(OFFER_PANEL_MM.STRIP.width).toBeCloseTo(271 / 3, 9);
    const item = sign(choricito());
    expect(sizeOf(buildSignLayout(item, "MEDIUM", WITH_LOGO), "OFERTA")).toBe(56);
    expect(sizeOf(buildSignLayout(item, "STRIP", WITH_LOGO), "OFERTA")).toBe(52);
    expect(buildSignLayout(item, "POSTER", WITH_LOGO).logo).toMatchObject({ x: 12, y: 9, width: 90, height: 32, align: "start" });
    expect(buildSignLayout(item, "MEDIUM", WITH_LOGO).logo).toMatchObject({ width: 100, height: 26, align: "middle" });
    expect(buildSignLayout(item, "STRIP", WITH_LOGO).logo).toMatchObject({ width: 70, height: 25, align: "middle" });
    expect(buildSignPage(signs(3), "STRIP", WITH_LOGO).panels.map((panel) => panel.y)).toEqual([8, 8, 8]);
  });

  it("preview y PDF usan la misma composición (mismo SignPage, mismo número de textos y logo)", async () => {
    for (const format of ["MEDIUM_HALF", "STRIP_HALF"] as const) {
      const page = buildSignPage(signs(signsPerPage(format)), format, WITH_LOGO);
      const html = renderToStaticMarkup(<OfferSignPagePreview label="Hoja 1" logoDataUrl="data:image/png;base64,AAAA" page={page} />);
      const textCount = page.panels.reduce((total, panel) => total + panel.layout.texts.length, 0);
      expect((html.match(/<text /g) ?? []).length).toBe(textCount);
      expect(html).not.toContain("offer-sign-logo");
      expect((html.match(/<line /g) ?? []).length).toBe(page.rules.length);
      const { bytes } = await render(signs(signsPerPage(format)), format);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    }
  });
});
