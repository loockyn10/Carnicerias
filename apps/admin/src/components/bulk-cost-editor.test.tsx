import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PricingRow } from "../lib/pricing-rows";
import { BulkCostEditor, describeSaved } from "./bulk-cost-editor";

// Las acciones de servidor importan next/cache y Supabase: acá sólo importa el render de la planilla.
vi.mock("../app/admin/actions", () => ({
  applyPricingReceiptAction: () => Promise.resolve({}),
  searchPricingRowsAction: () => Promise.resolve({ page: { total: 0, rows: [] } })
}));

function row(over: Partial<PricingRow> & Pick<PricingRow, "productId" | "name">): PricingRow {
  return {
    sku: null, categoryName: "Almacén", unitType: "UNIT", costCents: 350_000, priceCents: 562_500, marginSource: "GLOBAL", marginBps: 4_000,
    customMarginBps: null, excludedCategory: false, ...over
  };
}

// Configuración real: margen global 40 %, sólo Cerdo excluida (precio manual). Vaca y Pollo son automáticos.
const aceite = row({ productId: "aceite", name: "Aceite Cañuelas", categoryName: "Aceites" });
const nalga = row({ productId: "nalga", name: "Nalga vacuna", categoryName: "Vaca", unitType: "WEIGHT", costCents: 900_000, priceCents: 1_500_000 });
const pechuga = row({ productId: "pechuga", name: "Pechuga", categoryName: "Pollo", unitType: "WEIGHT", costCents: 400_000, priceCents: 665_000 });
const bondiola = row({ productId: "bondiola", name: "Bondiola de cerdo", categoryName: "Cerdo", unitType: "WEIGHT", costCents: null, priceCents: 1_065_000, marginSource: "MANUAL", marginBps: null, excludedCategory: true });
const sinPrecio = row({ productId: "sinprecio", name: "Vacío nuevo", categoryName: "Vaca", unitType: "WEIGHT", costCents: null, priceCents: null });
const page = { total: 3, rows: [aceite, bondiola, nalga] };

const render = (props: Partial<Parameters<typeof BulkCostEditor>[0]> = {}) =>
  renderToStaticMarkup(<BulkCostEditor initialPage={page} marginBps={4_000} marginConfigured productionBranchName="Central" {...props} />);
const rowHtml = (html: string, name: string) => html.split("<tr").find((chunk) => chunk.includes(name)) ?? "";

