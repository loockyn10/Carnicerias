import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductCategoryField } from "./product-category-field";
import { ProductPackFields } from "./product-pack-fields";

const categories = [{ id: "c1", name: "Almacén" }, { id: "c2", name: "Lácteos" }, { id: "c3", name: "Bebidas" }];

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("ProductCategoryField: una sola categoría por producto", () => {
  const html = renderToStaticMarkup(<ProductCategoryField categories={categories} onChange={() => undefined} value="c2" />);

  it("muestra únicamente el selector «Categoría», con la categoría actual elegida", () => {
    expect(html).toContain("Categoría");
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain('name="category_id"');
    expect(html).toMatch(/<option[^>]*value="c2"[^>]*selected/);
    expect(html.match(/<option/g)).toHaveLength(3);
  });

  it("no ofrece categorías adicionales: ni «También aparece en», ni checkboxes, ni category_ids", () => {
    expect(html).not.toContain("También aparece en");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("category_ids");
  });

  it("en el alta de producto sólo agrega la opción vacía «Seleccionar»", () => {
    const create = renderToStaticMarkup(<ProductCategoryField categories={categories} defaultValue="" placeholder="Seleccionar" />);
    expect(create.match(/<select/g)).toHaveLength(1);
    expect(create.match(/<option/g)).toHaveLength(4);
    expect(create).toContain("Seleccionar");
    expect(create).not.toContain('type="checkbox"');
  });

  it("ningún formulario de producto del Admin vuelve a enviar categorías extra (guarda de regresión del código fuente)", () => {
    for (const file of ["./product-manage-modal.tsx", "./product-create-modal.tsx", "./product-category-field.tsx"]) {
      expect(source(file), file).not.toContain("category_ids");
      expect(source(file), file).not.toContain("También aparece en");
    }
    const actions = source("../app/admin/actions.ts");
    expect(actions).not.toContain("set_product_categories");
    expect(actions).not.toContain("category_ids");
  });

  it("la lista de productos ya no lee product_category_assignments (la categoría es products.category_id)", () => {
    expect(source("../app/admin/products/page.tsx")).not.toContain("product_category_assignments");
  });
});

describe("ProductPackFields: sólo las unidades por pack (el descuento es global)", () => {
  it("muestra únicamente las unidades por pack, con el valor del producto", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={2_500} globalPackDiscountBps={2_000} packSizeUnits={8} />);
    expect(html).toContain("Unidades por pack");
    expect(html).toContain('name="pack_size_units"');
    expect(html).toContain('value="8"');
  });

  it("NO tiene ningún campo de descuento (ni visible ni oculto)", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={2_500} globalPackDiscountBps={2_000} packSizeUnits={8} />);
    expect(html).not.toContain("pack_discount");
    expect(html).not.toContain("Descuento del pack (%)");
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toContain('type="hidden"');
  });

  it("con el descuento global configurado, lo muestra como global (no el propio del producto)", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={2_500} globalPackDiscountBps={2_000} packSizeUnits={8} />);
    expect(html).toContain("El descuento del pack es global: 20% OFF");
    expect(html).not.toContain("25% OFF");
  });

  it("sin descuento global todavía, avisa del descuento que el pack conserva y de dónde configurarlo", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={1_250} globalPackDiscountBps={null} packSizeUnits={6} />);
    expect(html).toContain("Descuento actual de este pack: 12,5% OFF");
    expect(html).toContain("Dto por pack");
  });

  it("con el descuento global en 0 % lo explica: el pack sigue cargando N unidades, sin descuento", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={0} globalPackDiscountBps={0} packSizeUnits={6} />);
    expect(html).toContain("hoy es 0 %");
    expect(html).toContain("sin descuento");
    expect(html).toContain('value="6"');
    expect(html).not.toContain("0% OFF");
  });

  it("sin pack la casilla está vacía", () => {
    const html = renderToStaticMarkup(<ProductPackFields currentPackDiscountBps={null} globalPackDiscountBps={2_000} packSizeUnits={null} />);
    expect(html).toContain('placeholder="Sin pack"');
    expect(html).toMatch(/name="pack_size_units" value=""/);
  });

  it("la ficha del producto las muestra sólo para productos por unidad y no envía el descuento del pack", () => {
    expect(source("./product-manage-modal.tsx")).toMatch(/unitType === "UNIT" \? <ProductPackFields/);
    expect(source("./product-create-modal.tsx")).not.toContain("ProductPackFields");
    expect(source("./product-manage-modal.tsx")).not.toContain("current_pack_discount_bps");
    expect(source("./product-manage-modal.tsx")).not.toContain("pack_discount_percent");
  });

  it("la acción del producto sólo manda las unidades por pack al servidor (nunca un descuento)", () => {
    const actions = source("../app/admin/actions.ts");
    expect(actions).toContain('"set_product_pack_size", { p_product_id: productId, p_pack_size_units: wantedPackSize }');
    const packCalls = actions.match(/"set_product_pack_size", \{[^}]*\}/g) ?? [];
    expect(packCalls).toHaveLength(2);
    for (const call of packCalls) expect(call).not.toContain("discount");
    expect(actions).not.toContain("pack_discount_percent");
  });
});

describe("Productos → Precios (D-068)", () => {
  it("la acción de la carga masiva sólo envía costos al servidor (el precio lo recalcula el servidor)", () => {
    const actions = source("../app/admin/actions.ts");
    expect(actions).toContain('rpcOrThrow("bulk_set_product_costs"');
    expect(actions).not.toContain("bulk_set_product_prices");
    expect(actions).not.toContain("bulkSetProductPricesAction");
  });

  it("la configuración de precios se guarda con una sola llamada atómica (no hay requests por producto)", () => {
    const actions = source("../app/admin/actions.ts");
    expect(actions).toContain('rpcOrThrow("save_pricing_config"');
    expect(actions).not.toContain("saveCashDiscountAction");
  });

  it("el costo de la ficha del producto se guarda ANTES que el precio manual (el precio escrito gana sobre el derivado)", () => {
    const actions = source("../app/admin/actions.ts");
    const manage = actions.slice(actions.indexOf("export async function manageProductAction"), actions.indexOf("export interface BulkDeactivateState"));
    expect(manage.indexOf('"set_product_cost"')).toBeGreaterThan(-1);
    expect(manage.indexOf('"set_product_cost"')).toBeLessThan(manage.indexOf('"set_product_price"'));
    const create = actions.slice(actions.indexOf("export async function createProductModalAction"), actions.indexOf("// ---- Proveedores"));
    expect(create.indexOf('"set_product_cost"')).toBeLessThan(create.indexOf('"set_product_price"'));
  });

  it("el editor por sucursal de la promoción desapareció: el panel es de sólo lectura y apunta a la configuración global", () => {
    const panel = source("./branch-promotions-panel.tsx");
    expect(panel).not.toContain("useActionState");
    expect(panel).not.toContain("<form");
    expect(panel).toContain("Configuración de precios");
    expect(source("../app/admin/actions.ts")).not.toContain("save_branch_promotion");
  });
});
