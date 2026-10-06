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

  it("categoría excluida en el alta: el precio es manual y obligatorio aunque haya costo y margen, y el campo no se deshabilita", () => {
    const html = renderToStaticMarkup(<ProductPricingFields creationMarginBps={3_000} currentCostCents={null} currentPriceCents={null} excludedCategory required unitType="WEIGHT" />);
    expect(html).toContain("Categoría con precio manual (excluida del margen automático)");
    expect(html).toMatch(/name="price"[^>]*required|required[^>]*name="price"/);
    expect(html).not.toMatch(/disabled=""[^>]*name="price"|name="price"[^>]*disabled=""/);
  });

  it("categoría excluida en la ficha: no deriva el precio del costo (campo editable) y lo dice", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={800_000} currentPriceCents={1_250_000} excludedCategory marginConfigured unitType="WEIGHT" />);
    expect(html).toContain('data-testid="price-manual-note"');
    expect(html).not.toContain('data-testid="price-derived-note"');
    expect(html).not.toMatch(/disabled=""[^>]*name="price"|name="price"[^>]*disabled=""/);
    expect(html).toContain("guardar un costo nuevo no cambia el precio de venta");
    const automatic = renderToStaticMarkup(<ProductPricingFields currentCostCents={800_000} currentPriceCents={1_250_000} marginConfigured unitType="WEIGHT" />);
    expect(automatic).toContain('data-testid="price-derived-note"');
    expect(automatic).not.toContain("price-manual-note");
  });

  it("la ficha de un producto existente no muestra la nota de alta", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={350_000} currentPriceCents={500_000} marginConfigured unitType="UNIT" />);
    expect(html).not.toContain("new-product-price-note");
    expect(html).toContain("el precio de venta se recalcula con el margen configurado");
  });
});
