/**
 * Orchestrates ONE logical import against the import RPCs (docs/IMPORTS.md). The database caps a
 * batch at 1,000 rows and applies each batch atomically, so a bigger file is staged as several
 * batches that share a `runId`; the operator still sees a single preview and a single confirmation.
 *
 * Transport-agnostic on purpose: `ImportGateway` is implemented by Server Actions in the app and by
 * a direct database connection in the validation harness, so the exact same sequencing is what gets
 * exercised against a real Postgres.
 */
import { chunkItems, type MappedCatalogRow } from "@carnicerias/business-logic";

export const IMPORT_SOURCE_SYSTEM = "simplygest";
/** The engine's per-batch cap (stage_import_rows / apply_import_batch). */
export const IMPORT_BATCH_ROWS = 1000;
/** Rows per staging call: keeps each request far below the platform's request-body limit. */
export const IMPORT_STAGE_CHUNK_ROWS = 250;

export type ImportRowAction = "CREATE" | "UPDATE" | "IGNORE" | "ERROR";
/** Keys an existing, not-yet-linked product may be adopted by (never by name). */
export type ImportLinkKey = "barcode" | "sku";

export interface ImportBatchTotals {
  totalRows: number;
  create: number;
  update: number;
  ignore: number;
  error: number;
}

/** Classification of one staged row, as decided by the database. */
export interface ImportServerRow {
  rowNumber: number;
  action: ImportRowAction | null;
  reasonCode: string | null;
  message: string | null;
  internalId: string | null;
}

export interface ImportStageRow {
  rowNumber: number;
  externalId: string;
  payload: Record<string, unknown>;
  raw?: Record<string, string>;
}

export interface CreateImportBatchInput {
  entityType: "product" | "stock_opening_balance";
  runId: string;
  fileName: string;
  fileSha256: string;
  linkBy: ImportLinkKey[];
}

export interface ImportApplyResult {
  created: number;
  updated: number;
  ignored: number;
  skippedErrors: number;
}

export interface ImportGateway {
  createBatch(input: CreateImportBatchInput): Promise<{ batchId: string }>;
  stageRows(batchId: string, rows: ImportStageRow[]): Promise<void>;
  previewBatch(batchId: string): Promise<{ summary: ImportBatchTotals; sameFileAlreadyApplied: boolean }>;
  listRows(batchId: string): Promise<ImportServerRow[]>;
  applyBatch(batchId: string, skipErrors: boolean): Promise<ImportApplyResult>;
  cancelBatch(batchId: string): Promise<void>;
}

export type ImportProgress = (message: string, done?: number, total?: number) => void;

export interface ImportRunMeta {
  runId: string;
  fileName: string;
  fileSha256: string;
  linkBy: ImportLinkKey[];
}

export interface PreviewedRow {
  row: MappedCatalogRow;
  action: ImportRowAction;
  reasonCode: string | null;
  message: string | null;
  /** The existing product an UPDATE/IGNORE refers to. */
  internalId: string | null;
}

export interface ImportPreviewTotals {
  total: number;
  create: number;
  update: number;
  ignore: number;
  error: number;
  /** UPDATE rows that adopt a product the import did not create (reason LINK_EXISTING). */
  linkedExisting: number;
  /** Rows that will try to load an opening stock, and the units they carry. */
  stockRows: number;
  stockUnits: number;
}

export interface ImportPreview {
  meta: ImportRunMeta;
  batches: { batchId: string; rowCount: number; totals: ImportBatchTotals }[];
  rows: PreviewedRow[];
  totals: ImportPreviewTotals;
  sameFileAlreadyApplied: boolean;
}

export interface ImportStockOutcome {
  requested: number;
  created: number;
  ignored: number;
  errors: { externalId: string; message: string }[];
  /** ignored/error rows by reason code (e.g. ALREADY_HAS_STOCK_HISTORY). */
  byReason: Record<string, number>;
}

export interface ImportApplyOutcome {
  products: ImportApplyResult;
  stock: ImportStockOutcome | null;
  batchesApplied: number;
}

/** A failure part-way through apply: `partial` says what was already written (nothing is rolled back across batches). */
export class ImportApplyError extends Error {
  readonly partial: ImportApplyOutcome;
  readonly stage: "products" | "stock";

