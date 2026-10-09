import { parseStockQuantityInput } from "@carnicerias/business-logic";

import { effectiveMarginRule, parseCustomMarginPercent, type MarginRule } from "./product-margin";

/**
 * Productos → Precios como pantalla de REMITO (D-077): parseo de importes/cantidades y selección de las filas que REALMENTE cambiaron. Puro y
 * con tests. Ninguna fórmula de precio ni de stock vive acá: el precio automático lo forma el servidor (costo / (1 - margen), $50) y el
 * ingreso de mercadería lo escribe `record_stock_operation` dentro de `apply_pricing_receipt`. Esto sólo decide QUÉ viaja.
 */

/** "3500", "3500,5", "3500.50" → centavos enteros (> 0). Cualquier otra cosa → null. Sirve para costo y para precio. */
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

/** Centavos → texto para el placeholder / valor del input ("3500" o "3500.5" sin ceros sobrantes). */
export function costPlaceholder(cents: number | null): string {
  if (cents === null) return "Sin costo";
  return centsToField(cents);
}

/** Centavos → "10650" / "10650.5" / "10650.25" (sin separador de miles, el que acepta el parser). */
export function centsToField(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/**
 * Edición de MARGEN en la misma planilla (D-070). Sólo decide QUÉ cambió; el servidor (`set_product_custom_margin` +
 * `app_private.effective_margin`) sigue formando el precio. El valor mostrado NO es el override persistido: un producto con margen global
 * muestra el global pero no tiene fila en `product_custom_margins` hasta que Fran lo cambia.
 */

export type StockUnitKind = "WEIGHT" | "UNIT";

export interface BulkEditRowRef extends BulkCostRowRef {
  /** Margen propio persistido (null = usa la regla por defecto). */
  customMarginBps: number | null;
  /** Margen global en basis points si la fila lo usa (regla GLOBAL); null en categoría excluida o sin margen configurado. */
  globalMarginBps: number | null;
  /** WEIGHT (kg → gramos) o UNIT (unidades enteras): decide cómo se interpreta la cantidad recibida. */
  unitType: StockUnitKind;
  /** Precio de lista global vigente en centavos (null = sin precio / $0). */
  currentPriceCents: number | null;
  /** La categoría está excluida del margen automático (D-069). */
  excludedCategory: boolean;
  /** Margen global de la organización (null = sin configurar): a qué regla vuelve una fila al «usar la regla por defecto». */
  organizationMarginBps: number | null;
}

/** Lo escrito por fila: textos crudos de los inputs y el pedido de volver a la regla por defecto. */
export interface RowEdit { cost?: string; margin?: string; reset?: boolean; price?: string; quantity?: string }

export interface BulkItem {
  productId: string;
  /** Costo nuevo (ausente = no cambia). */
  costCents?: number;
  /** Presente = cambia el margen propio: basis points o null (volver a la regla por defecto). Ausente = no se toca. */
  marginBps?: number | null;
  /** Precio de lista MANUAL nuevo (ausente = no cambia). Sólo donde el precio no se deriva del costo. */
  priceCents?: number;
  /** Cantidad RECIBIDA en esta entrega, como la escribió el operador (kg con hasta 3 decimales o unidades enteras). El servidor la convierte. */
  quantity?: string;
}

/** Valor que muestra el input de margen cuando no se editó: el propio, si no el global efectivo, si no vacío (precio manual / sin margen). */
export function displayedMarginBps(row: Pick<BulkEditRowRef, "customMarginBps" | "globalMarginBps">): number | null {
  return row.customMarginBps ?? row.globalMarginBps;
}

/** «5», «5,5», «30.25» → basis points (1..9999) o null si es vacío / inválido (mismo parser y límites que el editor del producto). */
export function parseMarginBps(raw: string): number | null {
  try { return raw.trim() === "" ? null : parseCustomMarginPercent(raw); } catch { return null; }
}

/** Cambio de margen de una fila: `undefined` = sin cambio; `null` = quitar el propio; número = nuevo margen propio. */
export function marginChange(row: Pick<BulkEditRowRef, "customMarginBps" | "globalMarginBps">, edit: RowEdit | undefined): number | null | undefined {
  if (!edit) return undefined;
  if (edit.reset) return row.customMarginBps !== null ? null : undefined;
  if (edit.margin === undefined) return undefined;
  const bps = parseMarginBps(edit.margin);
  // Vacío / inválido no cambia nada; igual al mostrado (p. ej. escribir 40 con global 40) tampoco crea un override.
  if (bps === null || bps === displayedMarginBps(row)) return undefined;
  return bps;
}

/** Costo con el que va a quedar la fila: el escrito (válido y distinto del vigente) o, si no, el vigente. */
export function costAfterEdit(row: Pick<BulkEditRowRef, "currentCostCents">, edit: RowEdit | undefined): number | null {
  const typed = edit?.cost !== undefined && edit.cost !== "" ? parseCostCents(edit.cost) : null;
  return typed !== null && typed !== row.currentCostCents ? typed : row.currentCostCents;
}

/** Regla de margen con la que va a quedar la fila después de aplicar su margen escrito (misma prioridad que `app_private.effective_margin`). */
export function ruleAfterEdit(row: BulkEditRowRef, edit: RowEdit | undefined): MarginRule {
  const change = marginChange(row, edit);
  if (typeof change === "number") return { kind: "CUSTOM", bps: change };
  const custom = change === null ? null : row.customMarginBps;
  return effectiveMarginRule({ customMarginBps: custom, globalMarginBps: row.organizationMarginBps, excludedCategory: row.excludedCategory });
}

/**
 * ¿El precio de esta fila se puede escribir a mano? Sólo cuando NO se forma desde costo + margen efectivo (el estado final de la fila:
 * margen y costo escritos incluidos). Con costo y margen efectivo (propio o global) el precio es automático y el servidor rechaza uno escrito:
 * así nunca se crea una excepción ambigua al modelo automático. Caso principal: categoría excluida (Cerdo) sin margen propio.
 */
export function priceEditable(row: BulkEditRowRef, edit: RowEdit | undefined): boolean {
  const rule = ruleAfterEdit(row, edit);
  const derived = (rule.kind === "CUSTOM" || rule.kind === "GLOBAL") && (costAfterEdit(row, edit) ?? 0) > 0;
  return !derived;
}

/** Precio manual nuevo en centavos, o undefined si no hay cambio (vacío, inválido, igual al vigente o fila de precio automático). */
export function priceChange(row: BulkEditRowRef, edit: RowEdit | undefined): number | undefined {
  if (edit?.price === undefined || edit.price.trim() === "") return undefined;
  const cents = parseCostCents(edit.price);
  if (cents === null || cents === row.currentPriceCents) return undefined;
  return priceEditable(row, edit) ? cents : undefined;
}

export type ReceivedQuantity = { ok: true; ledger: number } | { ok: false; error: string };

/**
 * Cantidad RECIBIDA tal como la escribió el operador → cantidad del ledger (gramos para WEIGHT, unidades para UNIT). Es el parser canónico del
 * stock (`parseStockQuantityInput`): UNIT exige un entero (12,5 se rechaza); WEIGHT acepta kg con hasta 3 decimales (12,500 → 12500 g).
 */
export function parseReceivedQuantity(raw: string, unitType: StockUnitKind): ReceivedQuantity {
  try {
    return { ok: true, ledger: parseStockQuantityInput(raw, unitType) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Cantidad inválida" };
  }
}

/** Errores de lo escrito en la fila (sólo de campos NO vacíos): se muestran en el campo y bloquean el guardado. */
export interface RowFieldErrors { cost?: string; margin?: string; price?: string; quantity?: string }

export function rowFieldErrors(row: BulkEditRowRef, edit: RowEdit | undefined): RowFieldErrors {
  const errors: RowFieldErrors = {};
  if (!edit) return errors;
  if (edit.cost !== undefined && edit.cost.trim() !== "" && parseCostCents(edit.cost) === null) errors.cost = "Importe inválido";
  if (!edit.reset && edit.margin !== undefined && edit.margin.trim() !== "" && parseMarginBps(edit.margin) === null) errors.margin = "Entre 0,01 y 99,99";
  if (edit.price !== undefined && edit.price.trim() !== "" && priceEditable(row, edit) && parseCostCents(edit.price) === null) errors.price = "Importe inválido";
  if (edit.quantity !== undefined && edit.quantity.trim() !== "") {
    const parsed = parseReceivedQuantity(edit.quantity, row.unitType);
    if (!parsed.ok) errors.quantity = parsed.error;
  }
  return errors;
}

/** Sólo las filas con costo, margen, precio manual y/o cantidad realmente cambiados / escritos. */
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
    const price = priceChange(row, edit);
    if (price !== undefined) item.priceCents = price;
    // Cantidad vacía = ningún movimiento. Una cantidad inválida no viaja (la pantalla bloquea el guardado y la marca en el campo).
    if (edit.quantity !== undefined && edit.quantity.trim() !== "" && parseReceivedQuantity(edit.quantity, row.unitType).ok) item.quantity = edit.quantity.trim();
    if (item.costCents !== undefined || item.marginBps !== undefined || item.priceCents !== undefined || item.quantity !== undefined) items.push(item);
  }
  return items;
}

