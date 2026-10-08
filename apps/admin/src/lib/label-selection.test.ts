import { describe, expect, it } from "vitest";

import { buildRunSelection, parseCopies, selectAllPrintable, selectNeedingPrint, sheetsFor, type SelectableItem } from "./label-selection";

const items: SelectableItem[] = [
  { productId: "a", printable: true, needsPrint: false },
  { productId: "b", printable: true, needsPrint: true },
  { productId: "c", printable: false, needsPrint: false },
  { productId: "d", printable: true, needsPrint: true }
];

describe("selección de etiquetas", () => {
  it("«Seleccionar todos» toma los imprimibles (no los inactivos / sin precio)", () => {
    expect([...selectAllPrintable(items)]).toEqual(["a", "b", "d"]);
  });

  it("«Seleccionar precios cambiados» toma los que cambiaron o nunca se imprimieron, y sólo los imprimibles", () => {
    expect([...selectNeedingPrint(items)]).toEqual(["b", "d"]);
    expect(selectNeedingPrint([{ productId: "x", printable: false, needsPrint: true }]).size).toBe(0);
  });

  it("copias: entero de 1 a 99", () => {
    expect(["1", "2", " 3 ", "99"].map(parseCopies)).toEqual([1, 2, 3, 99]);
    for (const bad of ["", "0", "-1", "1.5", "1,5", "100", "abc", "1e2", "٣"]) expect(parseCopies(bad), bad).toBeNull();
  });

  it("el pedido sigue el orden del grupo y por defecto cada producto lleva 1 copia", () => {
    const selection = buildRunSelection(items, new Set(["d", "a", "b"]), { b: "3" });
    expect(selection.items).toEqual([{ productId: "a", copies: 1 }, { productId: "b", copies: 3 }, { productId: "d", copies: 1 }]);
    expect(selection.labelCount).toBe(5);
    expect(selection.invalidCopies).toEqual([]);
    expect(selection.overLimit).toBe(false);
  });

  it("un producto no imprimible tildado se ignora; copias inválidas se reportan y no entran", () => {
    const selection = buildRunSelection(items, new Set(["a", "c", "b"]), { a: "0", b: "2" });
    expect(selection.items).toEqual([{ productId: "b", copies: 2 }]);
    expect(selection.invalidCopies).toEqual(["a"]);
  });

  it("avisa cuando se pasa del tope de etiquetas por PDF", () => {
    const selection = buildRunSelection(items, new Set(["a", "b", "d"]), { a: "99", b: "99", d: "99" });
    expect(selection.labelCount).toBe(297);
    expect(buildRunSelection(items, new Set(["a", "b", "d"]), { a: "99", b: "99", d: "99" }).overLimit).toBe(false);
    const many: SelectableItem[] = Array.from({ length: 6 }, (_, index) => ({ productId: String(index), printable: true, needsPrint: false }));
    expect(buildRunSelection(many, new Set(many.map((item) => item.productId)), Object.fromEntries(many.map((item) => [item.productId, "99"]))).overLimit).toBe(true);
  });

  it("hojas A4 necesarias (21 por hoja)", () => {
    expect([0, 1, 21, 22, 42, 43].map((count) => sheetsFor(count))).toEqual([0, 1, 1, 2, 2, 3]);
  });
});
