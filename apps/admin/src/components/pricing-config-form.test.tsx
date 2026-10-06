import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PricingConfigForm } from "./pricing-config-form";

vi.mock("../app/admin/actions", () => ({ savePricingConfigAction: () => Promise.resolve({}) }));

const configured = { marginBps: 3_000, unitBulkDiscountBps: 1_500, packDiscountBps: 2_000, cardSurchargeBps: 1_000 };

describe("PricingConfigForm: margen, dto llevando 3u, dto por pack y recargo por tarjeta", () => {
  const html = renderToStaticMarkup(<PricingConfigForm values={configured} />);

  it("muestra los cuatro valores de la organización, en porcentaje", () => {
    expect(html).toContain("Margen de ganancia");
    expect(html).toContain("Dto llevando 3u");
    expect(html).toContain("Dto por pack");
    expect(html).toContain("Recargo por tarjeta");
    for (const [name, value] of [["margin", "30"], ["unit_bulk", "15"], ["pack", "20"], ["card", "10"]] as const) {
      expect(html, name).toMatch(new RegExp(`name="${name}"[^>]*value="${value}"|value="${value}"[^>]*name="${name}"`));
    }
    expect(html).toContain("Guardar configuración");
  });

  it("explica cada valor (margen sobre el precio de venta, desde 3 unidades, packs, tarjeta) con el ejemplo calculado", () => {
    expect(html).toContain("Porcentaje de ganancia sobre el precio de venta");
    expect(html).toContain("costo $ 10.000 con margen 30% → venta $ 14.285,71");
    expect(html).toContain("Se aplica desde 3 unidades");
    expect(html).toContain("Se aplica a los productos que tengan unidades por pack configuradas");
    expect(html).toContain("Efectivo y transferencia no tienen ajuste");
  });

  it("valida en el navegador los rangos (margen > 0 y < 100; 3u, pack y tarjeta desde 0)", () => {
    expect(html).toMatch(/max="99.99"[^>]*min="0.01"[^>]*name="margin"/);
    expect(html).toMatch(/max="99.99"[^>]*min="0"[^>]*name="unit_bulk"/);
    expect(html).toMatch(/max="99.99"[^>]*min="0"[^>]*name="pack"/);
    expect(html).toContain("0 = el pack sigue existiendo, sin descuento");
    expect(html).toMatch(/max="99.99"[^>]*min="0"[^>]*name="card"/);
  });

  it("con los valores ya configurados no muestra el aviso de «sin margen»", () => {
    expect(html).not.toContain("Todavía no hay un margen configurado");
  });

  it("sin configurar: campos vacíos y aviso de que cambiar un costo todavía no cambia el precio", () => {
    const empty = renderToStaticMarkup(<PricingConfigForm values={{ marginBps: null, unitBulkDiscountBps: null, packDiscountBps: null, cardSurchargeBps: 1_000 }} />);
    expect(empty).toContain("Todavía no hay un margen configurado");
    expect(empty).toMatch(/name="margin"[^>]*value=""|value=""[^>]*name="margin"/);
    expect(empty).not.toContain("Ejemplo: costo");
  });

  it("sin precios por sucursal vigentes no muestra ningún aviso", () => {
    expect(html).not.toContain("branch-overrides-notice");
  });

  it("con precios por sucursal vigentes lo dice (le ganan al global en el POS) y ofrece cerrarlos, sin ocultar el problema", () => {
    const withOverrides = renderToStaticMarkup(<PricingConfigForm branchOverrides={7} values={configured} />);
    expect(withOverrides).toContain('data-testid="branch-overrides-notice"');
    expect(withOverrides).toContain("7 precio(s) por sucursal vigente(s)");
    expect(withOverrides).toContain("le gana al precio global en el POS");
    expect(withOverrides).toContain("Cerrar precios por sucursal");
  });

  it("acepta decimales (margen 32,5 %) y los muestra tal cual", () => {
    const decimal = renderToStaticMarkup(<PricingConfigForm values={{ ...configured, marginBps: 3_250 }} />);
    expect(decimal).toContain('value="32.5"');
  });
});
