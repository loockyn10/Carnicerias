import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildOfferSlide, type SlideFacts } from "../lib/signage";
import { OFFER_SLIDE_HEIGHT, OFFER_SLIDE_WIDTH, OfferSlide } from "./offer-slide";

const unit = (overrides: Partial<SlideFacts> = {}): SlideFacts => ({
  key: "s1", name: "Mayonesa Hellmann's 250gr", unitType: "UNIT", listPriceCents: 203_500n, bulkMinimumUnits: 3, bulkDiscountBps: 1_500, weightTiers: [], ...overrides
});
const render = (facts: SlideFacts, brand = "Despensa Demo") => {
  const offer = buildOfferSlide(facts);
  if (!offer) throw new Error("sin oferta");
  return renderToStaticMarkup(<OfferSlide brand={brand} offer={offer} />);
};

describe("OfferSlide", () => {
  it("se dibuja en el tamaño de diseño 1920 × 1080 (16:9)", () => {
    const html = render(unit());
    expect(OFFER_SLIDE_WIDTH / OFFER_SLIDE_HEIGHT).toBeCloseTo(16 / 9, 5);
    expect(html).toContain("width:1920px");
    expect(html).toContain("height:1080px");
  });

  it("producto con promoción: nombre, precio efectivo enorme, condición y precio unitario", () => {
    const html = render(unit());
    expect(html).toContain("Mayonesa Hellmann&#x27;s 250gr");
    expect(html).toMatch(/data-testid="offer-price"[^>]*>.*?1\.729/);
    expect(html).toContain(">75<");
    expect(html).toContain("LLEVANDO 3 UNIDADES");
    expect(html).toContain("Precio unitario $ 2.035");
    expect(html).toContain("OFERTA");
    expect(html).toContain('data-offer-variant="BULK"');
  });

  it("producto sin promoción: no inventa «llevando 3» ni la etiqueta OFERTA", () => {
    const html = render(unit({ name: "Aceite Cañuelas 900ml", listPriceCents: 245_000n, bulkMinimumUnits: null, bulkDiscountBps: null }));
    expect(html).toContain("2.450");
    expect(html).toContain("PRECIO UNITARIO");
    expect(html).not.toMatch(/LLEVANDO/i);
    expect(html).not.toContain("OFERTA");
    expect(html).not.toContain("offer-secondary");
    expect(html).not.toContain("offer-cents");
  });

  it("producto por peso: precio por kilo", () => {
    const html = render({ ...unit(), name: "Molida vacuna", unitType: "WEIGHT", listPriceCents: 1_100_000n, bulkMinimumUnits: null, bulkDiscountBps: null });
    expect(html).toContain("11.000");
    expect(html).toContain("/ KG");
    expect(html).toContain("PRECIO POR KILO");
  });

  it("nombre muy largo: se achica y se limita a 3 líneas (nada cortado ni desbordado)", () => {
    const long = "Hamburguesas de carne vacuna congeladas premium con queso y panceta ahumada x 12 unidades";
    const html = render(unit({ name: long, bulkMinimumUnits: null, bulkDiscountBps: null }));
    expect(html).toContain(long);
    expect(html).toContain("-webkit-line-clamp:3");
    const size = Number(/data-testid="offer-name" style="[^"]*font-size:([\d.]+)px/.exec(html)?.[1]);
    expect(size).toBeLessThan(112);
    expect(size).toBeGreaterThanOrEqual(56);
  });

  it("no imprime «undefined», «null» ni «NaN»", () => {
    for (const facts of [unit(), unit({ bulkMinimumUnits: null }), { ...unit(), unitType: "WEIGHT" as const, bulkMinimumUnits: null, bulkDiscountBps: null }]) {
      expect(render(facts)).not.toMatch(/undefined|null|NaN/);
    }
  });

  it("deja el lugar de la foto del producto: sin foto centra el contenido; con foto la muestra a un costado", () => {
    const offer = buildOfferSlide(unit());
    if (!offer) throw new Error("sin oferta");
    expect(renderToStaticMarkup(<OfferSlide offer={offer} />)).not.toContain("offer-media");
    const withPhoto = renderToStaticMarkup(<OfferSlide media={<img alt="Mayonesa" src="/foto.png" />} offer={offer} />);
    expect(withPhoto).toContain("offer-media");
    expect(withPhoto).toContain("/foto.png");
  });

  it("muestra la marca (nombre del comercio) y nada administrativo", () => {
    const html = render(unit(), "Carnicería Don Pepe");
    expect(html).toContain("Carnicería Don Pepe");
    expect(html).not.toMatch(/costo|margen|stock|empleado/i);
  });

  it("es presentacional: no contiene botones, enlaces ni controles", () => {
    const html = render(unit());
    expect(html).not.toMatch(/<button|<a |<input|<select/);
  });
});
