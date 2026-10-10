import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PricingConfigForm } from "./pricing-config-form";

vi.mock("../app/admin/actions", () => ({ savePricingConfigAction: () => Promise.resolve({}) }));

const configured = { marginBps: 3_000, unitBulkDiscountBps: 1_500, quantityTiers: [{ minimumUnits: 3, discountBps: 1_500 }, { minimumUnits: 5, discountBps: 2_000 }], packDiscountBps: 2_000, cardSurchargeBps: 1_000 };

describe("PricingConfigForm: margen, descuentos por cantidad, dto por pack y recargo por tarjeta", () => {
  const html = renderToStaticMarkup(<PricingConfigForm values={configured} />);

  it("muestra los cuatro valores de la organización, en porcentaje", () => {
    expect(html).toContain("Margen de ganancia");
    expect(html).toContain("Descuentos por cantidad");
    expect(html).toContain("Dto por pack");
    expect(html).toContain("Recargo por tarjeta");
    for (const [name, value] of [["margin", "30"], ["pack", "20"], ["card", "10"]] as const) {
      expect(html, name).toMatch(new RegExp(`name="${name}"[^>]*value="${value}"|value="${value}"[^>]*name="${name}"`));
    }
    expect(html).toContain("Guardar configuración");
  });

  it("explica cada valor (margen sobre el precio de venta, desde 3 unidades, packs, tarjeta) con el ejemplo calculado", () => {
    expect(html).toContain("Porcentaje de ganancia sobre el precio de venta");
    expect(html).toContain("costo $ 10.000 con margen 30% → venta $ 14.300");
    expect(html).toContain("Se aplica el mayor escalón alcanzado");
    expect(html).toContain("Se aplica a los productos que tengan unidades por pack configuradas");
    expect(html).toContain("Efectivo y transferencia no tienen ajuste");
  });

  it("valida en el navegador los rangos (margen > 0 y < 100; 3u, pack y tarjeta desde 0)", () => {
    expect(html).toMatch(/max="99.99"[^>]*min="0.01"[^>]*name="margin"/);
    expect(html).not.toContain('name="unit_bulk"');
    expect(html).toMatch(/max="99.99"[^>]*min="0"[^>]*name="pack"/);
    expect(html).toContain("0 = el pack sigue existiendo, sin descuento");
    expect(html).toMatch(/max="99.99"[^>]*min="0"[^>]*name="card"/);
  });

  it("lista los escalones vigentes (3 → 15 %, 5 → 20 %) con Editar, Eliminar y + Agregar escalón", () => {
    expect(html).toContain("3 unidades");
    expect(html).toContain("15 %");
    expect(html).toContain("5 unidades");
    expect(html).toContain("20 %");
    expect(html).toContain("Editar escalón de 3 unidades");
    expect(html).toContain("Eliminar escalón de 5 unidades");
    expect(html).toContain("+ Agregar escalón");
  });

  it("envía los escalones escritos en el campo oculto quantity_tiers (el servidor los vuelve a validar)", () => {
    expect(html).toContain("name=\"quantity_tiers\"");
    expect(html).toContain("[{&quot;units&quot;:&quot;3&quot;,&quot;percent&quot;:&quot;15&quot;},{&quot;units&quot;:&quot;5&quot;,&quot;percent&quot;:&quot;20&quot;}]");
  });

  it("sin escalones configurados avisa que ninguna venta lleva descuento por cantidad", () => {
    const none = renderToStaticMarkup(<PricingConfigForm values={{ ...configured, quantityTiers: [] }} />);
    expect(none).toContain("Sin descuentos por cantidad");
    expect(none).toContain("+ Agregar escalón");
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

  it("categorías excluidas del margen automático: un selector múltiple por id, con las ya excluidas marcadas", () => {
    const categories = [{ id: "c-almacen", name: "Almacén" }, { id: "c-vaca", name: "Vaca" }, { id: "c-cerdo", name: "Cerdo" }, { id: "c-pollo", name: "Pollo" }];
    const withCategories = renderToStaticMarkup(<PricingConfigForm categories={categories} excludedCategoryIds={["c-vaca", "c-cerdo", "c-pollo"]} values={configured} />);
    expect(withCategories).toContain("Categorías excluidas del margen automático");
    expect(withCategories).toContain('name="excluded_sent"');
    expect(withCategories.match(/name="excluded_category"/g)).toHaveLength(4);
    for (const id of ["c-vaca", "c-cerdo", "c-pollo"]) expect(withCategories).toMatch(new RegExp(`checked=""[^>]*value="${id}"|value="${id}"[^>]*checked=""`));
    expect(withCategories).not.toMatch(/checked=""[^>]*value="c-almacen"|value="c-almacen"[^>]*checked=""/);
    expect(withCategories).toContain("Excluidas: Cerdo · Pollo · Vaca");
  });

  it("sin categorías excluidas lo dice: el margen se aplica a todos los productos con costo", () => {
    const none = renderToStaticMarkup(<PricingConfigForm categories={[{ id: "c-vaca", name: "Vaca" }]} values={configured} />);
    expect(none).toContain("Ninguna categoría excluida");
    expect(none).not.toMatch(/checked=""[^>]*value="c-vaca"|value="c-vaca"[^>]*checked=""/);
  });

  it("acepta decimales (margen 32,5 %) y los muestra tal cual", () => {
    const decimal = renderToStaticMarkup(<PricingConfigForm values={{ ...configured, marginBps: 3_250 }} />);
    expect(decimal).toContain('value="32.5"');
  });
});
