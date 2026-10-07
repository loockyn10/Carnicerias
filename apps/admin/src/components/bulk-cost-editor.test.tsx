import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BulkCostEditor, type BulkCostRow } from "./bulk-cost-editor";

// La acción de servidor importa next/cache y Supabase: acá sólo importa el render del formulario.
vi.mock("../app/admin/actions", () => ({ bulkSetProductCostsAction: () => Promise.resolve({}) }));

const rows: BulkCostRow[] = [
  { id: "aceite", name: "Aceite Cañuelas", categoryName: "Aceites", unitType: "UNIT", currentCostCents: 350_000, currentPriceCents: 562_500, manualPrice: false },
  { id: "yerba", name: "Yerba XXX", categoryName: "Almacén", unitType: "UNIT", currentCostCents: 400_000, currentPriceCents: 640_000, manualPrice: false },
  { id: "vacio", name: "Vacío", categoryName: "Carnes", unitType: "WEIGHT", currentCostCents: null, currentPriceCents: null, manualPrice: false }
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

  it("un producto de categoría excluida (precio manual) muestra su precio actual y «Precio manual»; los automáticos no", () => {
    expect(html).not.toContain("manual-price-badge");
    const manual = renderToStaticMarkup(<BulkCostEditor marginBps={3_000} marginConfigured rows={[{ id: "vacio", name: "Vacío", categoryName: "Vaca", unitType: "WEIGHT", currentCostCents: 800_000, currentPriceCents: 1_250_000, manualPrice: true }, ...rows.slice(0, 1)]} />);
    const vacioRow = manual.split("<tr").find((chunk) => chunk.includes("Vacío")) ?? "";
    expect(vacioRow).toContain("$ 12.500 /kg");
    expect(vacioRow).toContain("Precio manual");
    expect(manual.match(/manual-price-badge/g)).toHaveLength(1);
  });

  it("D-070: debajo del precio actual muestra la regla de margen de cada fila (Global 40% / Propio 30% / Precio manual), sin ningún input de margen", () => {
    const ruled: BulkCostRow[] = [
      { id: "aceite", name: "Aceite", categoryName: "Almacén", unitType: "UNIT", currentCostCents: 450_000, currentPriceCents: 750_000, manualPrice: false, marginRule: { kind: "GLOBAL", bps: 4_000 } },
      { id: "yerba", name: "Yerba", categoryName: "Almacén", unitType: "UNIT", currentCostCents: 378_000, currentPriceCents: 540_000, manualPrice: false, marginRule: { kind: "CUSTOM", bps: 3_000 } },
      { id: "vacio", name: "Vacío manual", categoryName: "Vaca", unitType: "WEIGHT", currentCostCents: 800_000, currentPriceCents: 1_100_000, manualPrice: true, marginRule: { kind: "MANUAL", bps: null } },
      { id: "costilla", name: "Costilla propia", categoryName: "Vaca", unitType: "WEIGHT", currentCostCents: 900_000, currentPriceCents: 1_200_000, manualPrice: false, marginRule: { kind: "CUSTOM", bps: 2_500 } }
    ];
    const out = renderToStaticMarkup(<BulkCostEditor marginBps={4_000} marginConfigured rows={ruled} />);
    const row = (name: string) => out.split("<tr").find((chunk) => chunk.includes(name)) ?? "";
    expect(row("Aceite")).toContain("Global 40%");
    expect(row("Yerba")).toContain("Propio 30%");
    expect(row("Vacío manual")).toContain("Precio manual");
    expect(row("Costilla propia")).toContain("Propio 25%");
    expect(out.match(/data-testid="margin-rule-badge"/g)).toHaveLength(3);
    expect(out.match(/manual-price-badge/g)).toHaveLength(1);
    // La carga masiva es para costos de boletas: ningún input de margen ni de precio.
    expect(out).not.toContain("custom_margin");
    expect(out).not.toContain("margin_mode");
    expect(out).not.toContain('name="price"');
    expect(out.match(/<input[^>]*type="number"/g)).toHaveLength(4);
  });

  it("sin filas lo dice", () => {
    expect(renderToStaticMarkup(<BulkCostEditor marginConfigured rows={[]} />)).toContain("No hay productos de venta para cargar costos.");
  });
});