/** ¿Alguna fila tiene un campo escrito pero inválido? (bloquea el guardado: nada se descarta en silencio). */
export function hasBlockingErrors(rows: BulkEditRowRef[], edits: Record<string, RowEdit>): boolean {
  return rows.some((row) => Object.keys(rowFieldErrors(row, edits[row.id])).length > 0);
}

export const MAX_RECEIPT_ITEMS = 500;

/** Valida el pedido que llega al servidor (nunca confiar en el cliente): ids no vacíos, costo/precio enteros > 0, margen entero 1..9999 o null, cantidad como texto. */
export function parseBulkItems(raw: unknown): BulkItem[] {
  if (!Array.isArray(raw) || raw.length > MAX_RECEIPT_ITEMS) throw new Error("Los cambios son inválidos");
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
    if (value.priceCents !== undefined) {
      if (typeof value.priceCents !== "number" || !Number.isSafeInteger(value.priceCents) || value.priceCents <= 0) throw new Error("Precio inválido");
      item.priceCents = value.priceCents;
    }
    if (value.quantity !== undefined) {
      if (typeof value.quantity !== "string" || !value.quantity.trim() || value.quantity.length > 20) throw new Error("Cantidad inválida");
      item.quantity = value.quantity.trim();
    }
    if (item.costCents === undefined && item.marginBps === undefined && item.priceCents === undefined && item.quantity === undefined) throw new Error("Los cambios son inválidos");
    return item;
  });
}