  constructor(message: string, stage: "products" | "stock", partial: ImportApplyOutcome) {
    super(message);
    this.name = "ImportApplyError";
    this.stage = stage;
    this.partial = partial;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Error desconocido";
}

function toStageRow(row: MappedCatalogRow): ImportStageRow {
  return { rowNumber: row.rowNumber, externalId: row.externalId, payload: { ...row.payload }, raw: row.raw };
}

/** Counts the preview classification of every row. */
export function summarizePreviewRows(rows: readonly PreviewedRow[]): ImportPreviewTotals {
  const totals: ImportPreviewTotals = { total: rows.length, create: 0, update: 0, ignore: 0, error: 0, linkedExisting: 0, stockRows: 0, stockUnits: 0 };
  for (const entry of rows) {
    if (entry.action === "CREATE") totals.create += 1;
    else if (entry.action === "UPDATE") totals.update += 1;
    else if (entry.action === "IGNORE") totals.ignore += 1;
    else totals.error += 1;
    if (entry.action === "UPDATE" && entry.reasonCode === "LINK_EXISTING") totals.linkedExisting += 1;
    if (entry.action !== "ERROR" && entry.row.stockUnits !== null) {
      totals.stockRows += 1;
      totals.stockUnits += entry.row.stockUnits;
    }
  }
  return totals;
}

/**
 * Stages every row (rejected ones included: the database records the whole file and reports each
 * with its cause), previews each batch and merges the verdicts. Writes no business data.
 * On any failure the batches created so far are cancelled.
 */
export async function runPreview(
  gateway: ImportGateway,
  rows: readonly MappedCatalogRow[],
  meta: ImportRunMeta,
  onProgress: ImportProgress = () => undefined
): Promise<ImportPreview> {
  const created: string[] = [];
  const batches: ImportPreview["batches"] = [];
  const verdicts = new Map<number, ImportServerRow>();
  let sameFileAlreadyApplied = false;
  try {
    const slices = chunkItems(rows, IMPORT_BATCH_ROWS);
    for (const [sliceIndex, slice] of slices.entries()) {
      const label = slices.length > 1 ? ` (lote ${String(sliceIndex + 1)} de ${String(slices.length)})` : "";
      const { batchId } = await gateway.createBatch({
        entityType: "product", runId: meta.runId, fileName: meta.fileName, fileSha256: meta.fileSha256, linkBy: meta.linkBy
      });
      created.push(batchId);
      let staged = 0;
      for (const part of chunkItems(slice, IMPORT_STAGE_CHUNK_ROWS)) {
        await gateway.stageRows(batchId, part.map(toStageRow));
        staged += part.length;
        onProgress(`Enviando filas${label}`, staged, slice.length);
      }
      onProgress(`Analizando${label}`);
      const preview = await gateway.previewBatch(batchId);
      sameFileAlreadyApplied = sameFileAlreadyApplied || preview.sameFileAlreadyApplied;
      for (const verdict of await gateway.listRows(batchId)) verdicts.set(verdict.rowNumber, verdict);
      batches.push({ batchId, rowCount: slice.length, totals: preview.summary });
    }
  } catch (error) {
    await Promise.allSettled(created.map((batchId) => gateway.cancelBatch(batchId)));
    throw error;
  }

  const previewed: PreviewedRow[] = rows.map((row) => {
    const verdict = verdicts.get(row.rowNumber);
    return {
      row,
      action: verdict?.action ?? "ERROR",
      reasonCode: verdict?.reasonCode ?? (verdict ? null : "NO_VERDICT"),
      message: verdict?.message ?? (verdict ? null : "La base no devolvió resultado para esta fila"),
      internalId: verdict?.internalId ?? null
    };
  });
  return { meta, batches, rows: previewed, totals: summarizePreviewRows(previewed), sameFileAlreadyApplied };
}

/** Abandons an unconfirmed preview (nothing was written; the batches just stop being READY). */
export async function cancelPreview(gateway: ImportGateway, preview: ImportPreview): Promise<void> {
  await Promise.allSettled(preview.batches.map((batch) => gateway.cancelBatch(batch.batchId)));
}

export interface ApplyOptions {
  /** The operator accepted that rows with errors are left out. Required when the preview has errors. */
  skipErrors: boolean;
  /** Load the file's stock as OPENING_BALANCE into the destination branch, after the products. */
  importStock: boolean;
}

/**
 * Confirms a preview: applies every product batch in file order, then (optionally) loads the
 * opening stock as a second set of batches — stock needs the products to exist. Each batch is
 * atomic; the run as a whole is not, so a failure reports exactly what was already written and
 * re-running the same file continues from there (applied rows come back as "sin cambios").
 */
export async function runApply(
  gateway: ImportGateway,
  preview: ImportPreview,
  options: ApplyOptions,
  onProgress: ImportProgress = () => undefined
): Promise<ImportApplyOutcome> {
  if (preview.totals.error > 0 && !options.skipErrors) {
    throw new Error("El archivo tiene filas con error: corregilo o confirmá que se omitan");
  }
  const outcome: ImportApplyOutcome = {
    products: { created: 0, updated: 0, ignored: 0, skippedErrors: 0 }, stock: null, batchesApplied: 0
  };

  for (const [index, batch] of preview.batches.entries()) {
    onProgress(`Importando productos (lote ${String(index + 1)} de ${String(preview.batches.length)})`, index, preview.batches.length);
    try {
      const result = await gateway.applyBatch(batch.batchId, options.skipErrors && batch.totals.error > 0);
      outcome.products.created += result.created;
      outcome.products.updated += result.updated;
      outcome.products.ignored += result.ignored;
      outcome.products.skippedErrors += result.skippedErrors;
      outcome.batchesApplied += 1;
    } catch (error) {
      throw new ImportApplyError(describeError(error), "products", outcome);
    }
  }

  if (options.importStock) {
    try {
      outcome.stock = await applyStock(gateway, preview, onProgress);
    } catch (error) {
      throw new ImportApplyError(describeError(error), "stock", outcome);
    }
  }
  onProgress("Listo", preview.batches.length, preview.batches.length);
  return outcome;
}

async function applyStock(gateway: ImportGateway, preview: ImportPreview, onProgress: ImportProgress): Promise<ImportStockOutcome> {
  const candidates = preview.rows.filter((entry) => entry.action !== "ERROR" && entry.row.stockUnits !== null);
  const result: ImportStockOutcome = { requested: candidates.length, created: 0, ignored: 0, errors: [], byReason: {} };
  const slices = chunkItems(candidates, IMPORT_BATCH_ROWS);
  for (const [index, slice] of slices.entries()) {
    const label = slices.length > 1 ? ` (lote ${String(index + 1)} de ${String(slices.length)})` : "";
    onProgress(`Cargando stock inicial${label}`, index, slices.length);
    const { batchId } = await gateway.createBatch({
      entityType: "stock_opening_balance", runId: preview.meta.runId, fileName: preview.meta.fileName,
      fileSha256: preview.meta.fileSha256, linkBy: []
    });
    try {
      for (const part of chunkItems(slice, IMPORT_STAGE_CHUNK_ROWS)) {
        await gateway.stageRows(batchId, part.map((entry) => ({
          rowNumber: entry.row.rowNumber,
          externalId: entry.row.externalId,
          payload: { quantityUnits: entry.row.stockUnits }
        })));
      }
      await gateway.previewBatch(batchId);
      const verdicts = await gateway.listRows(batchId);
      const byRow = new Map(slice.map((entry) => [entry.row.rowNumber, entry.row.externalId]));
      for (const verdict of verdicts) {
        if (verdict.action === "ERROR") {
          result.errors.push({ externalId: byRow.get(verdict.rowNumber) ?? String(verdict.rowNumber), message: verdict.message ?? verdict.reasonCode ?? "Error" });
        }
        if ((verdict.action === "ERROR" || verdict.action === "IGNORE") && verdict.reasonCode) {
          result.byReason[verdict.reasonCode] = (result.byReason[verdict.reasonCode] ?? 0) + 1;
        }
        if (verdict.action === "IGNORE") result.ignored += 1;
      }
      // Stock errors never undo the products already imported: they are reported, and left out.
      const applied = await gateway.applyBatch(batchId, true);
      result.created += applied.created;
    } catch (error) {
      await gateway.cancelBatch(batchId).catch(() => undefined);
      throw error;
    }
  }
  return result;
}
