import { describe, expect, it } from "vitest";

import { changedCostItems, costPlaceholder, parseCostCents } from "./bulk-costs";
import { describePricingConfigOutcome, describePricingConfigPreview, describePricingConfigPreviewNotes, describePricingConfigSample, parseExcludedCategoryIds, parsePricingConfigForm, parsePricingConfigOutcome } from "./pricing-config";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = { margin: "30", unit_bulk: "15", pack: "20", card: "10" };

describe("parsePricingConfigForm (configuración global de precios)", () => {
  it("30 / 15 / 20 / 10 → basis points enteros", () => {
    expect(parsePricingConfigForm(form(VALID))).toEqual({ marginBps: 3_000, unitBulkDiscountBps: 1_500, packDiscountBps: 2_000, cardSurchargeBps: 1_000 });
  });

  it("acepta coma y punto decimal, hasta 2 decimales", () => {
    const parsed = parsePricingConfigForm(form({ margin: "32,5", unit_bulk: "12.5", pack: "0,01", card: "99,99" }));
    expect(parsed).toEqual({ marginBps: 3_250, unitBulkDiscountBps: 1_250, packDiscountBps: 1, cardSurchargeBps: 9_999 });
    for (const value of Object.values(parsed)) expect(Number.isInteger(value)).toBe(true);
  });

  it("el descuento llevando 3u, el descuento por pack y el recargo aceptan 0 (sin promoción / pack sin descuento / sin recargo)", () => {
    expect(parsePricingConfigForm(form({ ...VALID, unit_bulk: "0", pack: "0", card: "0,00" }))).toMatchObject({ unitBulkDiscountBps: 0, packDiscountBps: 0, cardSurchargeBps: 0 });
  });

  it("el margen no acepta 0", () => {
    expect(() => parsePricingConfigForm(form({ ...VALID, margin: "0" }))).toThrow(/margen/i);
  });

  it.each([
    ["margin", "0"], ["margin", "100"], ["margin", "100,01"], ["margin", "-5"], ["margin", "abc"], ["margin", ""],
    ["unit_bulk", "100"], ["unit_bulk", "-1"], ["unit_bulk", ""],
    ["pack", "100"], ["pack", "-1"], ["pack", ""],
    ["card", "100"], ["card", "-2"], ["card", "10%"], ["card", "1e1"], ["card", "12,345"]
  ])("rechaza %s = %j", (key, value) => {
    expect(() => parsePricingConfigForm(form({ ...VALID, [key]: value }))).toThrow();
  });

  it("el error nombra el campo", () => {
    expect(() => parsePricingConfigForm(form({ ...VALID, margin: "100" }))).toThrow(/margen/i);
    expect(() => parsePricingConfigForm(form({ ...VALID, pack: "100" }))).toThrow(/pack/i);
  });
});

describe("parseExcludedCategoryIds (categorías excluidas del margen automático, por id)", () => {
  it("sin el marcador excluded_sent el formulario no tocó la lista (null: el servidor la deja como está)", () => {
    expect(parseExcludedCategoryIds(form({}))).toBeNull();
  });

  it("con el marcador y ninguna casilla marcada la lista queda vacía (se quitaron todas)", () => {
    expect(parseExcludedCategoryIds(form({ excluded_sent: "1" }))).toEqual([]);
  });

  it("devuelve los ids marcados, sin repetir ni vacíos (nunca nombres)", () => {
    const data = new FormData();
    data.set("excluded_sent", "1");
    for (const id of ["a-1", "b-2", "a-1", " ", ""]) data.append("excluded_category", id);
    expect(parseExcludedCategoryIds(data)).toEqual(["a-1", "b-2"]);
  });
});

