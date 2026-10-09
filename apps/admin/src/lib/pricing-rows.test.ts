import { describe, expect, it } from "vitest";

import { priceEditable, ruleAfterEdit } from "./bulk-costs";
import { parsePricingRowsPage, ruleOfRow, toEditRef } from "./pricing-rows";

const raw = (over: Record<string, unknown> = {}) => ({
  productId: "p1", name: "Aceite", sku: "AC-1", categoryName: "Almacén", unitType: "UNIT", costCents: 350_000, priceCents: 562_500,
  marginSource: "GLOBAL", marginBps: 4_000, customMarginBps: null, excludedCategory: false, ...over
});

describe("parsePricingRowsPage (respuesta de list_pricing_rows)", () => {
  it("tipa la página y el total", () => {
    const page = parsePricingRowsPage({ total: 3_000, rows: [raw()] });
    expect(page.total).toBe(3_000);
    expect(page.rows[0]).toMatchObject({ productId: "p1", name: "Aceite", unitType: "UNIT", costCents: 350_000, priceCents: 562_500, marginSource: "GLOBAL" });
  });

  it("un costo o precio en 0 (o ausente) es «sin costo / sin precio»; nunca se muestra $0", () => {
    const [row] = parsePricingRowsPage({ total: 1, rows: [raw({ costCents: 0, priceCents: null, marginBps: null })] }).rows;
    expect(row?.costCents).toBeNull();
    expect(row?.priceCents).toBeNull();
  });

  it("falla fuerte con una forma inesperada", () => {
    expect(() => parsePricingRowsPage(null)).toThrow();
    expect(() => parsePricingRowsPage({ total: "3", rows: [] })).toThrow();
    expect(() => parsePricingRowsPage({ total: 1, rows: [raw({ marginSource: "OTRO" })] })).toThrow();
    expect(() => parsePricingRowsPage({ total: 1, rows: [raw({ unitType: "KG" })] })).toThrow();
  });
});

describe("regla de la fila → referencia de edición", () => {
  it("GLOBAL, CUSTOM, MANUAL y NO_MARGIN se traducen a la regla que muestra y edita la planilla", () => {
    const [global, custom, manual, none] = parsePricingRowsPage({ total: 4, rows: [
      raw(), raw({ productId: "p2", marginSource: "CUSTOM", marginBps: 3_000, customMarginBps: 3_000 }),
      raw({ productId: "p3", marginSource: "MANUAL", marginBps: null, excludedCategory: true }),
      raw({ productId: "p4", marginSource: "NO_MARGIN", marginBps: null })
    ] }).rows;
    expect([global, custom, manual, none].map((row) => row && ruleOfRow(row).kind)).toEqual(["GLOBAL", "CUSTOM", "MANUAL", "NONE"]);
    expect(global && toEditRef(global, 4_000)).toMatchObject({ customMarginBps: null, globalMarginBps: 4_000, organizationMarginBps: 4_000 });
    expect(custom && toEditRef(custom, 4_000)).toMatchObject({ customMarginBps: 3_000, globalMarginBps: null });
    expect(manual && toEditRef(manual, 4_000)).toMatchObject({ customMarginBps: null, globalMarginBps: null, excludedCategory: true });
  });

  it("la fila manual (Cerdo) edita el precio; la global (Vaca/Pollo/Almacén) no; la regla sale de los datos, no de un nombre", () => {
    const [cerdo, vaca] = parsePricingRowsPage({ total: 2, rows: [
      raw({ productId: "c", name: "Producto X", categoryName: "Categoría Q", marginSource: "MANUAL", marginBps: null, excludedCategory: true }),
      raw({ productId: "v", name: "Producto Y", categoryName: "Categoría Z" })
    ] }).rows;
    expect(cerdo && priceEditable(toEditRef(cerdo, 4_000), undefined)).toBe(true);
    expect(vaca && priceEditable(toEditRef(vaca, 4_000), undefined)).toBe(false);
    expect(cerdo && ruleAfterEdit(toEditRef(cerdo, 4_000), { margin: "30" }).kind).toBe("CUSTOM");
  });
});
