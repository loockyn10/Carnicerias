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
