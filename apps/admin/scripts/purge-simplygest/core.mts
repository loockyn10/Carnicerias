/**
 * Piezas puras del procedimiento de purga de productos importados sin stock (docs/IMPORTS.md "Purga de productos
 * importados sin stock"). Sin red ni archivos: se prueban en core.test.mts.
 */

export type PurgeVerdict = "DELETE" | "BLOCKED" | "SKIP";

/** Un candidato tal como lo clasifica la base (public.preview_import_product_purge). */
export interface PurgePreviewItem {
  ordinal: number;
  externalId: string;
  quantity: number | string;
  fileName: string | null;
  productId: string | null;
  productName: string | null;
  sku: string | null;
  active: boolean | null;
  verdict: PurgeVerdict;
  reasons: string[];
  catalogRefs: Record<string, number>;
}

export const REASON_LABELS: Record<string, string> = {
  NOT_LINKED: "El código no está vinculado a ningún producto (nunca se importó o ya se purgó)",
  PRODUCT_ALREADY_DELETED: "El vínculo existía pero el producto ya no está",
  NOT_CREATED_BY_IMPORT: "No lo creó la importación (producto anterior o adoptado): no se toca",
  LINKED_TO_OTHER_SOURCE: "También está vinculado a otro sistema de origen",
  ENABLED_IN_OTHER_BRANCH: "Está habilitado en otra sucursal además de Central",
  HAS_SALES: "Tiene ventas",
  HAS_STOCK_MOVEMENTS: "Tiene movimientos de stock",
  HAS_STOCK_OPERATIONS: "Tiene operaciones de stock (compras, mermas, ajustes)",
  HAS_STOCK_TRANSFERS: "Tiene transferencias de stock",
  HAS_PRODUCTION: "Participó de un desposte / producción",
  HAS_RESTOCK_EVENTS: "Tiene eventos de reposición",
  UNEXPECTED_REFERENCE: "Tiene una referencia inesperada en la base (no se borró nada)"
};

export function describeReasons(reasons: readonly string[]): string {
  return reasons.map((reason) => REASON_LABELS[reason] ?? reason).join("; ");
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

export interface PurgeSummary { total: number; delete: number; blocked: number; skipped: number }

export function summarize(items: readonly PurgePreviewItem[]): PurgeSummary {
  return {
    total: items.length,
    delete: items.filter((item) => item.verdict === "DELETE").length,
    blocked: items.filter((item) => item.verdict === "BLOCKED").length,
    skipped: items.filter((item) => item.verdict === "SKIP").length
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const VERDICT_LABELS: Record<PurgeVerdict, string> = { DELETE: "SE BORRARÍA", BLOCKED: "BLOQUEADO", SKIP: "SIN ACCIÓN" };

/** Reporte completo para revisar con calma (Excel): código, nombre del archivo, CANTIDAD original, producto en la base, resultado y motivo. */
export function reportCsv(items: readonly PurgePreviewItem[], outcome?: ReadonlyMap<string, string>): string {
  const header = ["codigo", "nombre_en_archivo", "cantidad_original", "producto_en_base", "sku", "resultado", "motivo", ...(outcome ? ["resultado_final"] : [])];
  const rows = items.map((item) => [
    item.externalId, item.fileName, item.quantity, item.productName, item.sku, VERDICT_LABELS[item.verdict], describeReasons(item.reasons),
    ...(outcome ? [outcome.get(item.externalId) ?? ""] : [])
  ].map(csvCell).join(","));
  return `﻿${[header.join(","), ...rows].join("\r\n")}\r\n`;
}

export interface PurgeArgs {
  command: "preview" | "apply";
  file: string;
  source: string;
  out: string | null;
  chunk: number;
  confirmCount: number | null;
  yesDeletePermanently: boolean;
  columns: { code?: string; name?: string; barcode?: string; price?: string; quantity?: string; saleType?: string };
}

export function parseArgs(argv: readonly string[]): PurgeArgs {
  const [command, ...rest] = argv;
  if (command !== "preview" && command !== "apply") throw new Error("Uso: purge-simplygest <preview|apply> --file <archivo> [opciones]");
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("--")) throw new Error(`Argumento inesperado: ${arg}`);
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); index += 1; } else flags.set(key, true);
  }
  const text = (key: string): string | undefined => { const value = flags.get(key); return typeof value === "string" ? value : undefined; };
  const file = text("file");
  if (!file) throw new Error("Falta --file <archivo de SimplyGest con la columna CANTIDAD>.");
  const chunk = text("chunk") ? Number(text("chunk")) : 500;
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > 1000) throw new Error("--chunk tiene que estar entre 1 y 1000.");
  const confirmCount = text("confirm-count") !== undefined ? Number(text("confirm-count")) : null;
  if (confirmCount !== null && (!Number.isInteger(confirmCount) || confirmCount < 0)) throw new Error("--confirm-count tiene que ser un entero >= 0.");
  const columns: PurgeArgs["columns"] = {};
  for (const [flag, field] of [["code-column", "code"], ["name-column", "name"], ["barcode-column", "barcode"], ["price-column", "price"], ["quantity-column", "quantity"], ["sale-type-column", "saleType"]] as const) {
    const value = text(flag);
    if (value) columns[field] = value;
  }
  return {
    command, file, source: text("source") ?? "simplygest", out: text("out") ?? null, chunk, confirmCount,
    yesDeletePermanently: flags.get("yes-delete-permanently") === true, columns
  };
}
