import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

import { ProductBulkBar, ProductSelectableRow, ProductSelectHeaderCell, ProductSelectionProvider, ProductSelectToggle } from "./product-selection";

const IDS = ["p1", "p2"];

function renderNormalMode() {
  return renderToStaticMarkup(
    <ProductSelectionProvider selectableIds={IDS}>
      <ProductSelectToggle />
      <table><thead><tr><ProductSelectHeaderCell /><th>Producto</th></tr></thead><tbody>
        <ProductSelectableRow productId="p1" productName="Vacío" selectable><td>Vacío</td></ProductSelectableRow>
        <ProductSelectableRow productId="p2" productName="Inactivo" selectable={false}><td>Inactivo</td></ProductSelectableRow>
      </tbody></table>
      <ProductBulkBar deactivateAction={() => Promise.resolve({})} emptiedPageHref={null} />
    </ProductSelectionProvider>
  );
}

describe("modo normal (sin selección)", () => {
  const html = renderNormalMode();
  it("sólo muestra el botón «Seleccionar», sin checkboxes ni barra ni modal", () => {
    expect(html).toContain("Seleccionar");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Desactivar productos");
    expect(html).not.toContain("seleccionado");
    expect(html).not.toContain('role="dialog"');
  });
  it("conserva las filas con las columnas originales", () => {
    expect(html.match(/<th[ >]/g)).toHaveLength(1);
    expect(html.match(/<td/g)).toHaveLength(2);
  });
});

describe("la página no ofrece una opción para seleccionar todo el negocio", () => {
  const page = readFileSync(new URL("../app/admin/products/page.tsx", import.meta.url), "utf8");
  it("el provider se alimenta únicamente de los productos activos cargados en la página", () => {
    expect(page).toContain("selectableIds={products.filter((product) => product.active).map((product) => product.id)}");
  });
  it("la acción nunca borra: usa la RPC de desactivación", () => {
    const actions = readFileSync(new URL("../app/admin/actions.ts", import.meta.url), "utf8");
    const block = actions.slice(actions.indexOf("export async function deactivateProductsAction"), actions.indexOf("export interface ProductModalState"));
    expect(block).toContain('rpcOrThrow("deactivate_products"');
    expect(block).not.toMatch(/\.delete\(|\bdelete\b\s+from/i);
  });
});