export interface ReceiptProductInfo { name: string; unitType: StockUnitKind }

/** Un ítem tal como lo recibe `apply_pricing_receipt` (la cantidad ya está en unidades del ledger: gramos o unidades). */
export interface ReceiptRpcItem {
  productId: string;
  costCents?: number;
  marginBps?: number | null;
  priceCents?: number;
  receivedQuantity?: number;
}

/**
 * Convierte lo que mandó el navegador en el pedido del RPC. La cantidad se interpreta SIEMPRE con el tipo de venta del producto en la base
 * (nunca con lo que diga el cliente) y con el parser canónico del stock: UNIT = entero positivo; WEIGHT = kg con hasta 3 decimales → gramos.
 * Lanza un Error con el nombre del producto si algo no es válido o el producto no existe en la organización.
 */
export function toReceiptRpcItems(items: BulkItem[], products: ReadonlyMap<string, ReceiptProductInfo>): ReceiptRpcItem[] {
  return items.map((item) => {
    const rpc: ReceiptRpcItem = { productId: item.productId };
    if (item.costCents !== undefined) rpc.costCents = item.costCents;
    if (item.marginBps !== undefined) rpc.marginBps = item.marginBps;
    if (item.priceCents !== undefined) rpc.priceCents = item.priceCents;
    if (item.quantity !== undefined) {
      const product = products.get(item.productId);
      if (!product) throw new Error("Producto inválido para esta organización");
      try {
        rpc.receivedQuantity = parseStockQuantityInput(item.quantity, product.unitType);
      } catch (error) {
        throw new Error(`${product.name}: ${error instanceof Error ? error.message : "cantidad inválida"}`);
      }
    }
    return rpc;
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La clave de idempotencia la genera el navegador por intento de guardado; el servidor sólo comprueba que sea un UUID. */
export function isRequestKey(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