describe("Productos → Precios: UN solo buscador, tabla Producto | Categoría | Tipo | Costo | Margen | Cantidad | Precio actual", () => {
  const html = render();

  it("hay un único buscador, visible dentro de «Costos de los productos», sin formulario ni segundo filtro", () => {
    expect(html.match(/type="search"/g)).toHaveLength(1);
    expect(html).toContain('placeholder="Producto o categoría…"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
  });

  it("no hay párrafo largo de explicación", () => {
    expect(html).not.toContain("Actualizá los costos");
    expect(html).not.toContain("recalcula automáticamente");
    expect(html).not.toContain("Sólo se guardan las filas que cambiaste");
  });

  it("las columnas van en ese orden", () => {
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual(["Producto", "Categoría", "Tipo de venta", "Costo", "Margen", "Cantidad", "Precio actual"]);
  });

  it("cada fila tiene costo (placeholder = costo vigente) y cantidad (vacía por defecto)", () => {
    expect(html.match(/aria-label="Costo de /g)).toHaveLength(3);
    expect(html.match(/aria-label="Cantidad recibida de /g)).toHaveLength(3);
    expect(html).toContain('placeholder="3500"');
    expect(html).toContain('placeholder="Sin costo"');
    const aceiteRow = rowHtml(html, "Aceite Cañuelas");
    expect(/aria-label="Cantidad recibida de [^"]*"[^>]*value="([^"]*)"/.exec(aceiteRow)?.[1]).toBe("");
    expect(aceiteRow).toContain("Unidad");
    expect(rowHtml(html, "Nalga vacuna")).toContain("Por kg");
    expect(aceiteRow.split("<td")[6]).toContain(">u<");
    expect(rowHtml(html, "Nalga vacuna").split("<td")[6]).toContain(">kg<");
  });

  it("arranca sin cambios y con «Guardar cambios» deshabilitado", () => {
    expect(html).toContain("Sin cambios");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Guardar cambios<\/button>/);
  });

  it("muestra cuántos productos hay y ofrece «Mostrar más» cuando el catálogo es más grande que lo cargado", () => {
    expect(html).toContain("Mostrando 3 de 3");
    expect(html).not.toContain("Mostrar más");
    const big = render({ initialPage: { total: 3_000, rows: [aceite] } });
    expect(big).toContain("Mostrando 1 de 3000");
    expect(big).toContain("Mostrar más");
  });

  it("sin filas lo dice", () => {
    expect(render({ initialPage: { total: 0, rows: [] } })).toContain("No hay productos de venta para cargar costos.");
  });

  it("sin margen configurado avisa que los precios no se recalculan; con margen no", () => {
    expect(html).not.toContain("Todavía no configuraste el margen");
    expect(render({ marginConfigured: false })).toContain("Todavía no configuraste el margen");
  });
});

describe("precio actual: editable sólo donde el precio es manual", () => {
  const html = render({ initialPage: { total: 4, rows: [aceite, bondiola, nalga, pechuga] } });

  it("Cerdo (categoría excluida, sin margen propio): input de precio con el precio vigente y badge «Precio manual»", () => {
    const bondiolaRow = rowHtml(html, "Bondiola de cerdo");
    expect(bondiolaRow).toContain('aria-label="Precio de Bondiola de cerdo"');
    expect(/aria-label="Precio de [^"]*"[^>]*value="([^"]*)"/.exec(bondiolaRow)?.[1]).toBe("10650");
    expect(bondiolaRow).toContain(">Precio manual<");
    expect(bondiolaRow).toContain("/kg");
    expect(/aria-label="Margen de [^"]*"[^>]*value="([^"]*)"/.exec(bondiolaRow)?.[1]).toBe("");
  });

  it("Almacén, Vaca y Pollo (automáticos): el precio es de sólo lectura y muestran su margen Global", () => {
    for (const name of ["Aceite Cañuelas", "Nalga vacuna", "Pechuga"]) {
      const automatic = rowHtml(html, name);
      expect(automatic).not.toContain('aria-label="Precio de ');
      expect(automatic).toContain(">Global<");
      expect(/aria-label="Margen de [^"]*"[^>]*value="([^"]*)"/.exec(automatic)?.[1]).toBe("40");
    }
    expect(rowHtml(html, "Aceite Cañuelas")).toContain("$ 5.625 /u");
    expect(rowHtml(html, "Nalga vacuna")).toContain("$ 15.000 /kg");
    expect(rowHtml(html, "Pechuga")).toContain("$ 6.650 /kg");
    expect(html.match(/aria-label="Precio de /g)).toHaveLength(1);
  });

  it("un producto automático sin costo ni precio permite cargar el precio a mano (no se puede derivar)", () => {
    const out = render({ initialPage: { total: 1, rows: [sinPrecio] } });
    expect(out).toContain('aria-label="Precio de Vacío nuevo"');
    expect(out).toContain("Sin costo: precio manual");
    expect(out).toContain('placeholder="Sin precio"');
  });

  it("margen propio y precio manual, cada uno con su origen y sin crear overrides al mostrarse", () => {
    const own = row({ productId: "yerba", name: "Yerba", marginSource: "CUSTOM", marginBps: 500, customMarginBps: 500, costCents: 378_000, priceCents: 540_000 });
    const ownPork = row({ productId: "costilla", name: "Costilla propia", categoryName: "Cerdo", unitType: "WEIGHT", marginSource: "CUSTOM", marginBps: 2_500, customMarginBps: 2_500, excludedCategory: true, costCents: 900_000, priceCents: 1_200_000 });
    const out = render({ initialPage: { total: 3, rows: [own, bondiola, ownPork] } });
    expect(/aria-label="Margen de [^"]*"[^>]*value="([^"]*)"/.exec(rowHtml(out, "Yerba"))?.[1]).toBe("5");
    expect(rowHtml(out, "Yerba")).toContain(">Propio<");
    expect(rowHtml(out, "Yerba")).toContain("Usar global");
    // Cerdo con margen propio vuelve a ser AUTOMÁTICO: sin input de precio, y ofrece volver a «Precio manual».
    expect(rowHtml(out, "Costilla propia")).toContain("Usar precio manual");
    expect(rowHtml(out, "Costilla propia")).not.toContain('aria-label="Precio de ');
    expect(/aria-label="Margen de [^"]*"[^>]*value="([^"]*)"/.exec(rowHtml(out, "Costilla propia"))?.[1]).toBe("25");
    expect(out.match(/data-testid="margin-reset"/g)).toHaveLength(2);
    expect(out).not.toContain('name="price"');
  });
});

describe("cantidad recibida y sucursal productiva", () => {
  it("sin sucursal productiva configurada la cantidad queda deshabilitada y se explica", () => {
    const out = render({ productionBranchName: null });
    expect(out).toContain("configurar la sucursal productiva");
    expect(out.match(/<input[^>]*aria-label="Cantidad recibida de [^"]*"[^>]*disabled=""/g)).toHaveLength(3);
  });

  it("con sucursal productiva la cantidad está habilitada y dice a qué stock se suma", () => {
    const out = render();
    expect(out).not.toContain("configurar la sucursal productiva");
    expect(out.match(/<input[^>]*aria-label="Cantidad recibida de [^"]*"[^>]*disabled=""/g)).toBeNull();
    expect(out).toContain("Se suma al stock de Central");
    expect(out).toContain("Cantidad recibida en esta entrega: se suma al stock, no lo reemplaza");
  });
});

describe("mensaje después de guardar", () => {
  it("resume lo que pasó, sin inventar nada", () => {
    expect(describeSaved({ applied: 3, costsSaved: 2, marginsChanged: 1, repriced: 2, manualPrices: 1, stockMovements: 3 }))
      .toBe("Guardado: 3 producto(s), 2 costo(s), 1 margen(es), 2 precio(s) recalculado(s), 1 precio(s) manual(es), 3 ingreso(s) de stock.");
    expect(describeSaved({ applied: 1, stockMovements: 1 })).toBe("Guardado: 1 producto(s), 1 ingreso(s) de stock.");
  });

  it("una operación repetida (misma clave) lo dice y aclara que no se volvió a sumar", () => {
    expect(describeSaved({ replayed: true, applied: 1, stockMovements: 1 })).toContain("no se volvió a sumar el stock");
  });

  it("avisa de precios programados y de precios propios de sucursal", () => {
    const text = describeSaved({ applied: 1, scheduledPrice: 1, branchOverrides: 2 });
    expect(text).toContain("1 con precio programado");
    expect(text).toContain("ATENCIÓN: 2 producto(s) tienen un precio propio de sucursal");
  });
});

describe("contrato del editor (fuente)", () => {
  const source = readFileSync(new URL("./bulk-cost-editor.tsx", import.meta.url), "utf8");

  it("busca en el servidor contra todo el catálogo: no filtra en el navegador las filas ya cargadas", () => {
    expect(source).toContain("searchPricingRowsAction(");
    expect(source).not.toContain("normalizeSearchText");
    expect(source).not.toMatch(/\.filter\([^)]*includes\(/);
  });

  it("proyecta el precio sólo con calculateListPriceFromMargin (el mismo redondeo a $50 que el servidor), sin fórmula propia", () => {
    expect(source).toContain("calculateListPriceFromMargin(");
    expect(source).not.toMatch(/10_?000n?\s*-/);
  });

  it("evita el doble submit: bandera síncrona, botón deshabilitado y una clave de idempotencia por intento", () => {
    expect(source).toContain("submitting.current");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).toContain("disabled={pending || blocked || changedItems.length === 0}");
    expect(source).toContain("requestKey");
  });

  it("después de guardar vacía lo guardado (la Cantidad no queda escrita) y refresca costo/precio/regla desde el servidor", () => {
    expect(source).toContain("snapshot.has(id)");
    expect(source).toContain("result.rows");
  });

  it("conserva lo escrito al cambiar la búsqueda (las filas con cambios fuera de la búsqueda se muestran aparte)", () => {
    expect(source).toContain("Con cambios sin guardar (fuera de esta búsqueda)");
    expect(source).toContain("pinnedRows");
  });

  it("no calcula stock ni precios por su cuenta: no hay gramos ni fórmulas de margen acá", () => {
    expect(source).not.toMatch(/\* ?1_?000/);
    expect(source).not.toContain("quantity_grams");
  });
});
