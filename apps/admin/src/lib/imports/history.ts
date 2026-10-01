/**
 * The history lists ONE line per logical import, not per database batch: a 3,000-row file is staged
 * as several batches that share `options.runId`. Batches created before the Admin screen existed
 * (no runId) are shown on their own line.
 */

export interface ImportBatchRecord {
  id: string;
  source_system: string;
  entity_type: string;
  file_name: string | null;
  status: string;
  options: unknown;
  preview_summary: unknown;
  applied_summary: unknown;
  created_at: string;
  applied_at: string | null;
}

export type ImportRunStatus = "APPLIED" | "PARTIAL" | "PENDING" | "CANCELLED";

export interface ImportRunSummary {
  key: string;
  createdAt: string;
  fileName: string;
  sourceSystem: string;
  sourceLabel: string;
  /** Rows of the file (product batches). */
  rows: number;
  created: number;
  updated: number;
  /** Rows the database (or the uploader) rejected. */
  errors: number;
  /** Opening-balance movements written, when the stock was imported. */
  stockLoaded: number | null;
  status: ImportRunStatus;
  batches: number;
}

const SOURCE_LABELS: Record<string, string> = { simplygest: "SimplyGest" };

export function importSourceLabel(sourceSystem: string): string {
  return SOURCE_LABELS[sourceSystem] ?? sourceSystem;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function count(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runKey(batch: ImportBatchRecord): string {
  const runId = asRecord(batch.options).runId;
  return typeof runId === "string" && runId !== "" ? runId : `batch:${batch.id}`;
}

export function groupImportRuns(batches: readonly ImportBatchRecord[]): ImportRunSummary[] {
  const groups = new Map<string, ImportBatchRecord[]>();
  for (const batch of batches) {
    const key = runKey(batch);
    const group = groups.get(key);
    if (group) group.push(batch);
    else groups.set(key, [batch]);
  }

  const runs: ImportRunSummary[] = [];
  for (const [key, group] of groups) {
    const products = group.filter((batch) => batch.entity_type === "product");
    const stock = group.filter((batch) => batch.entity_type === "stock_opening_balance");
    // Category-only batches (legacy) have no product rows; show them as the main line then.
    const main = products.length > 0 ? products : group.filter((batch) => batch.entity_type !== "stock_opening_balance");
    const lead = main[0] ?? group[0];
    if (!lead) continue;

    let rows = 0;
    let created = 0;
    let updated = 0;
    let errors = 0;
    for (const batch of main) {
      const preview = asRecord(batch.preview_summary);
      const applied = asRecord(batch.applied_summary);
      rows += count(preview, "totalRows");
      errors += count(preview, "error");
      created += count(applied, "created");
      updated += count(applied, "updated");
    }
    const appliedCount = main.filter((batch) => batch.status === "APPLIED").length;
    const cancelledCount = main.filter((batch) => batch.status === "CANCELLED").length;
    let status: ImportRunStatus = "PENDING";
    if (appliedCount === main.length) status = "APPLIED";
    else if (appliedCount > 0) status = "PARTIAL";
    else if (cancelledCount === main.length) status = "CANCELLED";

    const stockApplied = stock.filter((batch) => batch.status === "APPLIED");
    runs.push({
      key,
      createdAt: group.reduce((earliest, batch) => (batch.created_at < earliest ? batch.created_at : earliest), lead.created_at),
      fileName: lead.file_name ?? "(sin nombre)",
      sourceSystem: lead.source_system,
      sourceLabel: importSourceLabel(lead.source_system),
      rows,
      created,
      updated,
      errors,
      stockLoaded: stockApplied.length > 0 ? stockApplied.reduce((sum, batch) => sum + count(asRecord(batch.applied_summary), "created"), 0) : null,
      status,
      batches: main.length
    });
  }
  return runs.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
}
