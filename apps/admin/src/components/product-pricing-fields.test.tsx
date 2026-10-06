import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductPricingFields } from "./product-pricing-fields";

describe("ProductPricingFields en el ALTA de un producto (D-068)", () => {
  it("con margen configurado explica que el precio se calcula con el costo y que no hace falta escribirlo", () => {
    const html = renderToStaticMarkup(<ProductPricingFields creationMarginBps={3_000} currentCostCents={null} currentPriceCents={null} required unitType="UNIT" />);
    expect(html).toContain('data-testid="new-product-price-note"');
    // Sin costo todavía: el precio sigue siendo obligatorio y el texto dice cómo evitarlo.
    expect(html).toContain("cargá un costo y el precio se calcula solo con el margen");
    expect(html).toMatch(/name="price"[^>]*required|required[^>]*name="price"/);
  });

  it("sin margen configurado el precio es obligatorio y dice por qué", () => {
    const html = renderToStaticMarkup(<ProductPricingFields creationMarginBps={null} currentCostCents={null} currentPriceCents={null} required unitType="WEIGHT" />);
    expect(html).toContain("no hay costo cargado ni un margen configurado");
    expect(html).toMatch(/required/);
  });

  it("la ficha de un producto existente no muestra la nota de alta", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={350_000} currentPriceCents={500_000} marginConfigured unitType="UNIT" />);
    expect(html).not.toContain("new-product-price-note");
    expect(html).toContain("el precio de venta se recalcula con el margen configurado");
  });
});
