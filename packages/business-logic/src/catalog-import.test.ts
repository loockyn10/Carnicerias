import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  chunkItems,
  decodeCsvBytes,
  detectCsvDelimiter,
  detectNumberFormat,
  detectTableNumberFormat,
  mapCatalogRows,
  normalizeImportText,
  parseCsvText,
  suggestColumnMapping,
  tableFromRecords,
  validateColumnMapping,
  type CatalogColumnMapping,
  type CatalogMappingOptions
} from "./catalog-import";

function fixture(name: string): string {
  return decodeCsvBytes(readFileSync(fileURLToPath(new URL(`../../../supabase/fixtures/imports/${name}`, import.meta.url))));
}

const AR_WITH_STOCK: CatalogMappingOptions = { numberFormat: "AR", importStock: true };
const AR_NO_STOCK: CatalogMappingOptions = { numberFormat: "AR", importStock: false };

function mapSample(options: CatalogMappingOptions) {
  const table = parseCsvText(fixture("simplygest-sample.csv"));
  return { table, result: mapCatalogRows(table, suggestColumnMapping(table.headers), options) };
}

describe("CSV parsing", () => {
  it("detects the delimiter of Argentine exports (;), commas and tabs", () => {
    expect(detectCsvDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectCsvDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectCsvDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("keeps delimiters, quotes and line breaks that are inside quoted fields", () => {
    const table = parseCsvText('nombre,precio\n"Aceite, 900 cc",100\n"Dice ""hola""\nlinea 2",200\n');
    expect(table.headers).toEqual(["nombre", "precio"]);
    expect(table.rows.map((row) => row.cells)).toEqual([["Aceite, 900 cc", "100"], ['Dice "hola"\nlinea 2', "200"]]);
  });

  it("numbers rows like the source file: header is row 1, blank lines are skipped but counted", () => {
    const table = parseCsvText("a;b\n1;2\n\n;\n3;4\n");
    expect(table.rows.map((row) => row.rowNumber)).toEqual([2, 5]);
  });

  it("handles CRLF files and a byte-order mark", () => {
    const bytes = new TextEncoder().encode("﻿codigo;nombre\r\n1;Vacío\r\n");
    const table = parseCsvText(decodeCsvBytes(bytes));
    expect(table.headers).toEqual(["codigo", "nombre"]);
    expect(table.rows[0]?.cells).toEqual(["1", "Vacío"]);
  });

  it("falls back to Windows-1252 when the file is not valid UTF-8 (so accents survive)", () => {
    const latin1 = Uint8Array.from([0x56, 0x61, 0x63, 0xed, 0x6f]); // "Vacío" in windows-1252
    expect(decodeCsvBytes(latin1)).toBe("Vacío");
  });

  it("gives blank headers a name instead of dropping the column", () => {
    expect(tableFromRecords([["a", "", "c"], ["1", "2", "3"]]).headers).toEqual(["a", "Columna 2", "c"]);
  });
});

describe("column mapping suggestion", () => {
  it("recognises the SimplyGest-style headers from the spec example", () => {
    const mapping = suggestColumnMapping(["CODIGO", "DESCR", "BARRAS", "FAMILIA", "PRECIO", "COSTO", "STOCK"]);
    expect(mapping).toEqual({ code: 0, name: 1, barcode: 2, category: 3, saleType: null, price: 4, cost: 5, supplier: null, supplierCode: null, stock: 6 });
  });

  it("does not assume exact names: accents, spaces and alternatives still map", () => {
    const mapping = suggestColumnMapping(["Cód. Artículo", "Descripción", "Código de Barras", "Rubro", "Precio de Venta", "Costo", "Existencia"]);
    expect(mapping).toEqual({ code: 0, name: 1, barcode: 2, category: 3, saleType: null, price: 4, cost: 5, supplier: null, supplierCode: null, stock: 6 });
  });

  it("never gives one column to two fields, and leaves unknown fields unmapped", () => {
    const mapping = suggestColumnMapping(["Codigo", "Nombre", "Precio"]);
    expect(mapping).toEqual({ code: 0, name: 1, barcode: null, category: null, saleType: null, supplier: null, supplierCode: null, price: 2, cost: null, stock: null });
    expect(new Set(Object.values(mapping).filter((value) => value !== null)).size).toBe(3);
  });

  it("does not take the barcode column for the code column", () => {
    const mapping = suggestColumnMapping(["Código de barras", "Nombre", "Precio"]);
    expect(mapping.barcode).toBe(0);
    expect(mapping.code).toBeNull();
  });
});

describe("validateColumnMapping", () => {
  const complete: CatalogColumnMapping = { code: 0, name: 1, barcode: null, category: null, saleType: null, supplier: null, supplierCode: null, price: 2, cost: null, stock: null };

  it("accepts name + price + a code", () => {
    expect(validateColumnMapping(complete)).toEqual([]);
  });

  it("requires name and price", () => {
    expect(validateColumnMapping({ ...complete, name: null })).toHaveLength(1);
    expect(validateColumnMapping({ ...complete, price: null })).toHaveLength(1);
  });

  it("requires a stable identifier: code or barcode", () => {
    expect(validateColumnMapping({ ...complete, code: null })).toHaveLength(1);
    expect(validateColumnMapping({ ...complete, code: null, barcode: 3 })).toEqual([]);
  });

  it("rejects the same column assigned twice", () => {
    expect(validateColumnMapping({ ...complete, category: 1 })).toHaveLength(1);
  });
});

describe("number formats", () => {
  it("detects Argentine and international formats from the values", () => {
    expect(detectNumberFormat(["1.234,56", "10,5"])).toBe("AR");
    expect(detectNumberFormat(["1,234.56", "10.5"])).toBe("INTL");
    expect(detectNumberFormat(["100", "2500"])).toBe("AR"); // no evidence → default
  });

  it("samples the mapped columns of a table", () => {
    const table = tableFromRecords([["codigo", "nombre", "precio"], ["1", "A", "1,234.50"], ["2", "B", "9.99"]]);
    expect(detectTableNumberFormat(table, { code: 0, name: 1, barcode: null, category: null, saleType: null, supplier: null, supplierCode: null, price: 2, cost: null, stock: null })).toBe("INTL");
  });

  it("parses prices to integer cents with half-up rounding", () => {
    const table = tableFromRecords([["c", "n", "p"], ["1", "A", "1.234,50"], ["2", "B", "0,005"], ["3", "C", "10"], ["4", "D", "$ 99,999"]]);
    const mapping: CatalogColumnMapping = { code: 0, name: 1, barcode: null, category: null, saleType: null, supplier: null, supplierCode: null, price: 2, cost: null, stock: null };
    const result = mapCatalogRows(table, mapping, AR_NO_STOCK);
    expect(result.rows.map((row) => row.display.priceCents)).toEqual([123450, 1, 1000, 10000]);
  });

  it("reads spreadsheet numbers without float noise", () => {
    const table = tableFromRecords([["c", "n", "p"], ["1", "A", 19.99], ["2", "B", 1.005], ["3", "C", 4500]]);
    const mapping: CatalogColumnMapping = { code: 0, name: 1, barcode: null, category: null, saleType: null, supplier: null, supplierCode: null, price: 2, cost: null, stock: null };
    expect(mapCatalogRows(table, mapping, AR_NO_STOCK).rows.map((row) => row.display.priceCents)).toEqual([1999, 101, 450000]);
  });
});

describe("mapCatalogRows — the SimplyGest sample file", () => {
  it("maps the fields to the canonical product payload (UNIT, price and cost in cents)", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const coca = result.rows[0];
    expect(coca?.invalidReason).toBeNull();
    expect(coca?.externalId).toBe("1001");
    expect(coca?.payload).toEqual({
      name: "Coca Cola 2.25 L",
      unitType: "UNIT",
      sku: "1001",
      barcodes: ["7790895000010"],
      categoryName: "Bebidas",
      priceCents: 450000,
      costCents: 300000
    });
    expect(coca?.stockUnits).toBe(24);
  });

  it("never sends active/inventoryRole (an update must not reactivate or re-role a product)", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    for (const row of result.rows) {
      expect(row.payload).not.toHaveProperty("active");
      expect(row.payload).not.toHaveProperty("inventoryRole");
    }
  });

  it("an empty cost is simply omitted", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const agua = result.rows[1];
    expect(agua?.invalidReason).toBeNull();
    expect(agua?.payload).not.toHaveProperty("costCents");
    expect(agua?.display.priceCents).toBe(120050);
  });

  it("a row without a category carries none (the batch default, Almacen, is applied by the database)", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const sal = result.rows.find((row) => row.display.name === "Sal Fina 500 g");
    expect(sal?.payload).not.toHaveProperty("categoryName");
  });

  it("lists distinct categories once, ignoring case (a new category is created once)", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    expect(result.categories.map(normalizeImportText).sort()).toEqual(["aceites", "almacen", "bebidas", "cerdo", "conservas", "infusiones"]);
  });

  it("rejects, with a readable cause: repeated barcode, repeated code, missing name, missing price, fractional stock, negative stock", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const reasons = result.rows.filter((row) => row.invalidReason).map((row) => [row.rowNumber, row.invalidReason]);
    expect(reasons).toEqual([
      [8, "El código de barras 7790895000010 ya aparece en la fila 2 del archivo"],
      [9, "El código 1003 ya aparece en la fila 4 del archivo"],
      [10, "Falta el nombre del producto"],
      [11, "Falta el precio de venta"],
      [12, expect.stringContaining("Stock fraccionado (2,5)")],
      [13, expect.stringContaining("Stock negativo (-4)")]
    ]);
    expect(result.invalidRows).toBe(6);
    expect(result.totalRows).toBe(14);
  });

  it("with “Importar stock actual” off, the stock column is ignored and cannot invalidate a row", () => {
    const { result } = mapSample(AR_NO_STOCK);
    expect(result.invalidRows).toBe(4);
    expect(result.rows.every((row) => row.stockUnits === null)).toBe(true);
    expect(result.rows.find((row) => row.display.name === "Gaseosa Fraccionada")?.invalidReason).toBeNull();
  });

  it("a zero stock imports the product without a stock movement", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const aceite = result.rows.find((row) => row.display.name === "Aceite Girasol 900 cc");
    expect(aceite?.invalidReason).toBeNull();
    expect(aceite?.stockUnits).toBeNull();
  });

  it("rejected rows are still produced, with a synthetic id and the cause in the payload, so the database records the whole file", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    const invalid = result.rows.filter((row) => row.invalidReason);
    expect(invalid).toHaveLength(6);
    for (const row of invalid) {
      expect(row.externalId).toBe(`INVALID:${String(row.rowNumber)}`);
      expect(row.payload.invalidReason).toBe(row.invalidReason);
      expect(row.stockUnits).toBeNull();
    }
    expect(result.rows).toHaveLength(14);
  });

  it("keeps the original row (header → text) for audit", () => {
    const { result } = mapSample(AR_WITH_STOCK);
    expect(result.rows[0]?.raw).toEqual({ CODIGO: "1001", DESCRIPCION: "Coca Cola 2.25 L", BARRAS: "7790895000010", FAMILIA: "Bebidas", PRECIO: "4.500,00", COSTO: "3.000,00", STOCK: "24" });
  });
});

