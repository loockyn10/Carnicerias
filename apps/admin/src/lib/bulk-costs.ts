import { parseCustomMarginPercent } from "./product-margin";

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

/**
 * Edición de MARGEN en la misma planilla (D-070). Sólo decide QUÉ cambió; el servidor (`set_product_custom_margin` + `bulk_set_product_costs`
 * con `app_private.effective_margin`) sigue formando el precio. El valor mostrado NO es el override persistido: un producto con margen global
 * muestra el global pero no tiene fila en `product_custom_margins` hasta que Fran lo cambia.
 */

export interface BulkEditRowRef extends BulkCostRowRef {
  /** Margen propio persistido (null = usa la regla por defecto). */
  customMarginBps: number | null;
  /** Margen global en basis points si la fila lo usa (regla GLOBAL); null en categoría excluida o sin margen configurado. */
  globalMarginBps: number | null;
}

/** Lo escrito por fila: textos crudos de los inputs y el pedido de volver a la regla por defecto. */
export interface RowEdit { cost?: string; margin?: string; reset?: boolean }

export interface BulkItem {
  productId: string;
  /** Costo nuevo (ausente = no cambia). */
  costCents?: number;
  /** Presente = cambia el margen propio: basis points o null (volver a la regla por defecto). Ausente = no se toca. */
  marginBps?: number | null;
}

/** Valor que muestra el input de margen cuando no se editó: el propio, si no el global efectivo, si no vacío (precio manual / sin margen). */
export function displayedMarginBps(row: BulkEditRowRef): number | null {
  return row.customMarginBps ?? row.globalMarginBps;
}

/** «5», «5,5», «30.25» → basis points (1..9999) o null si es vacío / inválido (mismo parser y límites que el editor del producto). */
export function parseMarginBps(raw: string): number | null {
  try { return raw.trim() === "" ? null : parseCustomMarginPercent(raw); } catch { return null; }
}

/** Cambio de margen de una fila: `undefined` = sin cambio; `null` = quitar el propio; número = nuevo margen propio. */
export function marginChange(row: BulkEditRowRef, edit: RowEdit | undefined): number | null | undefined {
  if (!edit) return undefined;
  if (edit.reset) return row.customMarginBps !== null ? null : undefined;
  if (edit.margin === undefined) return undefined;
  const bps = parseMarginBps(edit.margin);
  // Vacío / inválido no cambia nada; igual al mostrado (p. ej. escribir 40 con global 40) tampoco crea un override.
  if (bps === null || bps === displayedMarginBps(row)) return undefined;
  return bps;
}

/** Sólo las filas con costo y/o margen realmente cambiados. */
export function changedBulkItems(rows: BulkEditRowRef[], edits: Record<string, RowEdit>): BulkItem[] {
  const items: BulkItem[] = [];
  for (const row of rows) {
    const edit = edits[row.id];
    if (!edit) continue;
    const item: BulkItem = { productId: row.id };
    const raw = edit.cost;
    if (raw !== undefined && raw !== "") {
      const costCents = parseCostCents(raw);
      if (costCents !== null && costCents !== row.currentCostCents) item.costCents = costCents;
    }
    const margin = marginChange(row, edit);
    if (margin !== undefined) item.marginBps = margin;
    if (item.costCents !== undefined || item.marginBps !== undefined) items.push(item);
  }
  return items;
}

/** Valida el pedido que llega al servidor (nunca confiar en el cliente): ids no vacíos, costo entero > 0, margen entero 1..9999 o null. */
export function parseBulkItems(raw: unknown): BulkItem[] {
  if (!Array.isArray(raw)) throw new Error("Los cambios son inválidos");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    const value = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const productId = value.productId;
    if (typeof productId !== "string" || !productId || seen.has(productId)) throw new Error("Los cambios son inválidos");
    seen.add(productId);
    const item: BulkItem = { productId };
    if (value.costCents !== undefined) {
      if (typeof value.costCents !== "number" || !Number.isSafeInteger(value.costCents) || value.costCents <= 0) throw new Error("Costo inválido");
      item.costCents = value.costCents;
    }
    if (value.marginBps !== undefined) {
      const bps = value.marginBps;
      if (bps !== null && (typeof bps !== "number" || !Number.isSafeInteger(bps) || bps < 1 || bps > 9_999)) throw new Error("El margen personalizado tiene que ser mayor a 0 y menor a 100.");
      item.marginBps = bps;
    }
    if (item.costCents === undefined && item.marginBps === undefined) throw new Error("Los cambios son inválidos");
    return item;
  });
}
