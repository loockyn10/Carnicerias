import fs from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { buildOfferSign, OFFER_SIGN_FORMATS, paginateSigns, signPageCount, signsPerPage, type OfferSign, type OfferSignFormat } from "./offer-sign";
import {
  ANTON_CAP_EM, MM_PER_PT, OFFER_GUTTER_MM, OFFER_MARGIN_MM, OFFER_PAGE_MM, OFFER_PANEL_MM, buildSignLayout, buildSignPage, type SignBrand, type SignLayout
} from "./offer-sign-layout";
import { toMonochromeLogo } from "./offer-sign-logo";
import { renderOfferSignPdf } from "./offer-sign-pdf";
import { OfferSignPagePreview } from "../components/offer-sign-preview";
import { choricito, conCentavos, costilla, filetPechuga, hamburguesas, nombreLargo, pataMuslo } from "./test-support/offer-sign-fixtures";
import { must } from "./test-support/must";
import { renderToStaticMarkup } from "react-dom/server";

const OUT = process.env.OFFER_SIGN_SAMPLES_DIR;
const ICON = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/icons/icon-512.png")));
const WITH_LOGO: SignBrand = { hasLogo: true, name: "SUPER OFERTAS" };
const NO_LOGO: SignBrand = { hasLogo: false, name: "SUPER OFERTAS" };
const sign = (row: Record<string, unknown>): OfferSign => must(buildOfferSign(row));

const rows = () => [choricito(), pataMuslo(), filetPechuga(), costilla(), hamburguesas(), nombreLargo(), conCentavos(), choricito(), pataMuslo(), costilla()];
const signs = (count: number) => rows().slice(0, count).map(sign);

async function render(list: OfferSign[], format: OfferSignFormat, brand: SignBrand, logoPng: Uint8Array | null) {
  const pages = paginateSigns(list, format).map((group) => buildSignPage(group, format, brand));
  return renderOfferSignPdf(pages, { title: "Carteles de ofertas", logoPng, createdAt: new Date("2026-10-13T12:00:00Z") });
}

const sizeOf = (layout: SignLayout, text: string) => must(layout.texts.find((entry) => entry.text === text), text).sizePt;

