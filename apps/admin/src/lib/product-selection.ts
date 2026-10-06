/** Tope por llamada de `deactivate_products` (el servidor lo vuelve a validar). */
export const MAX_BULK_DEACTIVATE = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids únicos y válidos, o null si la entrada no sirve (vacía, con basura, o sobre el tope). */
export function normalizeProductIds(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  if (!input.every((id): id is string => typeof id === "string" && UUID.test(id))) return null;
  const unique = [...new Set(input.map((id) => id.toLowerCase()))];
  return unique.length >= 1 && unique.length <= MAX_BULK_DEACTIVATE ? unique : null;
}

/** Marca o desmarca un producto (devuelve un Set nuevo). */
export function toggleSelected(selected: ReadonlySet<string>, productId: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(productId)) next.add(productId);
  return next;
}

/** El checkbox del encabezado: si ya están todos los seleccionables marcados los desmarca, si no los marca todos. */
export function toggleAllSelectable(selected: ReadonlySet<string>, selectableIds: readonly string[]): Set<string> {
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(selectableIds);
}

/** Sólo cuentan los ids que siguen siendo visibles y seleccionables: nunca se actúa sobre algo que ya no se ve. */
export function effectiveSelection(selected: ReadonlySet<string>, selectableIds: readonly string[]): string[] {
  return selectableIds.filter((id) => selected.has(id));
}

export function productCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "producto" : "productos"}`;
}

export function selectedCountLabel(count: number): string {
  return `${productCountLabel(count)} ${count === 1 ? "seleccionado" : "seleccionados"}`;
}

export function deactivateConfirmationText(count: number): string {
  return count === 1
    ? "Vas a desactivar 1 producto. Dejará de estar disponible para la venta, pero conservará su historial de ventas, precios y movimientos."
    : `Vas a desactivar ${String(count)} productos. Dejarán de estar disponibles para la venta, pero conservarán su historial de ventas, precios y movimientos.`;
}

export function deactivateSuccessText(deactivated: number, alreadyInactive: number): string {
  const already = `${productCountLabel(alreadyInactive)} ya ${alreadyInactive === 1 ? "estaba inactivo" : "estaban inactivos"}.`;
  if (deactivated === 0) return alreadyInactive > 0 ? already : "No se desactivó ningún producto.";
  const base = `Se ${deactivated === 1 ? "desactivó" : "desactivaron"} ${productCountLabel(deactivated)}.`;
  return alreadyInactive > 0 ? `${base} ${already}` : base;
}
