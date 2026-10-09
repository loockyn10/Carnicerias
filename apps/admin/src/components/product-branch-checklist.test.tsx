import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { defaultNewProductBranchIds } from "../lib/new-product-branches";
import { ProductBranchChecklist } from "./product-branch-checklist";
import { ProductCreateModal } from "./product-create-modal";

// Las acciones de servidor importan next/cache y Supabase: acá sólo importa el render.
vi.mock("../app/admin/actions", () => ({ createProductModalAction: () => Promise.resolve({}), manageProductAction: () => Promise.resolve({}) }));

// Una organización NUEVA con nombres que no son Central/Avenida/Janssen: la regla es `production_branch_id`, nunca el nombre.
const production = { id: "prod-1", name: "Depósito Norte" };
const branchA = { id: "a-1", name: "Sucursal Alfa" };
const branchB = { id: "b-1", name: "Sucursal Beta" };
const branches = [branchA, production, branchB];

const checkedIds = (html: string) => [...html.matchAll(/<input([^>]*)name="branch_ids"([^>]*)\/>/g)].flatMap((match) => {
  const attributes = `${match[1] ?? ""}${match[2] ?? ""}`;
  return attributes.includes('checked=""') ? [/value="([^"]*)"/.exec(attributes)?.[1] ?? ""] : [];
});
const allIds = (html: string) => [...html.matchAll(/<input([^>]*)name="branch_ids"([^>]*)\/>/g)].map((match) => /value="([^"]*)"/.exec(`${match[1] ?? ""}${match[2] ?? ""}`)?.[1] ?? "");

describe("alta de producto: «Se vende en» sólo marca la sucursal productiva", () => {
  it("production_branch_id queda marcada; todas las demás destildadas", () => {
    expect(defaultNewProductBranchIds(branches, "prod-1")).toEqual(["prod-1"]);
    const html = renderToStaticMarkup(<ProductBranchChecklist branches={branches} checkedIds={defaultNewProductBranchIds(branches, "prod-1")} hint="x" />);
    expect(allIds(html)).toEqual(["a-1", "prod-1", "b-1"]);
    expect(checkedIds(html)).toEqual(["prod-1"]);
  });

  it("no depende del nombre ni del orden: otra organización con otra sucursal productiva", () => {
    expect(defaultNewProductBranchIds(branches, "b-1")).toEqual(["b-1"]);
    expect(defaultNewProductBranchIds([{ id: "central" }, { id: "avenida" }, { id: "janssen" }], "avenida")).toEqual(["avenida"]);
  });

  it("sin sucursal productiva configurada (o inactiva) no se marca ninguna: no se adivina un destino", () => {
    expect(defaultNewProductBranchIds(branches, null)).toEqual([]);
    expect(defaultNewProductBranchIds(branches, "otra-organizacion")).toEqual([]);
  });

  it("el modal de alta usa esa regla y no tiene nombres de sucursal escritos a mano", () => {
    const source = readFileSync(new URL("./product-create-modal.tsx", import.meta.url), "utf8");
    expect(source).toContain("defaultNewProductBranchIds(branches, productionBranchId)");
    expect(source).toContain("checkedIds={defaultSellingBranchIds}");
    expect(source).not.toMatch(/Central|Avenida|Janssen/);
    expect(source).not.toMatch(/defaultChecked name="branch_ids"/);
    // Cerrado, el modal sólo muestra el botón (las casillas existen al abrirlo).
    expect(renderToStaticMarkup(<ProductCreateModal branches={branches} categories={[]} marginBps={null} productionBranchId="prod-1" suppliers={[]} />)).toContain("Nuevo producto");
  });

  it("la página le pasa la sucursal productiva real de la organización", () => {
    const page = readFileSync(new URL("../app/admin/products/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("productionBranchId={productionBranchId}");
    expect(page).toContain('select("production_branch_id")');
  });
});

describe("edición de un producto existente: muestra exactamente el surtido guardado", () => {
  it("conserva las sucursales guardadas, sean cuales sean (no aplica el default del alta)", () => {
    const saved = renderToStaticMarkup(<ProductBranchChecklist branches={branches} checkedIds={["a-1", "b-1"]} hint="x" />);
    expect(checkedIds(saved)).toEqual(["a-1", "b-1"]);
    const onlyProduction = renderToStaticMarkup(<ProductBranchChecklist branches={branches} checkedIds={["prod-1"]} hint="x" />);
    expect(checkedIds(onlyProduction)).toEqual(["prod-1"]);
    const none = renderToStaticMarkup(<ProductBranchChecklist branches={branches} checkedIds={[]} hint="x" />);
    expect(checkedIds(none)).toEqual([]);
  });

  it("el modal de edición usa product.branchIds, no la regla del alta", () => {
    const source = readFileSync(new URL("./product-manage-modal.tsx", import.meta.url), "utf8");
    expect(source).toContain("checkedIds={product.branchIds}");
    expect(source).not.toContain("defaultNewProductBranchIds");
  });
});