describe("mapCatalogRows — edge cases", () => {
  const mapping: CatalogColumnMapping = { code: 0, name: 1, barcode: 2, category: null, saleType: null, supplier: null, supplierCode: null, price: 3, cost: null, stock: null };
  const run = (rows: string[][]) => mapCatalogRows(tableFromRecords([["c", "n", "b", "p"], ...rows]), mapping, AR_NO_STOCK);

  it("rejects a barcode that a spreadsheet turned into scientific notation", () => {
    const row = run([["1", "A", "7,79E+12", "10"]]).rows[0];
    expect(row?.invalidReason).toContain("notación científica");
  });

  it("accepts a numeric barcode cell from an Excel file without exponent artifacts", () => {
    const table = tableFromRecords([["c", "n", "b", "p"], ["1", "A", 7790895000013, 10]]);
    const row = mapCatalogRows(table, mapping, AR_NO_STOCK).rows[0];
    expect(row?.payload.barcodes).toEqual(["7790895000013"]);
  });

  it("treats placeholder barcodes (0000…, -) as no barcode", () => {
    const rows = run([["1", "A", "0", "10"], ["2", "B", "-", "10"], ["3", "C", "0000000000000", "10"]]).rows;
    expect(rows.every((row) => row.invalidReason === null && !row.payload.barcodes)).toBe(true);
  });

  it("rejects a malformed barcode instead of importing a broken scanner code", () => {
    expect(run([["1", "A", "12", "10"]]).rows[0]?.invalidReason).toContain("Código de barras inválido");
  });

  it("identifies a product by barcode when the file has no code, and still catches repeats", () => {
    const table = tableFromRecords([["c", "n", "b", "p"], ["", "A", "7790000000001", "10"], ["", "B", "7790000000001", "10"], ["", "C", "", "10"]]);
    const rows = mapCatalogRows(table, mapping, AR_NO_STOCK).rows;
    expect(rows[0]?.externalId).toBe("BC:7790000000001");
    expect(rows[0]?.payload).not.toHaveProperty("sku");
    expect(rows[1]?.invalidReason).toContain("ya aparece en la fila 2");
    expect(rows[2]?.invalidReason).toContain("ni código de barras");
  });

  it("rejects a repeated name under another code (no silent twin products)", () => {
    const rows = run([["1", "Vacío", "", "10"], ["2", "VACIO", "", "10"]]).rows;
    expect(rows[1]?.invalidReason).toContain("ya aparece en la fila 2");
  });

  it("the first occurrence wins even when an earlier DIFFERENT row was invalid", () => {
    const rows = run([["1", "", "", "10"], ["1", "A", "", "10"]]).rows;
    expect(rows[0]?.invalidReason).toBe("Falta el nombre del producto");
    expect(rows[1]?.invalidReason).toBeNull();
  });

  it("accepts a price of 0 (SimplyGest products priced at the counter) and rejects negative or malformed ones, and a negative cost", () => {
    const withCost: CatalogColumnMapping = { ...mapping, cost: 4 };
    const table = tableFromRecords([["c", "n", "b", "p", "k"], ["1", "A", "", "0", ""], ["2", "B", "", "abc", ""], ["3", "C", "", "-5", ""], ["4", "D", "", "10", "-2"], ["5", "E", "", "10", "0"], ["6", "F", "", "0,00", ""], ["7", "G", "", "-0", ""], ["8", "H", "", "", ""]]);
    const rows = mapCatalogRows(table, withCost, AR_NO_STOCK).rows;
    expect(rows.map((row) => row.invalidReason)).toEqual([
      null,
      expect.stringContaining("Precio inválido"),
      expect.stringContaining("no puede ser negativo"),
      expect.stringContaining("costo no puede ser negativo"),
      null,
      null,
      null,
      "Falta el precio de venta"
    ]);
    expect(rows[0]?.payload.priceCents).toBe(0);
    expect(rows[0]?.display.priceCents).toBe(0);
    expect(Object.is(rows[6]?.payload.priceCents, 0)).toBe(true); // "-0" is a plain zero, not a negative zero
  });

  it("enforces the engine's length limits", () => {
    const rows = run([["1", "x".repeat(121), "", "10"], ["y".repeat(51), "B", "", "10"]]).rows;
    expect(rows[0]?.invalidReason).toContain("120");
    expect(rows[1]?.invalidReason).toContain("50");
  });

  it("uppercases the code (the database stores SKUs upper-case) and uses it as the external id", () => {
    const row = run([["ab-12", "A", "", "10"]]).rows[0];
    expect(row?.externalId).toBe("AB-12");
    expect(row?.payload.sku).toBe("AB-12");
  });

  it("reads international-format files when told to", () => {
    const table = tableFromRecords([["c", "n", "b", "p"], ["1", "A", "", "1,234.50"]]);
    expect(mapCatalogRows(table, mapping, { numberFormat: "INTL", importStock: false }).rows[0]?.display.priceCents).toBe(123450);
    // The same text read as Argentine is rejected rather than misread as 1.234 pesos.
    expect(mapCatalogRows(table, mapping, AR_NO_STOCK).rows[0]?.invalidReason).toContain("Precio inválido");
  });
});