describe("resultado del guardado de la configuración", () => {
  const preview = parsePricingConfigOutcome({
    requiresConfirmation: true, previousMarginBps: 3000, marginBps: 3500, recalculated: 1843, unchanged: 54, withoutCost: 27, scheduledPrice: 0
  });

  it("normaliza el JSON del servidor (números y faltantes)", () => {
    expect(preview).toMatchObject({ requiresConfirmation: true, previousMarginBps: 3_000, marginBps: 3_500, recalculated: 1_843, unchanged: 54, withoutCost: 27 });
    expect(parsePricingConfigOutcome(null)).toMatchObject({ requiresConfirmation: false, previousMarginBps: null, recalculated: 0, packsUpdated: 0 });
    expect(parsePricingConfigOutcome({ recalculated: "7" }).recalculated).toBe(0);
  });

  it("la vista previa dice cuántos precios cambian, cuántos no tienen costo y cuántos no cambian", () => {
    const lines = describePricingConfigPreview(preview);
    expect(lines).toContain("Se recalcularán (automáticos con margen global): 1.843 productos");
    expect(lines).toContain("Sin costo (conservan su precio): 27");
    expect(lines).toContain("Ya tienen ese precio: 54");
    expect(describePricingConfigPreviewNotes(preview).join(" ")).toContain("historial");
  });

  it("la vista previa muestra los excluidos por categoría y los nombres de las categorías excluidas (Vaca · Cerdo · Pollo)", () => {
    const withExclusions = parsePricingConfigOutcome({
      requiresConfirmation: true, marginChanged: true, previousMarginBps: 2500, marginBps: 3000, recalculated: 1742, unchanged: 0, withoutCost: 21, excludedByCategory: 83,
      branchOverrides: 4, customMargin: 12, excludedCategoryIds: ["c1", "c2", "c3"]
    });
    expect(describePricingConfigPreview(withExclusions, { c1: "Vaca", c2: "Cerdo", c3: "Pollo" })).toEqual([
      "Margen nuevo: 30%",
      "Se recalcularán (automáticos con margen global): 1.742 productos",
      "Margen personalizado (no se tocan): 12",
      "Excluidos / precio manual (conservan su precio): 83",
      "Sin costo (conservan su precio): 21",
      "Ya tienen ese precio: 0",
      "Con precio por sucursal: 4",
      "Categorías excluidas: Vaca · Cerdo · Pollo"
    ]);
    expect(describePricingConfigPreviewNotes(withExclusions).join(" ")).toContain("NO van a cambiar de precio");
    expect(describePricingConfigPreview({ ...withExclusions, excludedCategoryIds: [] })).toContain("Categorías excluidas: ninguna");
  });

  it("quitar una categoría de la exclusión sin cambiar el margen: dice cuántos productos pasan a automáticos y qué precios cambian", () => {
    const removal = parsePricingConfigOutcome({
      requiresConfirmation: true, marginChanged: false, marginBps: 3000, recalculated: 3, newlyAutomatic: 5, excludedByCategory: 10,
      removedExcludedCategoryIds: ["c1"], excludedCategoryIds: ["c2"],
      sample: [{ name: "Vacío", currentCents: 1_250_000, newCents: 1_142_857 }, { name: "Sin precio", currentCents: null, newCents: 500_000 }, { name: 7 }]
    });
    const lines = describePricingConfigPreview(removal, { c1: "Vaca", c2: "Cerdo" });
    expect(lines[0]).toBe("Margen: 30% (sin cambios)");
    expect(lines).toContain("Pasan a pricing automático (salen de la exclusión: Vaca): 5 productos");
    expect(describePricingConfigSample(removal)).toEqual(["Vacío: $ 12.500 → $ 11.428,57", "Sin precio: sin precio → $ 5.000"]);
    expect(describePricingConfigPreviewNotes(removal).join(" ")).toContain("vigencia nueva de precio");
    expect(describePricingConfigOutcome({ ...removal, requiresConfirmation: false }, false)).toEqual([
      "Productos que pasaron a pricing automático y se recalcularon: 3",
      "Productos con precio manual (categorías excluidas, no se tocan): 10"
    ]);
  });

  it("el resultado de un cambio de margen informa los productos con precio manual que no se tocaron", () => {
    const lines = describePricingConfigOutcome(parsePricingConfigOutcome({ marginBps: 3500, previousMarginBps: 3000, recalculated: 9, excludedByCategory: 83 }), true);
    expect(lines).toContain("Productos con precio manual (categorías excluidas, no se tocan): 83");
  });

  it("el resultado de un cambio de margen informa los productos con margen personalizado que no se tocaron (D-070)", () => {
    const lines = describePricingConfigOutcome(parsePricingConfigOutcome({ marginBps: 3500, previousMarginBps: 3000, recalculated: 9, customMargin: 4 }), true);
    expect(lines).toContain("Productos con margen personalizado (no dependen del margen global, no se tocan): 4");
    expect(describePricingConfigOutcome(parsePricingConfigOutcome({ marginBps: 3500, previousMarginBps: 3000, recalculated: 9 }), true).join(" ")).not.toContain("personalizado");
    expect(parsePricingConfigOutcome({}).customMargin).toBe(0);
  });

  it("el resultado informa recalculados / sin costo / sin cambios, y packs y promociones actualizados", () => {
    const lines = describePricingConfigOutcome({ ...preview, requiresConfirmation: false, packsUpdated: 12, branchPromotionsUpdated: 3 }, true);
    expect(lines).toEqual([
      "Productos recalculados: 1.843",
      "Productos sin costo (conservan su precio): 27",
      "Sin cambios: 54",
      "Packs actualizados: 12",
      "Sucursales con la promoción actualizada: 3"
    ]);
  });

  it("la vista previa advierte de los precios por sucursal que le ganarían al global, y los que quedan fuera", () => {
    const withOverrides = parsePricingConfigOutcome({ requiresConfirmation: true, marginBps: 3500, recalculated: 10, unchanged: 1, withoutCost: 2, branchOverrides: 3, branchOverridesOther: 4 });
    const message = describePricingConfigPreviewNotes(withOverrides).join(" ");
    expect(message).toContain("ATENCIÓN: 3 productos tienen un precio propio de sucursal");
    expect(message).toContain("cerrarlos");
    expect(message).toContain("4 precios por sucursal");
    expect(describePricingConfigPreviewNotes(preview).join(" ")).not.toContain("ATENCIÓN");
  });

  it("el resultado dice cuántos precios por sucursal se cerraron y avisa de los que siguen ganando", () => {
    const closed = describePricingConfigOutcome(parsePricingConfigOutcome({ marginBps: 3500, previousMarginBps: 3000, branchOverrides: 3, branchOverridesClosed: 3 }), true);
    expect(closed).toContain("Precios por sucursal cerrados (rige el precio global; el historial se conserva): 3");
    expect(closed.join(" ")).not.toContain("ATENCIÓN");
    const open = describePricingConfigOutcome(parsePricingConfigOutcome({ marginBps: 3500, previousMarginBps: 3000, branchOverrides: 2, branchOverridesClosed: 0 }), true);
    expect(open.join(" ")).toContain("ATENCIÓN: 2 precios por sucursal siguen vigentes y le ganan al precio global en el POS");
  });

  it("sin cambio de margen no habla de recálculo", () => {
    const lines = describePricingConfigOutcome({ ...preview, requiresConfirmation: false, recalculated: 0, packsUpdated: 0, branchPromotionsUpdated: 0 }, false);
    expect(lines).toEqual([]);
  });
});

