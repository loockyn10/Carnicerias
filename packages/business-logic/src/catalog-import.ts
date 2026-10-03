/**
 * Pure helpers behind Admin → Importación de productos: turn a CSV/Excel table of ANY layout into
 * the canonical rows the import RPCs expect (docs/IMPORTS.md). Nothing here knows about React,
 * Supabase or the file format reader; the engine in Postgres stays the only judge of what is a
 * duplicate/new/update, this module only (a) maps columns, (b) parses numbers/codes safely and
 * (c) rejects rows that can never be valid so the preview can explain why.
 *
 * Money is integer cents. The sale form comes from the file (`UNIT` or `WEIGHT`); a file with no such
 * column keeps the historical default `UNIT`. A price of 0 is valid ("sin precio definido"); stock is
 * whole units and is NOT offered by the Admin screen (the SimplyGest stock is not trusted).
 */
import type { ImportProductPayload } from "@carnicerias/types";

// ---------------------------------------------------------------------------------------------
// Table model
// ---------------------------------------------------------------------------------------------

/** A spreadsheet cell: text from a CSV, or a typed value from an Excel file. */
export type CellValue = string | number | boolean | null;

export interface ImportTableRow {
  /** 1-based position in the source file (the header is usually 1), shown to the operator. */
  rowNumber: number;
  cells: CellValue[];
}

export interface ImportTable {
  headers: string[];
  rows: ImportTableRow[];
  /** Detected CSV delimiter (undefined for Excel). */
  delimiter?: string;
}

export const CATALOG_IMPORT_FIELDS = ["code", "name", "barcode", "category", "saleType", "price", "cost", "supplier", "supplierCode", "stock"] as const;
export type CatalogImportField = (typeof CATALOG_IMPORT_FIELDS)[number];
/** Column index per field, or null when the file has no such column (or the user unmapped it). */
export type CatalogColumnMapping = Record<CatalogImportField, number | null>;

/** AR: 1.234,56 · INTL: 1,234.56 */
export type NumberFormat = "AR" | "INTL";

export const CATALOG_FIELD_LABELS: Record<CatalogImportField, string> = {
  code: "Código / SKU",
  name: "Nombre",
  barcode: "Código de barras",
  category: "Categoría / familia",
  saleType: "Forma de venta (UNIT / WEIGHT)",
  price: "Precio de venta",
  cost: "Costo",
  supplier: "Proveedor",
  supplierCode: "Código del proveedor",
  stock: "Stock actual"
};

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/**
 * Same comparison key as the database (`app_private.import_normalize_text`): case, accents and
 * repeated spaces are ignored, so "Vacío  " and "vacio" collide here exactly as they do there.
 */
export function normalizeImportText(value: string): string {
  return value
    .trim()
    .replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, (character) => ACCENT_MAP[character] ?? character)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const ACCENT_MAP: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n",
  Á: "a", É: "e", Í: "i", Ó: "o", Ú: "u", Ü: "u", Ñ: "n"
};

/** Header comparison key: lower-case, accent-free, letters and digits only ("Cód. Barras" → "codbarras"). */
function headerKey(header: string): string {
  return normalizeImportText(header).replace(/[^a-z0-9]/g, "");
}

/**
 * CSV files exported from Windows systems are usually Windows-1252, not UTF-8. Decoding them as
 * UTF-8 silently turns "Vacío" into "Vac?o"; this tries UTF-8 strictly first and falls back.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

const CSV_DELIMITERS = [";", ",", "\t", "|"] as const;

/** Picks the delimiter that splits the first lines into the most (and most consistent) columns. */
export function detectCsvDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "").slice(0, 8);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of CSV_DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = first * consistent;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (const character of line) {
    if (character === '"') inQuotes = !inQuotes;
    else if (character === delimiter && !inQuotes) count += 1;
  }
  return count;
}

