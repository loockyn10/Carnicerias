import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductMarginField } from "./product-margin-field";
import { ProductPricingFields } from "./product-pricing-fields";

const noop = () => undefined;
const base = { currentCostCents: 1_000_000, currentCustomMarginBps: null, excludedCategory: false, globalMarginBps: 4_000, onModeChange: noop, onPercentChange: noop, unitType: "UNIT" as const };

describe("ProductMarginField (editor del producto, D-070)", () => {
  it("categoría normal sin margen propio: «Usar configuración general» con el margen actual y la opción personalizada deshabilitada", () => {
    const html = renderToStaticMarkup(<ProductMarginField {...base} mode="default" percent="" />);
    expect(html).toContain("Margen de ganancia");
    expect(html).toContain("Usar configuración general");
    expect(html).toContain("Margen actual: 40%");
    expect(html).toContain("Usar margen personalizado");
    expect(html).toMatch(/name="custom_margin"[^>]*disabled=""|disabled=""[^>]*name="custom_margin"/);
    expect(html).not.toContain("margin-custom-note");
    expect(html).toMatch(/name="margin_mode"[^>]*value="default"/);
  });

  it("categoría excluida sin margen propio: «Precio manual» en lugar de la configuración general", () => {
    const html = renderToStaticMarkup(<ProductMarginField {...base} excludedCategory mode="default" percent="" />);
    expect(html).toContain('data-testid="margin-default-label">Precio manual<');
    expect(html).not.toContain("Usar configuración general");
    expect(html).not.toContain("Margen actual");
    expect(html).toContain("excluida del margen automático");
  });

  it("sin margen global configurado lo avisa", () => {
    expect(renderToStaticMarkup(<ProductMarginField {...base} globalMarginBps={null} mode="default" percent="" />)).toContain("Todavía no hay un margen general configurado");
  });

  it("margen personalizado: input habilitado con el valor, nota de recálculo y precio resultante con el costo vigente", () => {
    const html = renderToStaticMarkup(<ProductMarginField {...base} currentCustomMarginBps={3_000} mode="custom" percent="30" />);
    expect(html).toMatch(/name="custom_margin"[^>]*value="30"/);
    expect(html).not.toMatch(/name="custom_margin"[^>]*disabled=""|disabled=""[^>]*name="custom_margin"/);
    expect(html).toContain("incluso en una categoría excluida");
    expect(html).toContain("Con el costo actual: $ 14.285,71 / unidad.");
    expect(html).toMatch(/name="current_custom_margin_bps"[^>]*value="3000"/);
  });

  it("sin costo vigente no inventa un precio", () => {
    const html = renderToStaticMarkup(<ProductMarginField {...base} currentCostCents={null} mode="custom" percent="30" />);
    expect(html).not.toContain("margin-custom-preview");
  });

  it("quitar el margen propio avisa qué va a pasar: no excluido → recalcula con el general; excluido → vuelve a manual sin recalcular", () => {
    const normal = renderToStaticMarkup(<ProductMarginField {...base} currentCustomMarginBps={3_000} mode="default" percent="30" />);
    expect(normal).toContain("se recalcula con el margen general");
    const excluded = renderToStaticMarkup(<ProductMarginField {...base} currentCustomMarginBps={3_000} excludedCategory mode="default" percent="30" />);
    expect(excluded).toContain("vuelve a precio manual y el precio vigente NO se recalcula");
  });
});

describe("ProductPricingFields con margen personalizado", () => {
  it("en una categoría excluida, con margen propio el precio se deriva del costo (campo deshabilitado) y deja de ser «precio manual»", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={900_000} currentPriceCents={1_250_000} customMargin excludedCategory marginConfigured unitType="WEIGHT" />);
    expect(html).toContain('data-testid="price-derived-note"');
    expect(html).not.toContain("price-manual-note");
    expect(html).toMatch(/disabled=""[^>]*name="price"|name="price"[^>]*disabled=""/);
    expect(html).toContain("margen personalizado");
  });

  it("funciona aunque no haya margen global configurado", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={900_000} currentPriceCents={null} customMargin marginConfigured={false} unitType="UNIT" />);
    expect(html).toContain('data-testid="price-derived-note"');
  });

  it("sin margen propio sigue valiendo D-069: categoría excluida → precio manual editable", () => {
    const html = renderToStaticMarkup(<ProductPricingFields currentCostCents={900_000} currentPriceCents={1_250_000} excludedCategory marginConfigured unitType="WEIGHT" />);
    expect(html).toContain('data-testid="price-manual-note"');
    expect(html).not.toMatch(/disabled=""[^>]*name="price"|name="price"[^>]*disabled=""/);
  });
});
