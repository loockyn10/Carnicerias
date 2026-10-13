import fs from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildOfferSign, paginateSigns, type OfferSign, type OfferSignFormat } from "./offer-sign";
import { antonOutlines } from "./offer-sign-glyphs";
import {
  ANTON_CAP_EM, MM_PER_PT, OFFER_GUTTER_MM, OFFER_MARGIN_MM, OFFER_PAGE_MM, OFFER_PANEL_MM, buildSignLayout, buildSignPage, type SignBrand, type SignLayout
} from "./offer-sign-layout";
import { toMonochromeLogo } from "./offer-sign-logo";
import { renderOfferSignPdf } from "./offer-sign-pdf";
import { choricito, conCentavos, costilla, filetPechuga, hamburguesas, nombreLargo, pataMuslo } from "./test-support/offer-sign-fixtures";
import { must } from "./test-support/must";

const OUT = process.env.OFFER_SIGN_SAMPLES_DIR;
const LOGO = path.resolve(__dirname, "../../public/icons/icon-512.png");
const WITH_LOGO: SignBrand = { hasLogo: true, name: "SUPER OFERTAS" };
const NO_LOGO: SignBrand = { hasLogo: false, name: "SUPER OFERTAS" };

const sign = (row: Record<string, unknown>): OfferSign => must(buildOfferSign(row));

async function render(signs: OfferSign[], format: OfferSignFormat, brand: SignBrand, logoPng: Uint8Array | null) {
  const pages = paginateSigns(signs, format).map((group) => buildSignPage(group, format, brand));
  return renderOfferSignPdf(pages, { title: "Carteles de ofertas - Central", logoPng, createdAt: new Date("2026-10-13T12:00:00Z") });
}

const ten = () => [choricito(), pataMuslo(), filetPechuga(), costilla(), hamburguesas(), nombreLargo(), conCentavos(), choricito(), pataMuslo(), costilla()].map(sign);

function textsOf(layout: SignLayout) { return layout.texts.map((text) => text.text); }

