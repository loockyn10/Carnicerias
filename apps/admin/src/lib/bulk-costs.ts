/**
 * Carga masiva de costos ("Productos → Precios"): parseo del importe y selección de las filas que REALMENTE cambiaron. Puro y con
 * tests. El precio de venta no se escribe acá: el servidor lo recalcula desde el costo con el margen global (D-068).
 */

/** "3500", "3500,5", "3500.50" → centavos enteros (> 0). Cualquier otra cosa → null. */
export function parseCostCents(value: string): number | null {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export interface BulkCostRowRef {
  id: string;
  /** Costo vigente en centavos (null = sin costo). */
  currentCostCents: number | null;
}

export interface BulkCostItem {
  productId: string;
  costCents: number;
}

/** Sólo las filas cuyo costo escrito es válido y distinto del vigente; una casilla vacía o inválida no cambia nada. */
export function changedCostItems(rows: BulkCostRowRef[], edits: Record<string, string>): BulkCostItem[] {
  const items: BulkCostItem[] = [];
  for (const row of rows) {
    const raw = edits[row.id];
    if (raw === undefined || raw === "") continue;
    const costCents = parseCostCents(raw);
    if (costCents !== null && costCents !== row.currentCostCents) items.push({ productId: row.id, costCents });
  }
  return items;
}

/** Centavos → texto para el placeholder del input ("3500" o "3500.5" sin ceros sobrantes). */
export function costPlaceholder(cents: number | null): string {
  if (cents === null) return "Sin costo";
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}
