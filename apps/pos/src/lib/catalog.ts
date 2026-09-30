export interface CatalogProductLike {
  categoryIds: string[];
}

export interface CategoryDirectoryEntryLike {
  id: string;
  name: string;
  colorHex: string | null;
  sortOrder: number;
}

export interface CategoryTab {
  id: string;
  name: string;
  color: string | null;
  order: number;
}

/**
 * Category tabs come from the explicit category DIRECTORY synced from the server (every active
 * category with at least one product assignment, principal or "también aparece en" — see
 * pull_pos_state/get_pos_catalog's "categories" field and get_pos_categories), NOT from any
 * product's principal category. A category used only as a secondary assignment on every product
 * that has it still gets a tab; a category with zero assignments never does.
 */
export function buildCategoryTabs(directory: readonly CategoryDirectoryEntryLike[]): CategoryTab[] {
  return [...directory]
    .map((entry) => ({ id: entry.id, name: entry.name, color: entry.colorHex, order: entry.sortOrder }))
    .sort((left, right) => left.order - right.order);
}

/**
 * A product matches a category tab if it's assigned to that category at all — principal or
 * additional ("también aparece en"). "ALL" always matches. This is the only place a product's
 * multi-category membership is checked; "Todos" bypasses it entirely (iterates the full catalog
 * once, never per-category), so a multi-category product is never shown twice there.
 */
export function productMatchesCategory(product: Pick<CatalogProductLike, "categoryIds">, categoryId: string): boolean {
  return categoryId === "ALL" || product.categoryIds.includes(categoryId);
}

/**
 * Stock of the device's branch keyed by productId, in the ledger's own unit (grams for WEIGHT,
 * units for UNIT) — the REAL signed value, never rounded to kg for display. `null` means stock
 * was never synced on this device (fresh upgrade / offline first start): availability is then
 * unknown, so nothing is disabled (the pre-stock behavior) instead of everything reading as zero.
 */
export type BranchStock = ReadonlyMap<string, number> | null;

/** Sellable only with strictly positive real stock: 0, negative and "no movements" are all sin stock;
 * 1 g (0.001 kg) already counts as available. With no snapshot at all, everything stays sellable. */
export function hasStock(stock: BranchStock, productId: string): boolean {
  if (stock === null) return true;
  return (stock.get(productId) ?? 0) > 0;
}

/** Splits products into sellable-first groups, preserving the incoming (category, name) order inside each. */
export function partitionByStock<T extends { productId: string }>(
  products: readonly T[],
  stock: BranchStock
): { available: T[]; outOfStock: T[] } {
  const available: T[] = [];
  const outOfStock: T[] = [];
  for (const product of products) (hasStock(stock, product.productId) ? available : outOfStock).push(product);
  return { available, outOfStock };
}