/** RFC 4180 records (quotes, doubled quotes, newlines inside quotes), delimiter auto-detected. */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  const flushField = () => { record.push(field); field = ""; };
  const flushRecord = () => { flushField(); records.push(record); record = []; };

  while (index < text.length) {
    const character = text[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === "") {
      inQuotes = true;
    } else if (character === delimiter) {
      flushField();
    } else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      flushRecord();
    } else if (character === "\n") {
      flushRecord();
    } else {
      field += character;
    }
    index += 1;
  }
  if (field !== "" || record.length > 0) flushRecord();
  return records;
}

function isBlankRecord(cells: readonly CellValue[]): boolean {
  return cells.every((cell) => cell === null || (typeof cell === "string" && cell.trim() === ""));
}

/** Builds the table from raw records: first non-empty record = headers; blank lines are skipped. */
export function tableFromRecords(records: readonly (readonly CellValue[])[], delimiter?: string): ImportTable {
  let headerIndex = records.findIndex((record) => !isBlankRecord(record));
  if (headerIndex < 0) return { headers: [], rows: [], ...(delimiter ? { delimiter } : {}) };
  const headerRecord = records[headerIndex] ?? [];
  const headers = headerRecord.map((cell, position) => {
    const label = cell === null ? "" : String(cell).trim();
    return label === "" ? `Columna ${String(position + 1)}` : label;
  });
  const rows: ImportTableRow[] = [];
  for (headerIndex += 1; headerIndex < records.length; headerIndex += 1) {
    const cells = records[headerIndex] ?? [];
    if (isBlankRecord(cells)) continue;
    rows.push({ rowNumber: headerIndex + 1, cells: [...cells] });
  }
  return { headers, rows, ...(delimiter ? { delimiter } : {}) };
}

export function parseCsvText(text: string): ImportTable {
  const delimiter = detectCsvDelimiter(text);
  return tableFromRecords(parseCsvRecords(text, delimiter), delimiter);
}

// ---------------------------------------------------------------------------------------------
// Column mapping suggestion
// ---------------------------------------------------------------------------------------------

/** Synonyms per field, most specific first. Compared against `headerKey`. */
const FIELD_SYNONYMS: Record<CatalogImportField, readonly string[]> = {
  code: ["codigo", "cod", "codigointerno", "codigoarticulo", "codarticulo", "codigoproducto", "codprod", "sku", "code", "referencia", "ref", "idarticulo", "idproducto", "id"],
  name: ["nombre", "descripcion", "descr", "desc", "descripcionarticulo", "nombreproducto", "producto", "detalle", "denominacion", "articulo"],
  barcode: ["codigodebarras", "codigobarras", "codigobarra", "codbarras", "codbarra", "barras", "barcode", "ean", "ean13", "gtin", "upc"],
  category: ["categoria", "familia", "rubro", "grupo", "linea", "seccion", "departamento", "subrubro", "subfamilia"],
  saleType: ["tipoventa", "tipodeventa", "formaventa", "formadeventa", "tipounidad", "unittype", "saletype"],
  price: ["precioventa", "preciodeventa", "precio", "pventa", "pvp", "preciolista", "precio1", "precioefectivo", "preciofinal", "venta"],
  cost: ["costo", "preciocosto", "preciodecosto", "costounitario", "costoactual", "ultimocosto", "costoreposicion", "pcosto", "preciocompra", "compra"],
  supplier: ["proveedor", "proveedorprincipal", "nombreproveedor", "supplier", "suppliername", "proveedorhabitual"],
  supplierCode: ["proveedorcodigo", "codigoproveedor", "codproveedor", "proveedorcod", "codprov", "idproveedor", "proveedorid", "suppliercode", "supplierid"],
  stock: ["stockactual", "stock", "existencia", "existencias", "saldo", "cantidad", "stk", "disponible"]
};

/**
 * Order matters: when two fields could claim the same column, the more specific one goes first
 * ("proveedor_codigo" contains "codigo" and "tipo_venta" contains "venta": the supplier code and the
 * sale type claim their columns before the generic code/price fields do).
 */
const SUGGESTION_ORDER: readonly CatalogImportField[] = ["saleType", "supplierCode", "supplier", "barcode", "cost", "price", "stock", "category", "code", "name"];

