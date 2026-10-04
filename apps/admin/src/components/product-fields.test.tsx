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

describe("ProductPackFields: unidades por pack y descuento del pack, juntos", () => {
  it("muestra las dos cosas con los valores del producto (8 unidades, 25 %)", () => {
    const html = renderToStaticMarkup(<ProductPackFields packDiscountBps={2_500} packSizeUnits={8} />);
    expect(html).toContain("Unidades por pack");
    expect(html).toContain("Descuento del pack (%)");
    expect(html).toContain('name="pack_size_units"');
    expect(html).toContain('name="pack_discount_percent"');
    expect(html).toContain('value="8"');
    expect(html).toContain('value="25"');
    expect(html).toContain("hoy: 25% OFF");
  });

  it("soporta porcentajes decimales (12,5 %) y no muestra un 20 % fijo", () => {
    const html = renderToStaticMarkup(<ProductPackFields packDiscountBps={1_250} packSizeUnits={6} />);
    expect(html).toContain('value="12.5"');
    expect(html).toContain("hoy: 12,5% OFF");
    expect(html).not.toContain("20% OFF");
  });

  it("sin pack las dos casillas están vacías", () => {
    const html = renderToStaticMarkup(<ProductPackFields packDiscountBps={null} packSizeUnits={null} />);
    expect(html).toContain('placeholder="Sin pack"');
    expect(html).not.toContain("hoy:");
    expect(html).toMatch(/name="pack_size_units" value=""/);
    expect(html).toMatch(/name="pack_discount_percent" value=""/);
  });

  it("la ficha del producto las muestra juntas sólo para productos por unidad", () => {
    expect(source("./product-manage-modal.tsx")).toMatch(/unitType === "UNIT" \? <ProductPackFields/);
    expect(source("./product-create-modal.tsx")).not.toContain("ProductPackFields");
  });
});

describe("compatibilidad del Admin con el servidor", () => {
  it("la promoción por sucursal se guarda con el nombre público de parámetro de 060 (p_every_units), que también usa el Admin ya desplegado", () => {
    const actions = source("../app/admin/actions.ts");
    expect(actions).toContain("p_every_units: input.minimumUnits");
    expect(actions).not.toContain("p_minimum_units");
  });
});