describe("tipo_venta (UNIT / WEIGHT)", () => {
  const mapping: CatalogColumnMapping = { code: 0, name: 1, barcode: null, category: null, saleType: 2, price: 3, cost: null, supplier: null, supplierCode: null, stock: null };
  const run = (rows: string[][], using: CatalogColumnMapping = mapping) => mapCatalogRows(tableFromRecords([["c", "n", "t", "p"], ...rows]), using, AR_NO_STOCK).rows;

  it("UNIT and WEIGHT become the product's forma de venta (no longer forced to UNIT)", () => {
    const rows = run([["1", "Coca", "UNIT", "10"], ["2", "Vacío", "WEIGHT", "20"]]);
    expect(rows.map((row) => row.payload.unitType)).toEqual(["UNIT", "WEIGHT"]);
    expect(rows.map((row) => row.display.saleType)).toEqual(["UNIT", "WEIGHT"]);
  });

  it("is case/space tolerant for the two valid values", () => {
    expect(run([["1", "A", " unit ", "10"], ["2", "B", "Weight", "10"]]).map((row) => row.payload.unitType)).toEqual(["UNIT", "WEIGHT"]);
  });

  it("any other value is a validation error (a kilo must never silently become a unit)", () => {
    const rows = run([["1", "A", "KG", "10"], ["2", "B", "UNIDAD", "10"], ["3", "C", "", "10"], ["4", "D", "0", "10"]]);
    expect(rows.map((row) => row.invalidReason)).toEqual([
      expect.stringContaining("Forma de venta inválida: “KG”"),
      expect.stringContaining("Forma de venta inválida: “UNIDAD”"),
      expect.stringContaining("Falta la forma de venta"),
      expect.stringContaining("Forma de venta inválida: “0”")
    ]);
  });

  it("with no tipo_venta column every product keeps the historical default (UNIT)", () => {
    const rows = run([["1", "A", "WEIGHT", "10"]], { ...mapping, saleType: null });
    expect(rows[0]?.payload.unitType).toBe("UNIT");
  });
});

