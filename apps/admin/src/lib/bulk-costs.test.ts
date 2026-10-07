import { describe, expect, it } from "vitest";

import { changedBulkItems, displayedMarginBps, marginChange, parseBulkItems, parseMarginBps, type BulkEditRowRef } from "./bulk-costs";

const global40: BulkEditRowRef = { id: "g", currentCostCents: 350_000, customMarginBps: null, globalMarginBps: 4_000 };
const own5: BulkEditRowRef = { id: "p", currentCostCents: 450_000, customMarginBps: 500, globalMarginBps: null };
const manual: BulkEditRowRef = { id: "m", currentCostCents: 900_000, customMarginBps: null, globalMarginBps: null };
const rows = [global40, own5, manual];

describe("margen mostrado vs. override persistido", () => {
  it("global 40% se muestra como 40 pero no crea override", () => {
    expect(displayedMarginBps(global40)).toBe(4_000);
    expect(changedBulkItems(rows, {})).toEqual([]);
    // Tocar el campo sin cambiar el valor (escribir 40 o 40,00) tampoco guarda nada.
    expect(changedBulkItems(rows, { g: { margin: "40" } })).toEqual([]);
    expect(changedBulkItems(rows, { g: { margin: "40,00" } })).toEqual([]);
  });

  it("editar 40 → 30 crea margen propio 30%", () => {
    expect(changedBulkItems(rows, { g: { margin: "30" } })).toEqual([{ productId: "g", marginBps: 3_000 }]);
  });

  it("margen propio 5% se muestra como 5 y el mismo valor no cambia nada", () => {
    expect(displayedMarginBps(own5)).toBe(500);
    expect(changedBulkItems(rows, { p: { margin: "5" } })).toEqual([]);
    expect(changedBulkItems(rows, { p: { margin: "5,5" } })).toEqual([{ productId: "p", marginBps: 550 }]);
  });

  it("categoría excluida sin margen propio: no muestra margen (precio manual); escribir 25 crea margen propio 25%", () => {
    expect(displayedMarginBps(manual)).toBeNull();
    expect(changedBulkItems(rows, { m: { margin: "25" } })).toEqual([{ productId: "m", marginBps: 2_500 }]);
  });
});

describe("volver al comportamiento por defecto", () => {
  it("«Usar global» / «Usar precio manual» elimina el override (margen null)", () => {
    expect(changedBulkItems(rows, { p: { reset: true } })).toEqual([{ productId: "p", marginBps: null }]);
    const ownExcluded: BulkEditRowRef = { id: "x", currentCostCents: 800_000, customMarginBps: 2_500, globalMarginBps: null };
    expect(changedBulkItems([ownExcluded], { x: { reset: true } })).toEqual([{ productId: "x", marginBps: null }]);
  });

  it("reset gana sobre un margen escrito y no hace nada en una fila sin override", () => {
    expect(marginChange(own5, { margin: "12", reset: true })).toBeNull();
    expect(changedBulkItems(rows, { g: { reset: true } })).toEqual([]);
  });
});

describe("costo, margen o ambos", () => {
  it("sólo costo", () => {
    expect(changedBulkItems(rows, { g: { cost: "4000" } })).toEqual([{ productId: "g", costCents: 400_000 }]);
  });

  it("sólo margen", () => {
    expect(changedBulkItems(rows, { p: { margin: "10" } })).toEqual([{ productId: "p", marginBps: 1_000 }]);
  });

  it("costo + margen en una sola entrada (el servidor forma UNA vigencia de precio)", () => {
    expect(changedBulkItems(rows, { p: { cost: "5000", margin: "10" } })).toEqual([{ productId: "p", costCents: 500_000, marginBps: 1_000 }]);
  });

  it("costo igual al vigente, vacío o inválido no cuenta; margen vacío o inválido tampoco", () => {
    expect(changedBulkItems(rows, { g: { cost: "3500", margin: "" }, p: { cost: "abc", margin: "0" }, m: { cost: "", margin: "100" } })).toEqual([]);
  });

  it("filas sin cambios no se envían, aunque haya otras modificadas", () => {
    expect(changedBulkItems(rows, { g: { cost: "3500" }, p: { cost: "4600" } }).map((item) => item.productId)).toEqual(["p"]);
  });

  it("costo + reset: el costo viaja junto al margen null", () => {
    expect(changedBulkItems(rows, { p: { cost: "4600", reset: true } })).toEqual([{ productId: "p", costCents: 460_000, marginBps: null }]);
  });
});

describe("parseo del margen (mismo parser y límites que el editor del producto)", () => {
  it("acepta 5, 5,5, 20, 30,25 y los pasa a basis points enteros", () => {
    expect(["5", "5,5", "20", "30,25", "30.25"].map(parseMarginBps)).toEqual([500, 550, 2_000, 3_025, 3_025]);
  });

  it("rechaza 0, 100, vacío y texto", () => {
    expect(["0", "100", "", "abc", "-5", "5,555"].map(parseMarginBps)).toEqual([null, null, null, null, null, null]);
  });
});

describe("parseBulkItems (el servidor no confía en el cliente)", () => {
  it("acepta costo, margen, margen null y ambos", () => {
    expect(parseBulkItems([{ productId: "a", costCents: 100 }, { productId: "b", marginBps: null }, { productId: "c", costCents: 5, marginBps: 2_500 }])).toHaveLength(3);
  });

  it("rechaza costo no entero, margen fuera de rango, duplicados y entradas vacías", () => {
    expect(() => parseBulkItems([{ productId: "a", costCents: 1.5 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", costCents: 0 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", marginBps: 10_000 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", marginBps: 0 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a", costCents: 1 }, { productId: "a", costCents: 2 }])).toThrow();
    expect(() => parseBulkItems([{ productId: "a" }])).toThrow();
    expect(() => parseBulkItems("x")).toThrow();
  });
});