describe("formato mediano: 2 ofertas por hoja", () => {
  it("aparece entre el grande y la tira, con nombres claros", () => {
    expect(OFFER_SIGN_FORMATS.map((format) => format.label)).toEqual([
      "Cartel grande · 1 oferta por hoja", "Cartel mediano · 2 ofertas por hoja", "Tira · 3 ofertas por hoja"
    ]);
    expect(signsPerPage("MEDIUM")).toBe(2);
  });

  it("paginación: 1→1, 2→1, 3→2, 4→2, 5→3, 10→5 hojas", () => {
    const expected: [number, number][] = [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [10, 5], [0, 0]];
    for (const [count, pages] of expected) expect(signPageCount("MEDIUM", count)).toBe(pages);
    expect(paginateSigns([1, 2, 3, 4, 5], "MEDIUM")).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("dos carteles verticales lado a lado dentro del margen, con una línea de corte fina por el medio", () => {
    const { width, height } = OFFER_PANEL_MM.MEDIUM;
    expect(2 * width + OFFER_GUTTER_MM + 2 * OFFER_MARGIN_MM).toBeCloseTo(OFFER_PAGE_MM.width, 6);
    expect(height).toBeGreaterThan(width);
    const page = buildSignPage(signs(2), "MEDIUM", WITH_LOGO);
    expect(page.panels).toHaveLength(2);
    expect(must(page.panels[0]).x).toBe(OFFER_MARGIN_MM);
    expect(must(page.panels[1]).x + width).toBeCloseTo(OFFER_PAGE_MM.width - OFFER_MARGIN_MM, 6);
    expect(page.rules).toHaveLength(1);
    const rule = must(page.rules[0]);
    expect(rule.x1).toBeCloseTo(OFFER_PAGE_MM.width / 2, 6);
    expect(rule.widthMm).toBeLessThanOrEqual(0.25);
    // Los bordes de los carteles son más finos que los del cartel grande: no hay una grilla pesada.
    const strokeOf = (format: OfferSignFormat) => must(buildSignLayout(sign(choricito()), format, WITH_LOGO).rects[0]).strokeMm;
    expect(strokeOf("MEDIUM")).toBeLessThan(strokeOf("POSTER"));
  });

  it("la jerarquía queda ENTRE el cartel grande y la tira: precio, nombre, OFERTA, condición y logo", () => {
    const item = sign(choricito());
    const layouts = { STRIP: buildSignLayout(item, "STRIP", WITH_LOGO), MEDIUM: buildSignLayout(item, "MEDIUM", WITH_LOGO), POSTER: buildSignLayout(item, "POSTER", WITH_LOGO) };
    for (const text of ["6.500", "OFERTA", "DESDE 2 KG"]) {
      expect(sizeOf(layouts.MEDIUM, text), text).toBeGreaterThan(sizeOf(layouts.STRIP, text) - 0.01);
    }
    expect(sizeOf(layouts.STRIP, "6.500")).toBeLessThan(sizeOf(layouts.MEDIUM, "6.500"));
    expect(sizeOf(layouts.MEDIUM, "6.500")).toBeLessThan(sizeOf(layouts.POSTER, "6.500"));
    const nameSize = (layout: SignLayout) => must(layout.texts.find((entry) => entry.text.startsWith("CHORICITO"))).sizePt;
    expect(nameSize(layouts.STRIP)).toBeLessThan(nameSize(layouts.MEDIUM));
    expect(sizeOf(layouts.STRIP, "DESDE 2 KG")).toBeLessThan(sizeOf(layouts.MEDIUM, "DESDE 2 KG"));
    const badgeHeight = (layout: SignLayout) => must(layout.rects.find((rect) => rect.fill)).height;
    expect(badgeHeight(layouts.STRIP)).toBeLessThan(badgeHeight(layouts.MEDIUM));
    const logoHeight = (layout: SignLayout) => must(layout.logo).height;
    expect(logoHeight(layouts.STRIP)).toBeLessThan(logoHeight(layouts.MEDIUM));
    // No es la tira «al 150 %»: el precio crece más que el ancho del cartel proporcionalmente no lo hace y el logo gana presencia.
    const widthRatio = OFFER_PANEL_MM.MEDIUM.width / OFFER_PANEL_MM.STRIP.width;
    expect(sizeOf(layouts.MEDIUM, "6.500") / sizeOf(layouts.STRIP, "6.500")).not.toBeCloseTo(widthRatio, 1);
    expect(sizeOf(layouts.MEDIUM, "6.500")).toBeGreaterThan(sizeOf(layouts.STRIP, "6.500") * 1.15);
  });

  it("los tres formatos usan EXACTAMENTE los mismos datos (mismo texto de condición, precio, unidad y precio normal)", () => {
    for (const row of [choricito(), costilla(), hamburguesas(), conCentavos()]) {
      const item = sign(row);
      const words = (format: OfferSignFormat) => buildSignLayout(item, format, WITH_LOGO).texts.map((entry) => entry.text).filter((text) => text === item.condition || text === item.price.whole || text === item.normalPrice || text === item.unitLabel);
      expect(words("MEDIUM").sort()).toEqual(words("STRIP").sort());
      expect(words("POSTER").sort()).toEqual(words("STRIP").sort());
      expect(words("MEDIUM")).toContain(item.price.whole);
    }
  });

  it("ningún texto se sale del cartel con WEIGHT, UNIT, centavos y nombre largo", () => {
    for (const row of [choricito(), hamburguesas(), conCentavos(), nombreLargo(), costilla()]) {
      const layout = buildSignLayout(sign(row), "MEDIUM", WITH_LOGO);
      for (const text of layout.texts) {
        expect(text.x).toBeGreaterThan(0);
        expect(text.x).toBeLessThan(layout.width);
        expect(text.y).toBeLessThan(layout.height);
      }
      const name = layout.texts.filter((entry) => !entry.inverse && sign(row).name.includes(entry.text) && entry.text.length > 2);
      expect(name.map((entry) => entry.text).join(" ")).toBe(sign(row).name);
    }
  });

  it("los bloques no se pisan en ningún formato: condición, precio, unidad y precio normal van uno debajo del otro", () => {
    for (const format of ["STRIP", "MEDIUM", "POSTER"] as const) {
      for (const row of rows()) {
        const item = sign(row);
        const layout = buildSignLayout(item, format, WITH_LOGO);
        const badge = must(layout.rects.find((rect) => rect.fill));
        const price = must(layout.texts.find((entry) => entry.text === item.price.whole));
        const priceTop = price.y - ANTON_CAP_EM * price.sizePt * MM_PER_PT;
        expect(priceTop, `${format} ${item.name}: precio vs condición`).toBeGreaterThan(badge.y + badge.height + 3);
        const unit = must(layout.texts.find((entry) => entry.text.startsWith(item.unitLabel)));
        expect(unit.y - ANTON_CAP_EM * unit.sizePt * MM_PER_PT, `${format} ${item.name}: unidad vs precio`).toBeGreaterThan(price.y + 1);
        const normal = layout.texts.find((entry) => entry.text === item.normalPrice);
        if (normal) expect(normal.y - ANTON_CAP_EM * normal.sizePt * MM_PER_PT).toBeGreaterThan(unit.y + 1);
        const logo = must(layout.logo);
        const offer = must(layout.texts.find((entry) => entry.text === "OFERTA"));
        // En el cartel grande el logo va al costado de OFERTA; en los otros, arriba.
        if (format !== "POSTER") expect(logo.y + logo.height, `${format}: logo vs OFERTA`).toBeLessThanOrEqual(offer.y - ANTON_CAP_EM * offer.sizePt * MM_PER_PT + 1);
      }
    }
  });

  it("10 ofertas → un solo PDF de 5 hojas A4 apaisadas (297 × 210 mm)", async () => {
    const doc = await PDFDocument.load(await render(signs(10), "MEDIUM", NO_LOGO, null));
    expect(doc.getPageCount()).toBe(5);
    for (const page of doc.getPages()) {
      expect(page.getWidth() / (72 / 25.4)).toBeCloseTo(297, 1);
      expect(page.getHeight() / (72 / 25.4)).toBeCloseTo(210, 1);
    }
  });

  it("1, 2, 3, 4 y 5 ofertas → 1, 1, 2, 2 y 3 hojas; la última hoja impar queda bien armada", async () => {
    for (const [count, pages] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]] as const) {
      const doc = await PDFDocument.load(await render(signs(count), "MEDIUM", WITH_LOGO, null));
      expect(doc.getPageCount(), String(count)).toBe(pages);
    }
    const last = must(paginateSigns(signs(5), "MEDIUM").at(-1));
    const page = buildSignPage(last, "MEDIUM", WITH_LOGO);
    expect(page.panels).toHaveLength(1);
    // El único cartel ocupa el lugar de la izquierda (mismo alineamiento que las demás hojas).
    expect(must(page.panels[0]).x).toBe(OFFER_MARGIN_MM);
    expect(must(page.panels[0]).layout.width).toBe(OFFER_PANEL_MM.MEDIUM.width);
  });

  it("el preview dibuja el mediano con las mismas primitivas y la línea central", () => {
    const html = renderToStaticMarkup(<OfferSignPagePreview label="Hoja 1 de 1" logoDataUrl="data:image/png;base64,AAAA" page={buildSignPage(signs(2), "MEDIUM", WITH_LOGO)} />);
    expect(html.match(/<image/g)).toHaveLength(2);
    expect(html.match(/<line/g)).toHaveLength(1);
    expect(html).toContain("6.500");
  });
});