describe("parseCostCents (carga masiva de costos)", () => {
  it.each([["3500", 350_000], ["3500,5", 350_050], ["3500.50", 350_050], [" 4000 ", 400_000], ["0,01", 1], ["10000", 1_000_000]])("%j → %i centavos", (raw, cents) => {
    expect(parseCostCents(raw)).toBe(cents);
  });

  it.each(["", "0", "0,00", "-5", "abc", "12,345", "1e3", "3 500", "$3500"])("rechaza %j", (raw) => {
    expect(parseCostCents(raw)).toBeNull();
  });
});

describe("changedCostItems (sólo las filas cuyo costo realmente cambió)", () => {
  const rows = [
    { id: "aceite", currentCostCents: 350_000 },
    { id: "yerba", currentCostCents: 400_000 },
    { id: "sin-costo", currentCostCents: null },
    { id: "otro", currentCostCents: 100_000 }
  ];

  it("envía las filas con costo nuevo distinto del vigente", () => {
    expect(changedCostItems(rows, { aceite: "4000", "sin-costo": "250" })).toEqual([
      { productId: "aceite", costCents: 400_000 },
      { productId: "sin-costo", costCents: 25_000 }
    ]);
  });

  it("ignora casillas vacías, inválidas o iguales al costo vigente", () => {
    expect(changedCostItems(rows, { aceite: "3500", yerba: "", otro: "abc" })).toEqual([]);
    expect(changedCostItems(rows, {})).toEqual([]);
  });

  it("una fila filtrada de la vista conserva su edición (el estado va por id)", () => {
    expect(changedCostItems(rows.slice(0, 1), { aceite: "4000", yerba: "5000" })).toEqual([{ productId: "aceite", costCents: 400_000 }]);
  });

  it("jamás incluye un precio: el precio de venta lo recalcula el servidor", () => {
    for (const item of changedCostItems(rows, { aceite: "4000" })) expect(Object.keys(item).sort()).toEqual(["costCents", "productId"]);
  });
});

describe("costPlaceholder", () => {
  it("muestra el costo actual sin ceros sobrantes, o «Sin costo»", () => {
    expect(costPlaceholder(350_000)).toBe("3500");
    expect(costPlaceholder(350_050)).toBe("3500.5");
    expect(costPlaceholder(350_005)).toBe("3500.05");
    expect(costPlaceholder(null)).toBe("Sin costo");
  });
});
