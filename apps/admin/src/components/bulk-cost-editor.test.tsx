import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BulkCostEditor, type BulkCostRow } from "./bulk-cost-editor";

// La acción de servidor importa next/cache y Supabase: acá sólo importa el render del formulario.
vi.mock("../app/admin/actions", () => ({ bulkSetProductCostsAction: () => Promise.resolve({}) }));

const rows: BulkCostRow[] = [
  { id: "aceite", name: "Aceite Cañuelas", categoryName: "Aceites", unitType: "UNIT", currentCostCents: 350_000, currentPriceCents: 562_500 },
  { id: "yerba", name: "Yerba XXX", categoryName: "Almacén", unitType: "UNIT", currentCostCents: 400_000, currentPriceCents: 640_000 },
  { id: "vacio", name: "Vacío", categoryName: "Carnes", unitType: "WEIGHT", currentCostCents: null, currentPriceCents: null }
];

describe("BulkCostEditor: Producto | Categoría | Tipo | Nuevo costo | Precio actual", () => {
  const html = renderToStaticMarkup(<BulkCostEditor marginConfigured rows={rows} />);

  it("las columnas van en ese orden: el input editable es «Nuevo costo» y «Precio actual» es sólo referencia", () => {
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual(["Producto", "Categoría", "Tipo de venta", "Nuevo costo", "Precio actual"]);
  });

  it("hay un input de costo por fila, en la columna «Nuevo costo», con el costo actual como placeholder", () => {
    expect(html.match(/aria-label="Nuevo costo de /g)).toHaveLength(3);
    expect(html).toContain('placeholder="3500"');
    expect(html).toContain('placeholder="4000"');
    expect(html).toContain('placeholder="Sin costo"');
    const firstRow = html.split("<tr").find((chunk) => chunk.includes("Aceite Cañuelas")) ?? "";
    const cells = firstRow.split("<td");
    expect(cells[4]).toContain("<input");
    expect(cells[5]).not.toContain("<input");
  });

  it("«Precio actual» muestra el precio de lista vigente con su unidad, sin input", () => {
    expect(html).toContain("$ 5.625 /u");
    expect(html).toContain("$ 6.400 /u");
    expect(html).toContain("SIN PRECIO");
  });

  it("ya no hay columna ni input de «Nuevo precio»", () => {
    expect(html).not.toContain("Nuevo precio");
    expect(html).not.toContain('name="price"');
  });

  it("explica en la pantalla que sólo se guardan las filas cambiadas y arranca sin cambios", () => {
    expect(html).toContain("Sin cambios");
    expect(html).toContain("Guardar cambios");
    expect(html).toContain('type="search"');
  });

  it("sin margen configurado avisa que los precios no se recalculan; con margen no", () => {
    expect(html).not.toContain("Todavía no configuraste el margen");
    expect(renderToStaticMarkup(<BulkCostEditor marginConfigured={false} rows={rows} />)).toContain("Todavía no configuraste el margen");
  });

  it("sin filas lo dice", () => {
    expect(renderToStaticMarkup(<BulkCostEditor marginConfigured rows={[]} />)).toContain("No hay productos de venta para cargar costos.");
  });
});
