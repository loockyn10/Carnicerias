"use server";

import type { Json } from "@carnicerias/database";

import { requireAdminContext } from "../../../lib/admin";
import { fetchAllRows } from "../../../lib/fetch-all";
import { pickDefaultCategory, resolveImportDestination } from "../../../lib/imports/destination";
import {
  IMPORT_BATCH_ROWS,
  IMPORT_SOURCE_SYSTEM,
  type CreateImportBatchInput,
  type ImportApplyResult,
  type ImportBatchTotals,
  type ImportRowAction,
  type ImportServerRow,
  type ImportStageRow,
  type PreviewSupplier
} from "../../../lib/imports/runner";
import { createClient } from "../../../lib/supabase/server";

/**
 * Server Actions behind /admin/imports. Every one re-checks that the caller is an Admin and runs
 * under the caller's own session (RLS + the RPCs' `imports.*` permission); nothing here uses a
 * service key. Errors are RETURNED, not thrown: production Next.js redacts the message of a thrown
 * Server Action error, and the operator needs the real cause ("El SKU … ya pertenece a …").
 *
 * The destination branch is decided HERE (Central), never taken from the browser.
 */
export type ImportActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const ROW_ACTIONS: readonly string[] = ["CREATE", "UPDATE", "IGNORE", "ERROR"];

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : "No se pudo completar la operación" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} inválido`);
  return value;
}

export async function createImportBatchAction(input: CreateImportBatchInput): Promise<ImportActionResult<{ batchId: string }>> {
  try {
    const context = await requireAdminContext();
    // The arguments come from the browser: validate them again, whatever their static type says.
    const entityType: string = input.entityType;
    if (entityType !== "product" && entityType !== "stock_opening_balance") throw new Error("Tipo de importación no soportado");
    const runId = requireUuid(input.runId, "El identificador de la importación");
    if (typeof input.fileName !== "string" || input.fileName.trim() === "" || input.fileName.length > 255) throw new Error("Nombre de archivo inválido");
    if (typeof input.fileSha256 !== "string" || !SHA256.test(input.fileSha256)) throw new Error("Huella del archivo inválida");
    const requestedLinks: unknown = input.linkBy;
    const linkBy = Array.isArray(requestedLinks) ? requestedLinks.filter((key) => key === "barcode" || key === "sku") : [];

    const supabase = await createClient();
    const [branchesResult, organizationResult] = await Promise.all([
      supabase.from("branches").select("id, name, code, active").eq("organization_id", context.organizationId),
      supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single()
    ]);
    if (branchesResult.error) throw new Error(branchesResult.error.message);
    if (organizationResult.error) throw new Error(organizationResult.error.message);
    const destination = resolveImportDestination(branchesResult.data, organizationResult.data.production_branch_id);
    if (destination.kind === "missing") throw new Error(destination.reason);

    const options: Record<string, Json> = { runId };
    if (input.entityType === "product") {
      const categoriesResult = await supabase.from("categories").select("id, name, active").eq("organization_id", context.organizationId);
      if (categoriesResult.error) throw new Error(categoriesResult.error.message);
      const almacen = pickDefaultCategory(categoriesResult.data);
      if (!almacen) throw new Error("No existe la categoría “Almacen”, que es la que reciben los productos sin categoría. Creala en Productos antes de importar.");
      options.defaultCategoryId = almacen.id;
      options.createMissingCategories = true;
      options.linkExistingBy = linkBy;
    }

    const { data, error } = await supabase.rpc("create_import_batch", {
      p_source_system: IMPORT_SOURCE_SYSTEM,
      p_entity_type: input.entityType,
      p_file_name: input.fileName.trim(),
      p_file_sha256: input.fileSha256.toLowerCase(),
      p_branch_id: destination.branch.id,
      p_options: options
    });
    if (error) throw new Error(error.message);
    return { ok: true, data: { batchId: data } };
  } catch (error) {
    return failure(error);
  }
}

export async function stageImportRowsAction(batchId: string, rows: ImportStageRow[]): Promise<ImportActionResult<{ staged: number }>> {
  try {
    await requireAdminContext();
    requireUuid(batchId, "Lote");
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > IMPORT_BATCH_ROWS) throw new Error("Cantidad de filas inválida");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("stage_import_rows", { p_batch_id: batchId, p_rows: rows as unknown as Json });
    if (error) throw new Error(error.message);
    return { ok: true, data: { staged: num(asRecord(data).staged) } };
  } catch (error) {
    return failure(error);
  }
}

export async function previewImportBatchAction(batchId: string): Promise<ImportActionResult<{ summary: ImportBatchTotals; sameFileAlreadyApplied: boolean }>> {
  try {
    await requireAdminContext();
    requireUuid(batchId, "Lote");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("preview_import_batch", { p_batch_id: batchId });
    if (error) throw new Error(error.message);
    const batch = asRecord(data);
    const summary = asRecord(batch.summary);
    return {
      ok: true,
      data: {
        summary: { totalRows: num(summary.totalRows), create: num(summary.create), update: num(summary.update), ignore: num(summary.ignore), error: num(summary.error) },
        sameFileAlreadyApplied: batch.sameFileAlreadyApplied === true
      }
    };
  } catch (error) {
    return failure(error);
  }
}

export async function listImportRowsAction(batchId: string): Promise<ImportActionResult<ImportServerRow[]>> {
  try {
    const context = await requireAdminContext();
    requireUuid(batchId, "Lote");
    const supabase = await createClient();
    const { data, error } = await fetchAllRows((from, to) =>
      supabase
        .from("import_rows")
        .select("row_number, action, reason_code, message, internal_id")
        .eq("batch_id", batchId)
        .eq("organization_id", context.organizationId)
        .order("row_number", { ascending: true })
        .range(from, to)
    );
    if (error) throw new Error(error.message);
    return {
      ok: true,
      data: data.map((row) => ({
        rowNumber: row.row_number,
        action: row.action !== null && ROW_ACTIONS.includes(row.action) ? (row.action as ImportRowAction) : null,
        reasonCode: row.reason_code,
        message: row.message,
        internalId: row.internal_id
      }))
    };
  } catch (error) {
    return failure(error);
  }
}

/** Suppliers a previewed batch would create (supplierId null) or reuse. Read-only. */
export async function listImportSuppliersAction(batchId: string): Promise<ImportActionResult<PreviewSupplier[]>> {
  try {
    await requireAdminContext();
    requireUuid(batchId, "Lote");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_import_batch_suppliers", { p_batch_id: batchId });
    if (error) throw new Error(error.message);
    const entries = Array.isArray(data) ? data : [];
    return {
      ok: true,
      data: entries.map((raw) => {
        const entry = asRecord(raw);
        return {
          key: typeof entry.key === "string" ? entry.key : "",
          supplierId: typeof entry.supplierId === "string" ? entry.supplierId : null,
          name: typeof entry.name === "string" ? entry.name : "",
          code: typeof entry.code === "string" ? entry.code : null,
          rows: num(entry.rows)
        };
      })
    };
  } catch (error) {
    return failure(error);
  }
}

export async function applyImportBatchAction(batchId: string, skipErrors: boolean): Promise<ImportActionResult<ImportApplyResult>> {
  try {
    await requireAdminContext();
    requireUuid(batchId, "Lote");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("apply_import_batch", { p_batch_id: batchId, p_skip_errors: skipErrors });
    if (error) throw new Error(error.message);
    let result = asRecord(asRecord(data).result);
    if (Object.keys(result).length === 0) {
      // A retry of an already-applied batch returns no `result`; read the stored one.
      const stored = await supabase.from("import_batches").select("applied_summary").eq("id", batchId).single();
      result = asRecord(stored.data?.applied_summary);
    }
    return { ok: true, data: { created: num(result.created), updated: num(result.updated), ignored: num(result.ignored), skippedErrors: num(result.skippedErrors) } };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelImportBatchAction(batchId: string): Promise<ImportActionResult<{ cancelled: true }>> {
  try {
    await requireAdminContext();
    requireUuid(batchId, "Lote");
    const supabase = await createClient();
    const { error } = await supabase.rpc("cancel_import_batch", { p_batch_id: batchId });
    if (error) throw new Error(error.message);
    return { ok: true, data: { cancelled: true } };
  } catch (error) {
    return failure(error);
  }
}

/** productId → [current global price in cents or null, current cost in cents or null] */
export type CurrentCommercialValues = Record<string, [number | null, number | null]>;

/**
 * Current global price and cost of the products a preview refers to, so the table can show
 * "$4.500 → $4.800" on an update (and flag a manual price the file would not touch).
 * Reads whole current-price tables page by page: one pass regardless of how many rows the file has.
 */
export async function loadCurrentCommercialValuesAction(productIds: string[]): Promise<ImportActionResult<CurrentCommercialValues>> {
  try {
    const context = await requireAdminContext();
    const wanted = new Set(productIds.filter((id) => UUID.test(id)));
    const values: CurrentCommercialValues = {};
    if (wanted.size === 0) return { ok: true, data: values };
    const supabase = await createClient();

    const [prices, costs] = await Promise.all([
      fetchAllRows((from, to) =>
        supabase.from("product_prices").select("product_id, price_cents")
          .eq("organization_id", context.organizationId).is("branch_id", null).is("valid_to", null)
          .order("product_id", { ascending: true }).range(from, to)
      ),
      fetchAllRows((from, to) =>
        supabase.from("product_costs").select("product_id, cost_cents")
          .eq("organization_id", context.organizationId).is("valid_to", null)
          .order("product_id", { ascending: true }).range(from, to)
      )
    ]);
    if (prices.error) throw new Error(prices.error.message);
    if (costs.error) throw new Error(costs.error.message);
    for (const row of prices.data) if (wanted.has(row.product_id)) values[row.product_id] = [row.price_cents, values[row.product_id]?.[1] ?? null];
    for (const row of costs.data) if (wanted.has(row.product_id)) values[row.product_id] = [values[row.product_id]?.[0] ?? null, row.cost_cents];
    return { ok: true, data: values };
  } catch (error) {
    return failure(error);
  }
}