describe("proveedor y proveedor_codigo", () => {
  const mapping: CatalogColumnMapping = { code: 0, name: 1, barcode: null, category: null, saleType: null, price: 2, cost: null, supplier: 3, supplierCode: 4, stock: null };
  const run = (rows: string[][], using: CatalogColumnMapping = mapping) => mapCatalogRows(tableFromRecords([["c", "n", "p", "prov", "provcod"], ...rows]), using, AR_NO_STOCK);

  it("a supplier name (and its code) travel in the payload, whitespace-normalized", () => {
    const row = run([["1", "A", "10", "  Coca-Cola   FEMSA ", "p-01"]]).rows[0];
    expect(row?.payload).toMatchObject({ supplierName: "Coca-Cola FEMSA", supplierCode: "P-01" });
    expect(row?.display).toMatchObject({ supplier: "Coca-Cola FEMSA", supplierCode: "P-01" });
  });

  it("an empty supplier imports the product normally, without one", () => {
    const row = run([["1", "A", "10", "", ""]]).rows[0];
    expect(row?.invalidReason).toBeNull();
    expect(row?.payload).not.toHaveProperty("supplierName");
    expect(row?.payload).not.toHaveProperty("supplierCode");
  });

  it("placeholders (-, sin proveedor, a code of 0) also mean no supplier", () => {
    const rows = run([["1", "A", "10", "-", "0"], ["2", "B", "10", "SIN PROVEEDOR", "000"], ["3", "C", "10", "n/a", ""]]).rows;
    for (const row of rows) {
      expect(row.invalidReason).toBeNull();
      expect(row.payload).not.toHaveProperty("supplierName");
      expect(row.payload).not.toHaveProperty("supplierCode");
    }
  });

  it("a supplier code without a name is sent as is (the database knows whether that code already exists)", () => {
    const row = run([["1", "A", "10", "", "P-9"]]).rows[0];
    expect(row?.invalidReason).toBeNull();
    expect(row?.payload).toMatchObject({ supplierCode: "P-9" });
    expect(row?.payload).not.toHaveProperty("supplierName");
  });

  it("works with only the name column (the code column is optional)", () => {
    const row = run([["1", "A", "10", "Distribuidora X", ""]], { ...mapping, supplierCode: null }).rows[0];
    expect(row?.payload).toMatchObject({ supplierName: "Distribuidora X" });
    expect(row?.payload).not.toHaveProperty("supplierCode");
  });

  it("lists each distinct supplier once, ignoring case/accents/spaces (the preview counts suppliers, not rows)", () => {
    const result = run([["1", "A", "10", "Distribuidora Peña", ""], ["2", "B", "10", "DISTRIBUIDORA  pena", ""], ["3", "C", "10", "Coca-Cola", "P1"]]);
    expect(result.suppliers).toEqual(["Distribuidora Peña", "Coca-Cola"]);
  });

  it("rejects an oversized supplier name or code with a readable cause", () => {
    const rows = run([["1", "A", "10", "x".repeat(121), ""], ["2", "B", "10", "ok", "y".repeat(61)]]).rows;
    expect(rows[0]?.invalidReason).toContain("nombre del proveedor supera los 120");
    expect(rows[1]?.invalidReason).toContain("código del proveedor supera los 60");
  });

  it("a rejected row does not contribute its supplier to the list", () => {
    expect(run([["1", "", "10", "Fantasma", ""]]).suppliers).toEqual([]);
  });
});

