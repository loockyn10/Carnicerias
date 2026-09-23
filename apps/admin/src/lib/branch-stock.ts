import { stockPriority, type StockPriority } from "./multibranch";
import { normalizeSearchText } from "./text-search";

export type BranchStockUnit = "WEIGHT" | "UNIT";

/**
 * One row of `get_replenishment_plan` (or any source with the same shape).
 * `currentQuantity`/`minimumQuantity` are already the aggregated ledger values —
 * this module never touches stock_movements directly, it only reshapes an
 * already-aggregated plan into a product x branch matrix.
 */
export interface BranchStockPlanEntry {
  branchId: string;
  productId: string;
  productName: string;
  unitType: BranchStockUnit;
  currentQuantity: number;
  minimumQuantity: number;
}

export interface BranchStockProductMeta {
  sku: string | null;
  categoryId: string | null;
}

export interface BranchStockCell {
  current: number;
  label: StockPriority;
  rank: number;
}

export interface BranchStockRow {
  productId: string;
  productName: string;
  sku: string | null;
  categoryId: string | null;
  unitType: BranchStockUnit;
  cells: Record<string, BranchStockCell>;
}

/** Groups per-branch plan entries into one row per product, keyed by branch id. */
export function buildBranchStockRows(
  entries: readonly BranchStockPlanEntry[],
  productMeta: ReadonlyMap<string, BranchStockProductMeta>
): BranchStockRow[] {
  const rowsByProduct = new Map<string, BranchStockRow>();
  for (const entry of entries) {
    let row = rowsByProduct.get(entry.productId);
    if (!row) {
      const meta = productMeta.get(entry.productId);
      row = {
        productId: entry.productId,
        productName: entry.productName,
        sku: meta?.sku ?? null,
        categoryId: meta?.categoryId ?? null,
        unitType: entry.unitType,
        cells: {}
      };
      rowsByProduct.set(entry.productId, row);
    }
    const priority = stockPriority(null, entry.currentQuantity, entry.minimumQuantity);
    row.cells[entry.branchId] = { current: entry.currentQuantity, label: priority.label, rank: priority.rank };
  }
  return [...rowsByProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName, "es"));
}

/** Alias kept for existing imports; normalizeSearchText in "./text-search" is the canonical
 * export shared by every Admin search box (Stock por sucursal, Precios, Promociones). */
export const normalizeStockSearch = normalizeSearchText;

/** Filters rows by free-text (name or SKU) and an optional category id. */
export function filterBranchStockRows(
  rows: readonly BranchStockRow[],
  { search, categoryId }: { search: string; categoryId: string }
): BranchStockRow[] {
  const normalizedSearch = normalizeStockSearch(search);
  return rows.filter((row) => {
    if (categoryId && row.categoryId !== categoryId) return false;
    if (!normalizedSearch) return true;
    const haystack = normalizeStockSearch(`${row.productName} ${row.sku ?? ""}`);
    return haystack.includes(normalizedSearch);
  });
}
