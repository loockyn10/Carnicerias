import { describe, expect, it } from "vitest";

import { buildPurgeCandidates, classifySourceQuantity, parseCsvText, suggestColumnMapping } from "./catalog-import";

const HEADER = "CODIGO;DESCRIPCION;BARRAS;FAMILIA;PRECIO;COSTO;CANTIDAD";

function build(lines: string[]) {
  const table = parseCsvText([HEADER, ...lines].join("\n"));
  const mapping = suggestColumnMapping(table.headers);
  return buildPurgeCandidates(table, mapping, { numberFormat: "AR" });
}

describe("classifySourceQuantity: CANTIDAD original de SimplyGest", () => {
  it.each([
    ["0", "NON_POSITIVE"],
    ["0,000", "NON_POSITIVE"],
    ["-0", "NON_POSITIVE"],
    ["-3", "NON_POSITIVE"],
    ["-1,5", "NON_POSITIVE"],
    ["-1.250,75", "NON_POSITIVE"],
    ["1", "POSITIVE"],
    ["0,5", "POSITIVE"],
    ["12", "POSITIVE"],
    ["1.500", "POSITIVE"],
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["sin dato", "UNREADABLE"],
    ["12abc", "UNREADABLE"]
  ])("%j → %s", (text, expected) => {
    expect(classifySourceQuantity(text).kind).toBe(expected);
  });

  it("entiende celdas numéricas de Excel", () => {
    expect(classifySourceQuantity(0).kind).toBe("NON_POSITIVE");
    expect(classifySourceQuantity(-2).kind).toBe("NON_POSITIVE");
    expect(classifySourceQuantity(2.5).kind).toBe("POSITIVE");
    expect(classifySourceQuantity(null).kind).toBe("EMPTY");
  });

  it("normaliza los negativos para el servidor", () => {
    expect(classifySourceQuantity("-3")).toEqual({ kind: "NON_POSITIVE", normalized: "-3" });
    expect(classifySourceQuantity("-1.250,75")).toEqual({ kind: "NON_POSITIVE", normalized: "-1250.75" });
    expect(classifySourceQuantity("-0,50")).toEqual({ kind: "NON_POSITIVE", normalized: "-0.5" });
    expect(classifySourceQuantity("0,00")).toEqual({ kind: "NON_POSITIVE", normalized: "0" });
  });
});

describe("buildPurgeCandidates: sólo CANTIDAD <= 0 del archivo original, identificados por código", () => {
  it("CANTIDAD > 0 nunca es candidato; 0 y negativas sí", () => {
    const result = build([
      "A100;Yerba;7790001;Almacen;1500,00;900,00;12",
      "A101;Arroz;7790002;Almacen;900,00;500,00;0",
      "A102;Fideos;7790003;Almacen;800,00;400,00;-4",
      "A103;Aceite;7790004;Almacen;2500,00;1800,00;0,5"
    ]);
    expect(result.candidates.map((candidate) => [candidate.externalId, candidate.quantity])).toEqual([["A101", "0"], ["A102", "-4"]]);
    expect(result.positiveRows).toBe(2);
    expect(result.totalRows).toBe(4);
  });

  it("devuelve código, nombre y CANTIDAD original de cada candidato", () => {
    const [candidate] = build(["a101;  Arroz   largo fino ;7790002;Almacen;900,00;500,00;0,000"]).candidates;
    expect(candidate).toEqual({ rowNumber: 2, externalId: "A101", name: "Arroz largo fino", quantity: "0", quantityText: "0,000" });
  });

  it("sin código usa el mismo identificador externo que el importador (BC:<barcode>)", () => {
    const [candidate] = build([";Producto sin código;7790009;Almacen;100,00;;0"]).candidates;
    expect(candidate?.externalId).toBe("BC:7790009");
  });

  it("un código repetido: sólo cuenta la PRIMERA fila (la única que el importador creó)", () => {
    // La fila 2 (stock 5) fue la importada; la fila 3 repite el código con CANTIDAD 0 y el importador la rechazó.
    const result = build([
      "A200;Leche;7790010;Almacen;1200,00;800,00;5",
      "A200;Leche duplicada;7790011;Almacen;1200,00;800,00;0"
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.notImportedRows).toBe(1);
    expect(result.positiveRows).toBe(1);
  });

  it("una fila que el importador rechazó (sin precio) no es candidata", () => {
    const result = build(["A300;Sin precio;7790020;Almacen;;;0"]);
    expect(result.candidates).toEqual([]);
    expect(result.notImportedRows).toBe(1);
  });

  it("CANTIDAD vacía o ilegible no es evidencia de 'sin stock': no es candidato", () => {
    const result = build([
      "A400;Vacio;7790030;Almacen;100,00;;",
      "A401;Ilegible;7790031;Almacen;100,00;;n/d"
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.emptyQuantityRows).toBe(1);
    expect(result.unreadableQuantityRows).toBe(1);
  });

  it("exige la columna de cantidad", () => {
    const table = parseCsvText([HEADER, "A1;X;7790040;Almacen;100,00;;0"].join("\n"));
    const mapping = { ...suggestColumnMapping(table.headers), stock: null };
    expect(() => buildPurgeCandidates(table, mapping, { numberFormat: "AR" })).toThrow(RangeError);
  });
});