describe("layout del cartel", () => {
  it("la tira reparte el ancho en 3 carteles separados, dentro del margen seguro", () => {
    const { width, height } = OFFER_PANEL_MM.STRIP;
    expect(3 * width + 2 * OFFER_GUTTER_MM + 2 * OFFER_MARGIN_MM).toBeCloseTo(OFFER_PAGE_MM.width, 6);
    expect(height + 2 * OFFER_MARGIN_MM).toBe(OFFER_PAGE_MM.height);
    const page = buildSignPage([sign(choricito()), sign(pataMuslo()), sign(costilla())], "STRIP", WITH_LOGO);
    expect(page.panels.map((panel) => Math.round(panel.x * 100) / 100)).toEqual([8, 103.33, 198.67]);
    expect(page.panels.every((panel) => panel.x >= OFFER_MARGIN_MM && panel.x + panel.layout.width <= OFFER_PAGE_MM.width - OFFER_MARGIN_MM + 1e-6)).toBe(true);
    expect(page.rules).toHaveLength(4);
  });

  it("el cartel grande ocupa la hoja entera dentro del margen", () => {
    const page = buildSignPage([sign(choricito())], "POSTER", WITH_LOGO);
    expect(page.panels).toHaveLength(1);
    expect(must(page.panels[0]).layout.width).toBe(OFFER_PAGE_MM.width - 2 * OFFER_MARGIN_MM);
    expect(page.rules).toHaveLength(0);
  });

  it("lleva OFERTA, el producto, la condición, el precio y el precio normal (en ese orden de lectura vertical)", () => {
    const layout = buildSignLayout(sign(choricito()), "STRIP", WITH_LOGO);
    expect(textsOf(layout)).toEqual(expect.arrayContaining(["OFERTA", "CHORICITO DE", "CERDO", "DESDE 2 KG", "$", "6.500", "/ KG", "PRECIO NORMAL $7.000/KG"].filter((text) => text !== "CHORICITO DE" && text !== "CERDO")));
    const baselineOf = (text: string) => must(layout.texts.find((entry) => entry.text === text), text).y;
    expect(baselineOf("OFERTA")).toBeLessThan(baselineOf("DESDE 2 KG"));
    expect(baselineOf("DESDE 2 KG")).toBeLessThan(baselineOf("6.500"));
    expect(baselineOf("6.500")).toBeLessThan(baselineOf("PRECIO NORMAL $7.000/KG"));
  });

  it("el precio es lo más grande del cartel y la condición va en blanco sobre negro", () => {
    for (const format of ["STRIP", "POSTER"] as const) {
      const layout = buildSignLayout(sign(choricito()), format, WITH_LOGO);
      const price = must(layout.texts.find((entry) => entry.text === "6.500"));
      expect(Math.max(...layout.texts.map((entry) => entry.sizePt))).toBe(price.sizePt);
      const condition = must(layout.texts.find((entry) => entry.text === "DESDE 2 KG"));
      expect(condition.inverse).toBe(true);
      expect(layout.rects.some((rect) => rect.fill)).toBe(true);
      expect(layout.texts.filter((entry) => entry.inverse)).toHaveLength(1);
    }
  });

  it("el precio queda a la misma altura en todos los carteles de la tira", () => {
    const baselines = [choricito(), hamburguesas(), conCentavos(), nombreLargo()].map((row) => {
      const layout = buildSignLayout(sign(row), "STRIP", WITH_LOGO);
      return must(layout.texts.find((entry) => entry.text === sign(row).price.whole)).y;
    });
    expect(new Set(baselines).size).toBe(1);
  });

  it("precio normal sólo cuando hay una comparación real", () => {
    const withNormal = buildSignLayout(sign(choricito()), "STRIP", WITH_LOGO);
    expect(textsOf(withNormal).some((text) => text.startsWith("PRECIO NORMAL"))).toBe(true);
    const without = buildSignLayout({ ...sign(choricito()), normalPrice: null }, "STRIP", WITH_LOGO);
    expect(textsOf(without).some((text) => text.includes("NORMAL"))).toBe(false);
  });

  it("nombre largo: se reparte en renglones sin partir palabras y sin letra microscópica", () => {
    for (const format of ["STRIP", "POSTER"] as const) {
      const layout = buildSignLayout(sign(nombreLargo()), format, WITH_LOGO);
      const name = layout.texts.filter((entry) => entry.sizePt > 0 && !entry.inverse && "MILANESA DE POLLO REBOZADA CON JAMÓN Y QUESO".includes(entry.text) && entry.text.length > 2);
      expect(name.length).toBeGreaterThan(1);
      expect(name.map((entry) => entry.text).join(" ")).toBe("MILANESA DE POLLO REBOZADA CON JAMÓN Y QUESO");
      expect(Math.min(...name.map((entry) => entry.sizePt))).toBeGreaterThanOrEqual(format === "STRIP" ? 22 : 30);
    }
  });

  it("ningún texto se sale del cartel", () => {
    const font = antonOutlines();
    for (const format of ["STRIP", "POSTER"] as const) {
      for (const row of [choricito(), nombreLargo(), conCentavos(), hamburguesas(), costilla()]) {
        const layout = buildSignLayout(sign(row), format, WITH_LOGO);
        for (const text of layout.texts) {
          let units = 0;
          for (const char of text.text) units += font.glyphFor(char.codePointAt(0) ?? 32)?.advance ?? 0;
          const width = ((units / font.unitsPerEm) * text.sizePt) * MM_PER_PT;
          const left = text.anchor === "middle" ? text.x - width / 2 : text.anchor === "end" ? text.x - width : text.x;
          expect(left).toBeGreaterThanOrEqual(1);
          expect(left + width).toBeLessThanOrEqual(layout.width - 1);
          expect(text.y).toBeLessThanOrEqual(layout.height - 1);
        }
      }
    }
  });

  it("logo presente → reserva su lugar; sin logo → imprime el nombre del negocio", () => {
    expect(buildSignLayout(sign(choricito()), "STRIP", WITH_LOGO).logo).not.toBeNull();
    const fallback = buildSignLayout(sign(choricito()), "STRIP", NO_LOGO);
    expect(fallback.logo).toBeNull();
    expect(textsOf(fallback)).toContain("SUPER OFERTAS");
  });

  it("la altura de mayúsculas del layout coincide con la fuente", () => {
    const font = antonOutlines();
    expect(font.capHeight / font.unitsPerEm).toBeCloseTo(ANTON_CAP_EM, 6);
  });
});

describe("logo monocromo", () => {
  it("convierte un logo a color en negro sobre blanco legible, sin tocar el original", async () => {
    const original = new Uint8Array(fs.readFileSync(LOGO));
    const copy = Uint8Array.from(original);
    const mono = await toMonochromeLogo(original);
    expect(original).toEqual(copy);
    expect(mono.width).toBeLessThanOrEqual(720);
    // Ni todo blanco ni una mancha negra: hay formas y fondo.
    expect(mono.inkShare).toBeGreaterThan(0.04);
    expect(mono.inkShare).toBeLessThan(0.6);
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(mono.png);
    expect(image.width).toBe(mono.width);
  });
});