describe("the final SimplyGest CSV layout", () => {
  const headers = ["codigo", "barcode", "nombre", "categoria", "tipo_venta", "precio_venta", "costo", "proveedor", "proveedor_codigo"];

  it("is recognised column by column (proveedor_codigo is not taken for the code, tipo_venta not for the price)", () => {
    expect(suggestColumnMapping(headers)).toEqual({
      code: 0, barcode: 1, name: 2, category: 3, saleType: 4, price: 5, cost: 6, supplier: 7, supplierCode: 8, stock: null
    });
  });

  it("imports UNIT, WEIGHT, a zero price and suppliers end to end, with no stock column at all", () => {
    const table = tableFromRecords([
      headers,
      ["1001", "7790895000010", "Coca Cola 2.25 L", "Bebidas", "UNIT", "3500", "2500", "Coca-Cola FEMSA", "P1"],
      ["1002", "", "Vacío importado", "Carnes", "WEIGHT", "12000", "", "", ""],
      ["1003", "7791234000001", "GALLETITAS X", "Almacen", "UNIT", "0", "", "Distribuidora X", ""]
    ]);
    const result = mapCatalogRows(table, suggestColumnMapping(table.headers), { numberFormat: "AR", importStock: false });
    expect(result.invalidRows).toBe(0);
    expect(result.rows.map((row) => row.payload)).toEqual([
      { name: "Coca Cola 2.25 L", unitType: "UNIT", sku: "1001", barcodes: ["7790895000010"], categoryName: "Bebidas", priceCents: 350000, costCents: 250000, supplierName: "Coca-Cola FEMSA", supplierCode: "P1" },
      { name: "Vacío importado", unitType: "WEIGHT", sku: "1002", categoryName: "Carnes", priceCents: 1200000 },
      { name: "GALLETITAS X", unitType: "UNIT", sku: "1003", barcodes: ["7791234000001"], categoryName: "Almacen", priceCents: 0, supplierName: "Distribuidora X" }
    ]);
    expect(result.rows.every((row) => row.stockUnits === null)).toBe(true);
    expect(result.suppliers).toEqual(["Coca-Cola FEMSA", "Distribuidora X"]);
  });

  it("re-mapping the same file gives byte-identical payloads (the base's UNCHANGED detection depends on it)", () => {
    const table = tableFromRecords([headers, ["1001", "7790895000010", "Coca", "Bebidas", "UNIT", "3500", "2500", "Coca-Cola FEMSA", "P1"]]);
    const first = mapCatalogRows(table, suggestColumnMapping(table.headers), AR_NO_STOCK).rows;
    const second = mapCatalogRows(table, suggestColumnMapping(table.headers), AR_NO_STOCK).rows;
    expect(JSON.stringify(first.map((row) => row.payload))).toBe(JSON.stringify(second.map((row) => row.payload)));
  });
});

describe("large files", () => {
  it("splits a 1,500-row file into batches of at most 1,000 and keeps every row", () => {
    const table = parseCsvText(fixture("simplygest-large.csv"));
    const result = mapCatalogRows(table, suggestColumnMapping(table.headers), AR_WITH_STOCK);
    expect(result.totalRows).toBe(1500);
    const batches = chunkItems(result.rows, 1000);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 500]);
    expect(batches.flat().map((row) => row.rowNumber)).toEqual(table.rows.map((row) => row.rowNumber));
  });

  it("catches a barcode repeated ACROSS the batch boundary (rows 6 and 1306 of the file)", () => {
    const table = parseCsvText(fixture("simplygest-large.csv"));
    const result = mapCatalogRows(table, suggestColumnMapping(table.headers), AR_WITH_STOCK);
    const repeated = result.rows.find((row) => row.rowNumber === 1306);
    expect(repeated?.invalidReason).toContain("ya aparece en la fila 6");
    // 6 rows without price (every 250th) + the repeated barcode.
    expect(result.invalidRows).toBe(7);
  });

  it("chunkItems validates its size", () => {
    expect(() => chunkItems([1], 0)).toThrow(RangeError);
    expect(chunkItems([], 5)).toEqual([]);
  });
});
