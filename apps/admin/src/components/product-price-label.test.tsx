import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildLabelLayout } from "../lib/label-layout";
import { buildProductLabel, type ProductLabelInput } from "../lib/product-label";
import { ProductPriceLabel } from "./product-price-label";

const bulk = { minimumUnits: 3, discountBps: 1_500 };
const render = (input: ProductLabelInput, scale?: number) => renderToStaticMarkup(<ProductPriceLabel layout={buildLabelLayout(buildProductLabel(input))} scale={scale} />);
const visibleText = (html: string) => [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
const mayonesa: ProductLabelInput = { name: "Mayonesa Hellmann's 250gr", unitType: "UNIT", listPriceCents: 205_000n, bulk };

describe("preview SVG de la etiqueta de góndola", () => {
  it("mide 70 × 50 mm (viewBox en milímetros, relación 1,4) y no usa px para la tipografía", () => {
    const html = render(mayonesa);
    expect(html).toContain('width="70mm"');
    expect(html).toContain('height="50mm"');
    expect(html).toContain('viewBox="0 0 70 50"');
    expect(html).toContain('data-label-width-mm="70"');
    expect(html).toContain('data-label-height-mm="50"');
    expect(html).not.toMatch(/font-size="[\d.]+px"/);
  });

  it("el preview ampliado conserva la relación de aspecto", () => {
    const html = render(mayonesa, 3);
    expect(html).toContain('width="210mm"');
    expect(html).toContain('height="150mm"');
    expect(html).toContain('viewBox="0 0 70 50"');
  });

  it("modo fluido: ocupa el ancho de su columna (hasta el tamaño ampliado) y conserva la relación 1,4 por el viewBox", () => {
    const html = renderToStaticMarkup(<ProductPriceLabel fluid layout={buildLabelLayout(buildProductLabel(mayonesa))} scale={3.2} />);
    expect(html).toContain("width:100%");
    expect(html).toContain("max-width:224mm");
    expect(html).toContain("height:auto");
    expect(html).toContain('viewBox="0 0 70 50"');
    expect(html.slice(0, html.indexOf(">"))).not.toMatch(/ (width|height)="/);
  });

  it("oferta UNIT: OFERTA!!!, nombre, POR 3 UNIDADES, Descuento 15 %, precio promocional, PRECIO NORMAL y precio normal", () => {
    const text = visibleText(render(mayonesa));
    expect(text).toEqual(["OFERTA!!!", "MAYONESA HELLMANN&#x27;S", "250GR", "POR 3 UNIDADES", "Descuento 15%", "$ 1.742,50", "PRECIO NORMAL", "$ 2.050"]);
    const html = render(mayonesa);
    expect(html).toContain('data-label-variant="PROMO"');
    expect(html).toContain('data-label-part="condition-underline"');
    expect(html).toContain('font-style="italic"');
    expect(html).toContain('text-anchor="middle"');
  });

  it("sin promoción NO inventa oferta, condición ni descuento", () => {
    const html = render({ ...mayonesa, bulk: null });
    expect(html).toContain('data-label-variant="SIMPLE"');
    expect(html).not.toMatch(/OFERTA|POR 3|Descuento|PRECIO NORMAL|<line/);
    expect(visibleText(html)).toContain("PRECIO UNITARIO");
    expect(visibleText(html)).toContain("$ 2.050");
  });

  it("por kg y sin precio son variantes del mismo componente", () => {
    expect(visibleText(render({ name: "Molida vacuna", unitType: "WEIGHT", listPriceCents: 1_100_000n, bulk: null }))).toEqual(["MOLIDA VACUNA", "$ 11.000", "/kg", "PRECIO POR KILO"]);
    const none = render({ name: "Sin precio", unitType: "UNIT", listPriceCents: null, bulk: null });
    expect(none).toContain('data-label-variant="NO_PRICE"');
    expect(visibleText(none)).toContain("SIN PRECIO");
  });

  it("el precio es el texto con la letra más grande (tamaños derivados del layout compartido con el PDF)", () => {
    const html = render(mayonesa);
    const sizes = [...html.matchAll(/data-label-part="([^"]+)"[^>]*font-size="([\d.]+)"/g)].map((match) => [match[1], Number(match[2])] as const);
    const price = sizes.find(([id]) => id === "price")?.[1] ?? 0;
    for (const [id, size] of sizes) if (id !== "price") expect(price).toBeGreaterThan(size);
  });
});
