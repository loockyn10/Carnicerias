import { decodeCsvBytes, parseCsvText, tableFromRecords, type CellValue, type ImportTable } from "@carnicerias/business-logic";

/**
 * Reads the file the operator picked, in the browser (nothing is uploaded until the preview).
 * Supported: CSV/TXT/TSV (any delimiter, UTF-8 or Windows-1252) and Excel `.xlsx`.
 * Legacy `.xls` (Excel 97-2003) is a binary format that needs a heavy dependency to read; the
 * operator is asked to save it as `.xlsx` or CSV instead.
 */
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_FILE_ROWS = 20_000;

export interface LoadedImportFile {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  format: "csv" | "xlsx";
  table: ImportTable;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

export async function loadImportFile(file: File): Promise<LoadedImportFile> {
  if (file.size === 0) throw new Error("El archivo está vacío.");
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error("El archivo supera los 25 MB.");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = await sha256Hex(buffer);
  const lowerName = file.name.toLowerCase();

  const isZip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  const isLegacyExcel = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]);
  if (isLegacyExcel || lowerName.endsWith(".xls")) {
    throw new Error("Los archivos .xls (Excel 97-2003) no se pueden leer. Abrilo en Excel y guardalo como “Libro de Excel (.xlsx)” o como CSV.");
  }

  let table: ImportTable;
  let format: LoadedImportFile["format"];
  if (isZip || lowerName.endsWith(".xlsx")) {
    if (!isZip) throw new Error("El archivo .xlsx está dañado o no es un libro de Excel válido.");
    format = "xlsx";
    // Single-threaded variant: the worker-based export does not play well with the Next bundler.
    const { readSheet } = await import("read-excel-file/universal");
    let sheet;
    try {
      sheet = await readSheet(buffer, 1);
    } catch {
      throw new Error("No se pudo leer el libro de Excel. Probá guardarlo de nuevo como .xlsx o exportarlo a CSV.");
    }
    table = tableFromRecords(sheet.map((row) => row.map(toCell)));
  } else {
    format = "csv";
    table = parseCsvText(decodeCsvBytes(bytes));
  }

  if (table.headers.length === 0 || table.rows.length === 0) throw new Error("El archivo no tiene filas de datos debajo de los encabezados.");
  if (table.rows.length > MAX_IMPORT_FILE_ROWS) throw new Error(`El archivo tiene ${String(table.rows.length)} filas; el máximo por importación es ${String(MAX_IMPORT_FILE_ROWS)}.`);
  return { fileName: file.name, sizeBytes: file.size, sha256, format, table };
}