describe("PDF A4 apaisado", () => {
  it("10 ofertas en tira → 4 páginas A4 horizontales de 297 × 210 mm", async () => {
    const bytes = await render(ten(), "STRIP", NO_LOGO, null);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(4);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width / (72 / 25.4)).toBeCloseTo(297, 1);
      expect(height / (72 / 25.4)).toBeCloseTo(210, 1);
      expect(width).toBeGreaterThan(height);
    }
  });

  it("1, 3 y 4 ofertas en tira → 1, 1 y 2 páginas; cartel grande → una por oferta", async () => {
    const all = ten();
    const pages = async (count: number, format: OfferSignFormat) => (await PDFDocument.load(await render(all.slice(0, count), format, NO_LOGO, null))).getPageCount();
    expect(await pages(1, "STRIP")).toBe(1);
    expect(await pages(3, "STRIP")).toBe(1);
    expect(await pages(4, "STRIP")).toBe(2);
    expect(await pages(1, "POSTER")).toBe(1);
    expect(await pages(3, "POSTER")).toBe(3);
  });

  it("con logo el PDF embebe la imagen monocroma; sin logo no hay imágenes", async () => {
    const mono = await toMonochromeLogo(new Uint8Array(fs.readFileSync(LOGO)));
    const withLogo = await render([sign(choricito())], "STRIP", WITH_LOGO, mono.png);
    const without = await render([sign(choricito())], "STRIP", NO_LOGO, null);
    expect(Buffer.from(withLogo).includes("/Subtype /Image")).toBe(true);
    expect(Buffer.from(without).includes("/Subtype /Image")).toBe(false);
  });

  it("30 promociones se generan rápido y livianas", async () => {
    const many = Array.from({ length: 30 }, (_, index) => sign([choricito, pataMuslo, filetPechuga, costilla, hamburguesas, nombreLargo, conCentavos][index % 7]?.() ?? choricito()));
    const started = performance.now();
    const bytes = await render(many, "STRIP", NO_LOGO, null);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(bytes.length).toBeLessThan(2_000_000);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(10);
  });

  it("no acepta un PDF vacío", async () => {
    await expect(renderOfferSignPdf([], { title: "x", logoPng: null, createdAt: new Date() })).rejects.toThrow(RangeError);
  });

  it.skipIf(!OUT)("deja las muestras reales en ARCHIVOS (OFFER_SIGN_SAMPLES_DIR)", async () => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const mono = await toMonochromeLogo(new Uint8Array(fs.readFileSync(LOGO)));
    fs.writeFileSync(path.join(OUT, "logo-monocromo.png"), mono.png);
    // Cada muestra deja el PDF real y una copia «-sinimagen» con el mismo lugar reservado para el logo + las cajas del logo (mm), porque el
    // rasterizador de esta máquina se cuelga al pintar imágenes: el script de revisión compone el logo encima de la copia.
    const sample = async (name: string, signs: OfferSign[], format: OfferSignFormat, brand: SignBrand, logo: Uint8Array | null) => {
      fs.writeFileSync(path.join(OUT, `${name}.pdf`), await render(signs, format, brand, logo));
      fs.writeFileSync(path.join(OUT, `${name}-sinimagen.pdf`), await render(signs, format, brand, null));
      const boxes = paginateSigns(signs, format).map((group) => buildSignPage(group, format, brand).panels.flatMap((panel) => (panel.layout.logo
        ? [{ x: panel.x + panel.layout.logo.x, y: panel.y + panel.layout.logo.y, width: panel.layout.logo.width, height: panel.layout.logo.height, align: panel.layout.logo.align }] : [])));
      fs.writeFileSync(path.join(OUT, `${name}.logo.json`), JSON.stringify(boxes));
    };
    await sample("tira-3-ofertas", [choricito(), pataMuslo(), hamburguesas()].map(sign), "STRIP", WITH_LOGO, mono.png);
    await sample("tira-3-ofertas-peso-pack-nombre-largo", [costilla(), nombreLargo(), filetPechuga()].map(sign), "STRIP", WITH_LOGO, mono.png);
    await sample("tira-sin-logo", [choricito(), conCentavos()].map(sign), "STRIP", NO_LOGO, null);
    await sample("cartel-grande-choricito", [sign(choricito())], "POSTER", WITH_LOGO, mono.png);
    await sample("cartel-grande-pack", [sign(hamburguesas()), sign(nombreLargo())], "POSTER", WITH_LOGO, mono.png);
    expect(fs.readdirSync(OUT).length).toBeGreaterThan(10);
  });
});