describe("logo elegido (Super Ofertas / Carnicería)", () => {
  async function shapes() {
    const make = (width: number, height: number, svg: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">${svg}</svg>`)).png().toBuffer();
    return {
      round: await make(500, 500, `<rect width="500" height="500" fill="#fff"/><circle cx="250" cy="250" r="240" fill="#c00"/><text x="250" y="290" font-size="120" text-anchor="middle" fill="#fff" font-family="Arial">CARNE</text>`),
      horizontal: await make(900, 300, `<rect width="900" height="300" fill="#fff"/><rect x="20" y="20" width="860" height="260" fill="#063"/><circle cx="150" cy="150" r="90" fill="#fd0"/>`),
      vertical: await make(300, 800, `<rect width="300" height="800" fill="#fff"/><rect x="30" y="30" width="240" height="740" fill="#900"/><circle cx="150" cy="200" r="90" fill="#fff"/>`)
    };
  }

  it("redondo, horizontal y vertical: el monocromo conserva la proporción y no toca el original", async () => {
    for (const [name, bytes] of Object.entries(await shapes())) {
      const original = Uint8Array.from(bytes);
      const input = await sharp(bytes).metadata();
      const mono = await toMonochromeLogo(new Uint8Array(bytes));
      expect(new Uint8Array(bytes), name).toEqual(original);
      expect(mono.width / mono.height, name).toBeCloseTo(must(input.width) / must(input.height), 1);
      expect(mono.inkShare, name).toBeGreaterThan(0.03);
      expect(mono.inkShare, name).toBeLessThan(0.97);
      const pixels = await sharp(Buffer.from(mono.png)).raw().toBuffer();
      expect(new Set(pixels), name).toEqual(new Set([0, 255]));
    }
  });

  it("el PDF dibuja cada logo sin deformarlo, dentro de su caja", async () => {
    for (const [name, bytes] of Object.entries(await shapes())) {
      const mono = await toMonochromeLogo(new Uint8Array(bytes));
      for (const format of ["STRIP", "MEDIUM", "POSTER"] as const) {
        const layout = must(buildSignPage([sign(choricito())], format, WITH_LOGO).panels[0]).layout;
        const box = must(layout.logo);
        expect((await PDFDocument.load(await render([sign(choricito())], format, WITH_LOGO, mono.png))).getPageCount()).toBe(1);
        const ratio = mono.width / mono.height;
        const fit = Math.min(box.width, box.height * ratio);
        expect(fit, `${name} ${format}`).toBeLessThanOrEqual(box.width + 1e-9);
        expect(fit / ratio, `${name} ${format}`).toBeLessThanOrEqual(box.height + 1e-9);
        expect(box.x + box.width, `${name} ${format}`).toBeLessThanOrEqual(layout.width);
      }
    }
  });

  it("cambiar de logo cambia el PDF y el preview; el contenido del cartel no cambia", async () => {
    const { round, horizontal } = await shapes();
    const general = await toMonochromeLogo(ICON);
    const butcher = await toMonochromeLogo(new Uint8Array(round));
    const wide = await toMonochromeLogo(new Uint8Array(horizontal));
    const withGeneral = await render(signs(2), "MEDIUM", WITH_LOGO, general.png);
    const withButcher = await render(signs(2), "MEDIUM", WITH_LOGO, butcher.png);
    expect(Buffer.from(withGeneral).equals(Buffer.from(withButcher))).toBe(false);
    expect(Buffer.from(withGeneral).equals(Buffer.from(await render(signs(2), "MEDIUM", WITH_LOGO, general.png)))).toBe(true);
    expect(Buffer.from(await render(signs(2), "MEDIUM", WITH_LOGO, wide.png)).equals(Buffer.from(withButcher))).toBe(false);
    const page = buildSignPage(signs(2), "MEDIUM", WITH_LOGO);
    const previewA = renderToStaticMarkup(<OfferSignPagePreview label="a" logoDataUrl="data:image/png;base64,AAAA" page={page} />);
    const previewB = renderToStaticMarkup(<OfferSignPagePreview label="a" logoDataUrl="data:image/png;base64,BBBB" page={page} />);
    expect(previewA).not.toBe(previewB);
    expect(previewA.split("base64,AAAA").join("X")).toBe(previewB.split("base64,BBBB").join("X"));
  });

  it("un logo horizontal usa el ancho de su caja (no queda diminuto como en una caja cuadrada)", async () => {
    const { horizontal } = await shapes();
    const mono = await toMonochromeLogo(new Uint8Array(horizontal));
    const box = must(buildSignLayout(sign(choricito()), "MEDIUM", WITH_LOGO).logo);
    const fit = Math.min(box.width, box.height * (mono.width / mono.height));
    expect(fit).toBeGreaterThan(box.height * 2);
  });

  it("sin logo del seleccionado se imprime el nombre del negocio", () => {
    const layout = buildSignLayout(sign(choricito()), "MEDIUM", NO_LOGO);
    expect(layout.logo).toBeNull();
    expect(layout.texts.map((entry) => entry.text)).toContain("SUPER OFERTAS");
  });
});

describe.skipIf(!OUT)("muestras (OFFER_SIGN_SAMPLES_DIR)", () => {
  it("deja el formato mediano con el logo de la carnicería y la comparación de los tres formatos", async () => {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const butcherLogo = path.join(OUT, "logo-carniceria-muestra.png");
    // Logo de carnicería de MUESTRA (el real vive en Storage): vaca + «CARNICERÍA» en un sello redondo, horizontal.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360"><rect width="900" height="360" fill="#fff"/><circle cx="180" cy="180" r="165" fill="#a01010"/><circle cx="180" cy="180" r="135" fill="none" stroke="#fff" stroke-width="10"/><path d="M110 210 q70 -130 140 0 q-70 40 -140 0z" fill="#fff"/><text x="400" y="170" font-size="64" font-weight="900" font-family="Arial" fill="#222">CARNICERÍA</text><text x="400" y="240" font-size="52" font-family="Arial" fill="#a01010">DON FRAN</text></svg>`;
    fs.writeFileSync(butcherLogo, await sharp(Buffer.from(svg)).png().toBuffer());
    const mono = await toMonochromeLogo(new Uint8Array(fs.readFileSync(butcherLogo)));
    fs.writeFileSync(path.join(OUT, "logo-carniceria-monocromo.png"), mono.png);
    const sample = async (name: string, list: OfferSign[], format: OfferSignFormat) => {
      fs.writeFileSync(path.join(OUT, `${name}.pdf`), await render(list, format, WITH_LOGO, mono.png));
      fs.writeFileSync(path.join(OUT, `${name}-sinimagen.pdf`), await render(list, format, WITH_LOGO, null));
      const boxes = paginateSigns(list, format).map((group) => buildSignPage(group, format, WITH_LOGO).panels.flatMap((panel) => (panel.layout.logo
        ? [{ x: panel.x + panel.layout.logo.x, y: panel.y + panel.layout.logo.y, width: panel.layout.logo.width, height: panel.layout.logo.height, align: panel.layout.logo.align }] : [])));
      fs.writeFileSync(path.join(OUT, `${name}.logo.json`), JSON.stringify(boxes));
    };
    const pair = [sign(pataMuslo()), sign(costilla())];
    await sample("mediano-2-ofertas-carniceria", pair, "MEDIUM");
    await sample("mediano-3-ofertas-impar", [...pair, sign(hamburguesas())], "MEDIUM");
    await sample("comparar-grande", [sign(pataMuslo())], "POSTER");
    await sample("comparar-mediano", [sign(pataMuslo()), sign(costilla())], "MEDIUM");
    await sample("comparar-tira", [sign(pataMuslo()), sign(costilla()), sign(hamburguesas())], "STRIP");
  });
});
