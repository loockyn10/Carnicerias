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

/**
 * The stock the POS gates availability on. Central (almacén + carnicería) does NOT keep reliable
 * stock — SimplyGest's was never trusted, and many products show 0 while physically on the shelf — so
 * there availability never depends on it: every product enabled in the branch assortment is visible and
 * sellable (search, scan and manual sale alike), and selling at stock 0 simply leaves the ledger at -1.
 * Every other branch (Avenida, Janssen) keeps the gate: sin stock = gray, collapsed and not sellable.
 * `true` for `centralPos` comes from the server capability of the device (production branch), never
 * from a hardcoded branch name. `null` is the same "stock unknown, block nothing" the helpers above
 * already understand, so every call site keeps working unchanged.
 */
export function stockForAvailability(stock: BranchStock, centralPos: boolean): BranchStock {
  return centralPos ? null : stock;
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

// ---------------------------------------------------------------------------------------------
// Barcode scan -> product resolution (LOCAL, offline: only the synced catalog and the synced stock
// snapshot are read; there is never a server call per scan). The catalog handed in here is the
// device branch catalog, i.e. it ALREADY contains only the products enabled in this branch
// (surtido): a product not enabled here is indistinguishable from an unknown one, by design.
// ---------------------------------------------------------------------------------------------

/** Same normalization the server applies to stored barcodes (trim, drop whitespace, upper-case). */
export function normalizeBarcode(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, "").toUpperCase();
  return normalized === "" ? null : normalized;
}

export interface BarcodeProductLike {
  productId: string;
  unitType: "WEIGHT" | "UNIT";
  barcodes: readonly string[];
}

/** barcode -> product for the whole branch catalog (one pass; O(1) per scan afterwards). */
export function buildBarcodeIndex<T extends BarcodeProductLike>(products: readonly T[]): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const product of products) {
    for (const barcode of product.barcodes) {
      const normalized = normalizeBarcode(barcode);
      if (normalized) index.set(normalized, product);
    }
  }
  return index;
}

export type ScanOutcome<T> =
  /** No product of this branch has that code. */
  | { kind: "NOT_FOUND"; code: string }
  /** Enabled here but the branch stock is <= 0: shown as "Sin stock", never added. Never returned
   * for Central: pass `stockForAvailability(stock, true)` (= null) and nothing is gated by stock. */
  | { kind: "NO_STOCK"; product: T }
  /** UNIT product: each scan adds exactly one unit. */
  | { kind: "ADD_UNIT"; product: T }
  /** WEIGHT product: keep the existing weigh flow (open the weight dialog); a scan never turns a
   * weighed product into a per-unit sale. */
  | { kind: "OPEN_WEIGHT"; product: T };

/**
 * `null` for an empty/blank code (nothing to resolve, not even an error). `stock` is what availability
 * is gated on — already passed through `stockForAvailability`, so Central never gets NO_STOCK.
 */
export function resolveScan<T extends BarcodeProductLike>(
  index: ReadonlyMap<string, T>,
  stock: BranchStock,
  rawCode: string
): ScanOutcome<T> | null {
  const code = normalizeBarcode(rawCode);
  if (code === null) return null;
  const product = index.get(code);
  if (!product) return { kind: "NOT_FOUND", code };
  if (!hasStock(stock, product.productId)) return { kind: "NO_STOCK", product };
  return product.unitType === "UNIT" ? { kind: "ADD_UNIT", product } : { kind: "OPEN_WEIGHT", product };
}
