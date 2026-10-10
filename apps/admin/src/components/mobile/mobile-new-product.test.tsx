import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileNewProduct } from "./mobile-new-product";

vi.mock("../../app/admin/actions", () => ({ createProductModalAction: () => Promise.resolve({}) }));

// Una organización cualquiera: la regla es `production_branch_id`, nunca el nombre de la sucursal.
const production = { id: "prod-1", name: "Depósito Norte" };
const alfa = { id: "a-1", name: "Sucursal Alfa" };
const beta = { id: "b-1", name: "Sucursal Beta" };
const categories = [{ id: "cat-1", name: "Vaca" }, { id: "cat-2", name: "Cerdo" }];

const render = (props: Partial<Parameters<typeof MobileNewProduct>[0]> = {}) => renderToStaticMarkup(<MobileNewProduct branches={[alfa, production, beta]} categories={categories} excludedCategoryIds={["cat-2"]} marginBps={3000} productionBranchId="prod-1" {...props} />);
const inputs = (html: string, name: string) => [...html.matchAll(/<input([^>]*)\/>/g)].map((match) => match[1] ?? "").filter((attributes) => attributes.includes(`name="${name}"`));

describe("Nuevo producto del celular", () => {
  it("pide sólo lo esencial, con las palabras del negocio", () => {
    const html = render();
    for (const label of ["Nombre", "Código de barras", "Categoría", "Forma de venta", "Unidad", "Kg", "Costo", "Se vende en", "Crear producto"]) expect(html).toContain(label);
    expect(html).toContain('name="name"');
    expect(html).toContain('name="barcodes"');
    expect(html).toContain('name="category_id"');
    expect(html).toContain('name="direct_cost"');
    expect(html).not.toContain("Materia prima");
    expect(html).not.toContain("Proveedor");
  });

  it("se vende en: la sucursal productiva marcada por defecto y primero; las demás destildadas", () => {
    const branches = inputs(render(), "branch_ids").map((attributes) => ({ id: /value="([^"]*)"/.exec(attributes)?.[1], checked: attributes.includes('checked=""') }));
    expect(branches).toEqual([{ id: "prod-1", checked: true }, { id: "a-1", checked: false }, { id: "b-1", checked: false }]);
  });

  it("sin sucursal productiva configurada no marca ninguna (no adivina un destino)", () => {
    expect(inputs(render({ productionBranchId: null }), "branch_ids").every((attributes) => !attributes.includes('checked=""'))).toBe(true);
  });

  it("el alta es la misma del escritorio: producto de venta, activo, por kg por defecto", () => {
    const html = render();
    expect(inputs(html, "is_sellable")[0]).toContain('value="on"');
    expect(inputs(html, "active")[0]).toContain('value="on"');
    expect(inputs(html, "unit_type")[0]).toContain('value="WEIGHT"');
    expect(html).toContain("Costo por kg");
  });

  it("precio: reutiliza las reglas vigentes (sin costo hace falta el precio manual, con el motivo)", () => {
    const html = render();
    expect(html).toContain('name="price"');
    expect(html).toContain("Hace falta el precio de venta");
    expect(html).not.toContain('data-testid="price-derived"');
  });

  it("sin margen configurado explica por qué el precio se escribe a mano", () => {
    expect(render({ marginBps: null })).toContain("no hay costo cargado ni un margen configurado");
  });

  it("campos de 16 px o más y botones de 44 px o más", () => {
    const html = render();
    expect(html).toContain("mobile-screen");
    expect(html).toContain("min-h-12");
    expect(html).toContain("min-h-14");
  });
});