/**
 * Suggests a mapping by common header names. It is only a starting point — the operator reviews
 * and corrects it before anything is read. A column is never suggested for two fields.
 */
export function suggestColumnMapping(headers: readonly string[]): CatalogColumnMapping {
  const keys = headers.map(headerKey);
  const mapping: CatalogColumnMapping = { code: null, name: null, barcode: null, category: null, saleType: null, price: null, cost: null, supplier: null, supplierCode: null, stock: null };
  const used = new Set<number>();
  for (const field of SUGGESTION_ORDER) {
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    keys.forEach((key, index) => {
      if (used.has(index) || key === "") return;
      const synonyms = FIELD_SYNONYMS[field];
      const exact = synonyms.indexOf(key);
      const score = exact >= 0 ? exact : synonyms.some((synonym) => synonym.length >= 4 && key.includes(synonym)) ? 100 : -1;
      if (score >= 0 && score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      mapping[field] = bestIndex;
      used.add(bestIndex);
    }
  }
  return mapping;
}

/** Blocking problems of a mapping (shown before reading any row). Empty = ready. */
export function validateColumnMapping(mapping: CatalogColumnMapping): string[] {
  const problems: string[] = [];
  if (mapping.name === null) problems.push("Elegí la columna del nombre del producto.");
  if (mapping.price === null) problems.push("Elegí la columna del precio de venta.");
  if (mapping.code === null && mapping.barcode === null) {
    problems.push("Elegí al menos la columna de código/SKU o la de código de barras: sin un código estable no se puede evitar duplicar productos al volver a importar.");
  }
  const seen = new Map<number, CatalogImportField>();
  for (const field of CATALOG_IMPORT_FIELDS) {
    const column = mapping[field];
    if (column === null) continue;
    const other = seen.get(column);
    if (other) problems.push(`La misma columna está asignada a “${CATALOG_FIELD_LABELS[other]}” y a “${CATALOG_FIELD_LABELS[field]}”.`);
    else seen.set(column, field);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

interface Decimal {
  negative: boolean;
  integer: string;
  fraction: string;
}

const AR_PATTERN = /^([+-]?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/;
const INTL_PATTERN = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

function parseDecimal(cell: CellValue, format: NumberFormat): Decimal | "empty" | "invalid" {
  if (cell === null) return "empty";
  if (typeof cell === "boolean") return "invalid";
  if (typeof cell === "number") {
    if (!Number.isFinite(cell) || Math.abs(cell) >= 1e15) return "invalid";
    const match = /^(-?)(\d+)\.(\d+)$/.exec(cell.toFixed(6));
    return match ? { negative: match[1] === "-", integer: match[2] ?? "0", fraction: match[3] ?? "" } : "invalid";
  }
  const text = cell.replace(/[\s\u00a0]/g, "").replace(/^\$/, "");
  if (text === "") return "empty";
  const match = (format === "AR" ? AR_PATTERN : INTL_PATTERN).exec(text);
  if (!match) return "invalid";
  const integer = (match[2] ?? "0").replace(/[.,]/g, "");
  return { negative: match[1] === "-", integer, fraction: match[3] ?? "" };
}

function isZero(value: Decimal): boolean {
  return /^0*$/.test(value.integer) && /^0*$/.test(value.fraction);
}

/** Cents, half-up on the third decimal; null if it does not fit a safe integer. */
function decimalToCents(value: Decimal): number | null {
  const fraction = value.fraction.padEnd(3, "0");
  let cents = BigInt(value.integer) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const result = Number(cents);
  return value.negative ? -result : result;
}

/**
 * AR vs INTL from the values themselves: "1.234,56" / "12,5" ⇒ AR, "1,234.56" / "12.5" ⇒ INTL.
 * Ambiguous values (plain integers, "1.500") cast no vote; with no evidence the default is AR.
 */
export function detectNumberFormat(samples: readonly CellValue[]): NumberFormat {
  let argentine = 0;
  let international = 0;
  for (const sample of samples) {
    if (typeof sample !== "string") continue;
    const text = sample.replace(/[\s\u00a0$]/g, "");
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) argentine += 1; else international += 1;
    } else if (lastComma >= 0) {
      if (/,\d{1,2}$/.test(text) && text.indexOf(",") === lastComma) argentine += 1;
      else if (/,\d{3}$/.test(text) && text.indexOf(",") !== lastComma) international += 1;
    } else if (lastDot >= 0) {
      if (/\.\d{1,2}$/.test(text) && text.indexOf(".") === lastDot) international += 1;
      else if (/\.\d{3}$/.test(text) && text.indexOf(".") !== lastDot) argentine += 1;
    }
  }
  return international > argentine ? "INTL" : "AR";
}

/** Sample the numeric columns of the file to pre-select the number format. */
export function detectTableNumberFormat(table: ImportTable, mapping: CatalogColumnMapping, sampleSize = 400): NumberFormat {
  const columns = [mapping.price, mapping.cost, mapping.stock].filter((column): column is number => column !== null);
  const samples: CellValue[] = [];
  for (const row of table.rows.slice(0, sampleSize)) {
    for (const column of columns) samples.push(row.cells[column] ?? null);
  }
  return detectNumberFormat(samples);
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

export interface CatalogMappingOptions {
  numberFormat: NumberFormat;
  /** Validate and emit stock (opening balance). When false the stock column is ignored entirely. */
  importStock: boolean;
}

/** What the preview table shows for a row, valid or not. */
export interface CatalogRowDisplay {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  priceCents: number | null;
  costCents: number | null;
  stockUnits: number | null;
  /** UNIT / WEIGHT as read from the file (the default UNIT when the file has no such column). */
  saleType: "UNIT" | "WEIGHT" | null;
  supplier: string;
  supplierCode: string;
  /** Original text, so an invalid price/stock is shown as it came in the file. */
  priceText: string;
  costText: string;
  stockText: string;
}

export interface MappedCatalogRow {
  rowNumber: number;
  /** The source system's identifier; a synthetic `INVALID:<row>` for rejected rows. */
  externalId: string;
  payload: ImportProductPayload;
  /** Whole units for the opening balance (> 0), or null when there is no stock to load. */
  stockUnits: number | null;
  /** Why the client rejected the row; null = candidate for the server's own classification. */
  invalidReason: string | null;
  display: CatalogRowDisplay;
  /** The source row, header → text, for audit in import_rows.raw. */
  raw: Record<string, string>;
}

export interface CatalogMappingResult {
  rows: MappedCatalogRow[];
  totalRows: number;
  invalidRows: number;
  /** Distinct category names in the file (first spelling wins), for "N categorías nuevas". */
  categories: string[];
  /** Distinct supplier names in the file (first spelling wins), for "N proveedores". */
  suppliers: string[];
}

export const MAX_PRODUCT_NAME_LENGTH = 120;
export const MAX_SKU_LENGTH = 50;
export const MAX_CATEGORY_NAME_LENGTH = 100;

const BARCODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,63}$/;
const BARCODE_PLACEHOLDERS = new Set(["-", ".", "--", "n/a", "na", "s/c", "sc", "sin codigo", "sin barras", "sincodigo"]);
const CATEGORY_PLACEHOLDERS = new Set(["-", ".", "--", "n/a", "na", "sin categoria", "sin familia", "sin rubro", "sin grupo"]);
const SUPPLIER_PLACEHOLDERS = new Set(["-", ".", "--", "n/a", "na", "s/p", "sin proveedor", "sinproveedor"]);

export const MAX_SUPPLIER_NAME_LENGTH = 120;
export const MAX_SUPPLIER_CODE_LENGTH = 60;

function cellText(cell: CellValue | undefined): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "number" ? String(cell) : String(cell).trim();
}

/** Spreadsheet cells keep integer codes as numbers (7790895000123): print them without exponent. */
function codeText(cell: CellValue | undefined): string {
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return Number.isInteger(cell) && Math.abs(cell) < 1e21 ? BigInt(cell).toString() : String(cell);
  }
  return cellText(cell).replace(/\s+/g, " ");
}

function rawRecord(table: ImportTable, row: ImportTableRow): Record<string, string> {
  const record: Record<string, string> = {};
  table.headers.forEach((header, index) => { record[header] = cellText(row.cells[index]); });
  return record;
}

interface RowParse {
  invalid?: string;
  externalId?: string;
  payload?: ImportProductPayload;
  stockUnits?: number | null;
  display: CatalogRowDisplay;
}

function parseCatalogRow(row: ImportTableRow, mapping: CatalogColumnMapping, options: CatalogMappingOptions): RowParse {
  const at = (field: CatalogImportField): CellValue | undefined => {
    const column = mapping[field];
    return column === null ? undefined : row.cells[column];
  };
  const name = cellText(at("name")).replace(/\s+/g, " ");
  const codeRaw = codeText(at("code"));
  const barcodeRaw = codeText(at("barcode"));
  const categoryRaw = cellText(at("category")).replace(/\s+/g, " ");
  const display: CatalogRowDisplay = {
    name, sku: codeRaw.toUpperCase(), barcode: barcodeRaw, category: categoryRaw,
    priceCents: null, costCents: null, stockUnits: null, saleType: null, supplier: "", supplierCode: "",
    priceText: cellText(at("price")), costText: cellText(at("cost")), stockText: options.importStock ? cellText(at("stock")) : ""
  };
  const fail = (invalid: string): RowParse => ({ invalid, display });

  if (name === "") return fail("Falta el nombre del producto");
  if (name.length > MAX_PRODUCT_NAME_LENGTH) return fail(`El nombre supera los ${String(MAX_PRODUCT_NAME_LENGTH)} caracteres`);

  const sku = codeRaw.toUpperCase();
  if (sku.length > MAX_SKU_LENGTH) return fail(`El código/SKU supera los ${String(MAX_SKU_LENGTH)} caracteres`);

  // Barcode: spreadsheets mangle long numbers into scientific notation ("7,79E+12"); that is data
  // loss, not a barcode.
  let barcode = "";
  const barcodeCandidate = barcodeRaw.replace(/\s+/g, "").toUpperCase();
  if (barcodeCandidate !== "" && !BARCODE_PLACEHOLDERS.has(normalizeImportText(barcodeRaw)) && !/^0+$/.test(barcodeCandidate)) {
    if (/^\d+([.,]\d+)?E[+-]?\d+$/.test(barcodeCandidate)) {
      return fail(`El código de barras “${barcodeRaw}” está en notación científica (Excel lo cortó); exportá esa columna como texto`);
    }
    if (!BARCODE_PATTERN.test(barcodeCandidate)) {
      return fail(`Código de barras inválido: “${barcodeRaw}” (3 a 64 letras, números, punto, guion o guion bajo)`);
    }
    barcode = barcodeCandidate;
  }
  display.barcode = barcode;

  let externalId = "";
  if (sku !== "") externalId = sku;
  else if (barcode !== "") externalId = `BC:${barcode}`;
  else return fail("La fila no tiene código ni código de barras: sin uno de los dos no se puede identificar el producto (y evitar duplicarlo al reimportar)");
  if (externalId.length > 200) return fail("El código supera los 200 caracteres");

  // Forma de venta. With no mapped column every product keeps the historical default (UNIT); with
  // one, only UNIT or WEIGHT are valid (any other value would silently sell a kilo as a unit).
  let saleType: "UNIT" | "WEIGHT" = "UNIT";
  if (mapping.saleType !== null) {
    const rawSaleType = cellText(at("saleType")).toUpperCase();
    if (rawSaleType === "") return fail("Falta la forma de venta: tiene que ser UNIT o WEIGHT");
    if (rawSaleType !== "UNIT" && rawSaleType !== "WEIGHT") {
      return fail(`Forma de venta inválida: “${cellText(at("saleType"))}” (tiene que ser UNIT o WEIGHT)`);
    }
    saleType = rawSaleType;
  }
  display.saleType = saleType;

  const price = parseDecimal(at("price") ?? null, options.numberFormat);
  if (price === "empty") return fail("Falta el precio de venta");
  if (price === "invalid") return fail(`Precio inválido: “${display.priceText}”${options.numberFormat === "AR" ? " (se espera 1.234,56)" : " (se espera 1,234.56)"}`);
  const decimalCents = decimalToCents(price);
  // 0 is a valid price in SimplyGest ("sin precio definido": the Central cashier sets it at the
  // counter); only a negative one is wrong.
  if (decimalCents === null) return fail(`Precio fuera de rango: “${display.priceText}”`);
  if (decimalCents < 0) return fail(`El precio no puede ser negativo (llegó “${display.priceText}”)`);
  const priceCents = decimalCents === 0 ? 0 : decimalCents; // "-0" is a zero, not a negative zero
  display.priceCents = priceCents;

  let costCents: number | null = null;
  if (mapping.cost !== null) {
    const cost = parseDecimal(at("cost") ?? null, options.numberFormat);
    if (cost === "invalid") return fail(`Costo inválido: “${display.costText}”`);
    if (cost !== "empty" && !isZero(cost)) {
      if (cost.negative) return fail(`El costo no puede ser negativo (llegó “${display.costText}”)`);
      costCents = decimalToCents(cost);
      if (costCents === null) return fail(`Costo fuera de rango: “${display.costText}”`);
      if (costCents <= 0) costCents = null; // rounds to less than one cent: treated as "no cost"
    }
  }
  display.costCents = costCents;

  let category = "";
  if (categoryRaw !== "" && !CATEGORY_PLACEHOLDERS.has(normalizeImportText(categoryRaw))) {
    if (categoryRaw.length > MAX_CATEGORY_NAME_LENGTH) return fail(`El nombre de la categoría supera los ${String(MAX_CATEGORY_NAME_LENGTH)} caracteres`);
    category = categoryRaw;
  }
  display.category = category;

  let stockUnits: number | null = null;
  if (options.importStock && mapping.stock !== null) {
    const stock = parseDecimal(at("stock") ?? null, options.numberFormat);
    if (stock === "invalid") return fail(`Stock inválido: “${display.stockText}”`);
    if (stock !== "empty" && !isZero(stock)) {
      if (stock.negative) {
        return fail(`Stock negativo (${display.stockText}): el stock inicial no puede ser negativo. Corregí el archivo o desmarcá “Importar stock actual”`);
      }
      if (!/^0*$/.test(stock.fraction)) {
        return fail(`Stock fraccionado (${display.stockText}): los productos por unidad requieren un entero. Corregí el archivo o desmarcá “Importar stock actual”`);
      }
      const units = BigInt(stock.integer);
      if (units > BigInt(Number.MAX_SAFE_INTEGER)) return fail(`Stock fuera de rango: “${display.stockText}”`);
      stockUnits = Number(units);
    }
  }
  display.stockUnits = stockUnits;

  // Proveedor (opcional). Vacío o un marcador ("-", "sin proveedor") = el producto va sin proveedor.
  const supplierRaw = cellText(at("supplier")).replace(/\s+/g, " ");
  const supplierCodeRaw = codeText(at("supplierCode")).toUpperCase();
  const supplier = supplierRaw !== "" && !SUPPLIER_PLACEHOLDERS.has(normalizeImportText(supplierRaw)) ? supplierRaw : "";
  const supplierCode = supplierCodeRaw !== "" && !/^0+$/.test(supplierCodeRaw) && !SUPPLIER_PLACEHOLDERS.has(normalizeImportText(supplierCodeRaw)) ? supplierCodeRaw : "";
  if (supplier.length > MAX_SUPPLIER_NAME_LENGTH) return fail(`El nombre del proveedor supera los ${String(MAX_SUPPLIER_NAME_LENGTH)} caracteres`);
  if (supplierCode.length > MAX_SUPPLIER_CODE_LENGTH) return fail(`El código del proveedor supera los ${String(MAX_SUPPLIER_CODE_LENGTH)} caracteres`);
  display.supplier = supplier;
  display.supplierCode = supplierCode;

  const payload: ImportProductPayload = {
    name,
    unitType: saleType,
    priceCents,
    ...(sku !== "" ? { sku } : {}),
    ...(barcode !== "" ? { barcodes: [barcode] } : {}),
    ...(category !== "" ? { categoryName: category } : {}),
    ...(costCents !== null ? { costCents } : {}),
    ...(supplier !== "" ? { supplierName: supplier } : {}),
    ...(supplierCode !== "" ? { supplierCode } : {})
  };
  return { externalId, payload, stockUnits, display };
}

/**
 * Maps every data row. Rows that cannot be valid are NOT dropped: they are kept with
 * `invalidReason` and still staged (with a synthetic external id) so the database records the
 * whole file and the preview lists each one with its cause. Duplicates inside the file are
 * rejected here, for the whole file at once — the database only sees one batch (≤1000 rows) at a
 * time and could not catch a repeat across batches. First occurrence wins.
 */
export function mapCatalogRows(table: ImportTable, mapping: CatalogColumnMapping, options: CatalogMappingOptions): CatalogMappingResult {
  const rows: MappedCatalogRow[] = [];
  const firstByCode = new Map<string, number>();
  const firstByBarcode = new Map<string, number>();
  const firstByName = new Map<string, number>();
  const categories = new Map<string, string>();
  const suppliers = new Map<string, string>();
  let invalidRows = 0;

  for (const row of table.rows) {
    const parsed = parseCatalogRow(row, mapping, options);
    let invalid = parsed.invalid ?? null;
    const externalId = parsed.externalId ?? "";

    if (invalid === null && parsed.payload) {
      const barcode = parsed.payload.barcodes?.[0];
      const nameKey = normalizeImportText(parsed.payload.name);
      const sameCode = firstByCode.get(externalId);
      const sameBarcode = barcode ? firstByBarcode.get(barcode) : undefined;
      const sameName = firstByName.get(nameKey);
      if (sameCode !== undefined) invalid = `El código ${externalId.replace(/^BC:/, "")} ya aparece en la fila ${String(sameCode)} del archivo`;
      else if (sameBarcode !== undefined) invalid = `El código de barras ${barcode ?? ""} ya aparece en la fila ${String(sameBarcode)} del archivo`;
      else if (sameName !== undefined) invalid = `El nombre “${parsed.payload.name}” ya aparece en la fila ${String(sameName)} con otro código: no se crean dos productos iguales`;
      else {
        firstByCode.set(externalId, row.rowNumber);
        if (barcode) firstByBarcode.set(barcode, row.rowNumber);
        firstByName.set(nameKey, row.rowNumber);
        const category = parsed.payload.categoryName;
        if (category && !categories.has(normalizeImportText(category))) categories.set(normalizeImportText(category), category);
        const supplierName = parsed.payload.supplierName;
        if (supplierName && !suppliers.has(normalizeImportText(supplierName))) suppliers.set(normalizeImportText(supplierName), supplierName);
      }
    }

    if (invalid !== null) {
      invalidRows += 1;
      rows.push({
        rowNumber: row.rowNumber,
        externalId: `INVALID:${String(row.rowNumber)}`,
        payload: { name: parsed.display.name || "(sin nombre)", unitType: "UNIT", invalidReason: invalid },
        stockUnits: null,
        invalidReason: invalid,
        display: parsed.display,
        raw: rawRecord(table, row)
      });
    } else if (parsed.payload) {
      rows.push({
        rowNumber: row.rowNumber,
        externalId,
        payload: parsed.payload,
        stockUnits: parsed.stockUnits ?? null,
        invalidReason: null,
        display: parsed.display,
        raw: rawRecord(table, row)
      });
    }
  }
  return { rows, totalRows: table.rows.length, invalidRows, categories: [...categories.values()], suppliers: [...suppliers.values()] };
}

// ---------------------------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------------------------

/** Splits a list into consecutive slices of at most `size` (the engine caps a batch at 1000 rows). */
export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Limpieza de productos importados sin stock en el sistema de origen (purga controlada)
// ---------------------------------------------------------------------------------------------

/** What the original SimplyGest `CANTIDAD` of a row says (the ONLY source that decides a purge, never the Supabase ledger). */
export type SourceQuantityVerdict =
  | { kind: "NON_POSITIVE"; normalized: string }
  | { kind: "POSITIVE" }
  | { kind: "EMPTY" }
  | { kind: "UNREADABLE" };

/**
 * Sign of a source quantity cell. `0`, `-0`, `0,000` and any negative number are NON_POSITIVE (purge candidates);
 * anything > 0 is POSITIVE (never a candidate); an empty cell or text that is not a number is not evidence of
 * "no stock" and is never a candidate either. The sign/zero test gives the same answer for the Argentine and the
 * international number format, so no format needs to be guessed.
 */
export function classifySourceQuantity(cell: CellValue | undefined): SourceQuantityVerdict {
  if (cell === null || cell === undefined) return { kind: "EMPTY" };
  for (const format of ["AR", "INTL"] as const) {
    const parsed = parseDecimal(cell, format);
    if (parsed === "empty") return { kind: "EMPTY" };
    if (parsed === "invalid") continue;
    if (isZero(parsed)) return { kind: "NON_POSITIVE", normalized: "0" };
    if (parsed.negative) {
      const fraction = parsed.fraction.replace(/0+$/, "");
      return { kind: "NON_POSITIVE", normalized: `-${parsed.integer.replace(/^0+(?=\d)/, "")}${fraction === "" ? "" : `.${fraction}`}` };
    }
    return { kind: "POSITIVE" };
  }
  return { kind: "UNREADABLE" };
}

export interface PurgeCandidate {
  /** Row of the source file (for the operator's report). */
  rowNumber: number;
  /** The same external code the importer used (`external_entity_links.external_id`): SKU in capitals or `BC:<barcode>`. */
  externalId: string;
  /** Product name as written in the source file. */
  name: string;
  /** Original `CANTIDAD`, normalized (`0`, `-3`, `-1.5`); always <= 0. */
  quantity: string;
  /** The cell exactly as it came in the file. */
  quantityText: string;
}

export interface PurgeCandidateBuild {
  candidates: PurgeCandidate[];
  totalRows: number;
  /** Rows the importer itself rejected (no link exists for them), e.g. repeated code: only its FIRST row was ever imported. */
  notImportedRows: number;
  positiveRows: number;
  emptyQuantityRows: number;
  unreadableQuantityRows: number;
}

/**
 * Purge candidates from a SimplyGest extraction: the rows that WERE importable (same rules and same "first row wins"
 * deduplication as `mapCatalogRows`, so a repeated code can never make the purge look at the wrong occurrence) whose
 * original quantity column (`mapping.stock`) is zero or negative. Identification is by external code, never by name.
 */
export function buildPurgeCandidates(table: ImportTable, mapping: CatalogColumnMapping, options: { numberFormat: NumberFormat }): PurgeCandidateBuild {
  if (mapping.stock === null) throw new RangeError("Falta indicar la columna de cantidad (CANTIDAD) del archivo de origen.");
  const mapped = mapCatalogRows(table, mapping, { numberFormat: options.numberFormat, importStock: false });
  const cellsByRow = new Map(table.rows.map((row) => [row.rowNumber, row.cells]));
  const result: PurgeCandidateBuild = { candidates: [], totalRows: mapped.totalRows, notImportedRows: 0, positiveRows: 0, emptyQuantityRows: 0, unreadableQuantityRows: 0 };
  for (const row of mapped.rows) {
    if (row.invalidReason !== null) { result.notImportedRows += 1; continue; }
    const cell = cellsByRow.get(row.rowNumber)?.[mapping.stock];
    const verdict = classifySourceQuantity(cell);
    if (verdict.kind === "POSITIVE") { result.positiveRows += 1; continue; }
    if (verdict.kind === "EMPTY") { result.emptyQuantityRows += 1; continue; }
    if (verdict.kind === "UNREADABLE") { result.unreadableQuantityRows += 1; continue; }
    result.candidates.push({
      rowNumber: row.rowNumber, externalId: row.externalId, name: row.display.name,
      quantity: verdict.normalized, quantityText: cellText(cell)
    });
  }
  return result;
}
