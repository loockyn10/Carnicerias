import { formatStockQuantity, parseStockQuantityInput, type StockUnit } from "@carnicerias/business-logic";

import { formatSignedQuantity, physicalCountDifference } from "./stock-audit";
import { isUuid } from "./uuid";

/**
 * «Stock rápido» (celular). Este módulo es la parte PURA: cambios pendientes, validación de lo que escribe el usuario, armado del pedido y lectura
 * del resultado. NO calcula stock ni guarda nada: el stock sale del ledger (`stock_levels`) y lo que se guarda lo hace
 * `apply_quick_stock_changes`, que a su vez usa `record_stock_operation` (el flujo canónico de `stock_movements`). Agregar y quitar son DELTAS
 * (nunca «fijar el stock»); el conteo físico lleva el stock al valor contado conservando la historia.
 *
 * Cantidades: kg con coma (hasta 3 decimales) para un producto WEIGHT, unidades enteras para un UNIT; en el servidor se convierten a la cantidad
 * cruda del ledger (gramos / unidades) con el tipo REAL del producto, nunca con el que diga el navegador.
 */

export interface QuickStockRow {
  productId: string;
  name: string;
  sku: string | null;
  unitType: StockUnit;
  /** Stock actual del ledger, en la cantidad cruda (gramos / unidades). */
  current: number;
}

export interface QuickStockSearchResult {
  rows: QuickStockRow[];
  /** Cuántos productos de la sucursal coinciden en total (para «Ver más»). */
  total: number;
}

export type QuickChangeMode = "ADD" | "REMOVE";

export interface QuickChange {
  branchId: string;
  productId: string;
  productName: string;
  unitType: StockUnit;
  mode: QuickChangeMode;
  /** Lo que escribió el usuario (kg con coma o unidades). Siempre positivo: el signo lo pone `mode`. */
  raw: string;
}

/** sucursal → producto → cambio. Un producto tiene como mucho UN cambio pendiente por sucursal (el último que se cargó). */
export type PendingChanges = Record<string, Record<string, QuickChange>>;

// ---------------------------------------------------------------------------------------------
// Lo que escribe el usuario
// ---------------------------------------------------------------------------------------------
export type ParsedQuantity = { ok: true; quantity: number } | { ok: false; message: string };

/** Una cantidad a agregar o quitar: positiva (el signo lo da el botón). */
export function parseChangeQuantity(raw: string, unitType: StockUnit): ParsedQuantity {
  try {
    return { ok: true, quantity: parseStockQuantityInput(raw, unitType) };
  } catch (error) {
    return { ok: false, message: error instanceof RangeError ? error.message : "Cantidad inválida" };
  }
}

/** Cantidad con signo en la unidad cruda del ledger (+ agregar, − quitar). `null` si lo escrito no es válido. */
export function signedChangeQuantity(change: Pick<QuickChange, "mode" | "raw" | "unitType">): number | null {
  const parsed = parseChangeQuantity(change.raw, change.unitType);
  if (!parsed.ok) return null;
  return change.mode === "REMOVE" ? -parsed.quantity : parsed.quantity;
}

/** «+15,000 kg» / «-2,000 kg» / «+12 u». */
export function describeChange(change: Pick<QuickChange, "mode" | "raw" | "unitType">): string {
  const signed = signedChangeQuantity(change);
  return signed === null ? "—" : formatSignedQuantity(signed, change.unitType);
}

/** Texto de un quitar que no se puede hacer: no hay tanto stock. `null` si se puede. */
export function removeProblem(current: number, quantity: number, unitType: StockUnit): string | null {
  if (quantity <= current) return null;
  return current <= 0
    ? "No hay stock para quitar. Si el sistema está desactualizado, usá Conteo."
    : `Hay sólo ${formatStockQuantity(current, unitType)}: no se puede quitar más que eso. Si contaste otra cosa, usá Conteo.`;
}

// ---------------------------------------------------------------------------------------------
// Conteo físico (vista previa; no guarda nada)
// ---------------------------------------------------------------------------------------------
export type CountPreview =
  | { state: "empty" }
  | { state: "invalid"; message: string }
  | { state: "ok"; physicalQuantity: number; difference: number; matches: boolean; message: string };

/** «Se registrará un ajuste de -12,400 kg»: la app calcula la diferencia, el usuario no hace cuentas. */
export function countPreview(raw: string, unitType: StockUnit, systemQuantity: number): CountPreview {
  const result = physicalCountDifference(raw, unitType, systemQuantity);
  if (result.state !== "ok") return result;
  return {
    state: "ok", physicalQuantity: result.physicalQuantity, difference: result.difference, matches: result.matches,
    message: result.matches ? "Coincide con el sistema: no hay nada que ajustar." : `Se registrará un ajuste de ${formatSignedQuantity(result.difference, unitType)}`
  };
}

// ---------------------------------------------------------------------------------------------
// Cambios pendientes (inmutables)
// ---------------------------------------------------------------------------------------------
export function getChange(pending: PendingChanges, branchId: string, productId: string): QuickChange | undefined {
  return pending[branchId]?.[productId];
}

export function upsertChange(pending: PendingChanges, change: QuickChange): PendingChanges {
  return { ...pending, [change.branchId]: { ...pending[change.branchId], [change.productId]: change } };
}

export function removeChange(pending: PendingChanges, branchId: string, productId: string): PendingChanges {
  const branch = pending[branchId];
  if (!branch || !(productId in branch)) return pending;
  const rest = Object.fromEntries(Object.entries(branch).filter(([id]) => id !== productId));
  const others = Object.fromEntries(Object.entries(pending).filter(([id]) => id !== branchId));
  return Object.keys(rest).length ? { ...others, [branchId]: rest } : others;
}

export function pendingList(pending: PendingChanges): QuickChange[] {
  return Object.values(pending).flatMap((branch) => Object.values(branch));
}

export function pendingTotal(pending: PendingChanges): number {
  return pendingList(pending).length;
}

export interface PendingBranchGroup { branchId: string; changes: QuickChange[] }

/** Cambios agrupados por sucursal, en el orden de `branchOrder` (las que no estén en la lista van al final, sin perderse). */
export function groupPendingByBranch(pending: PendingChanges, branchOrder: readonly string[]): PendingBranchGroup[] {
  const known = branchOrder.filter((id) => pending[id]);
  const unknown = Object.keys(pending).filter((id) => !branchOrder.includes(id));
  return [...known, ...unknown].map((branchId) => ({
    branchId,
    changes: Object.values(pending[branchId] ?? {}).sort((a, b) => a.productName.localeCompare(b.productName, "es"))
  })).filter((group) => group.changes.length > 0);
}

/** «1 producto» / «3 productos». */
export function productsText(count: number): string {
  return `${String(count)} ${count === 1 ? "producto" : "productos"}`;
}

// ---------------------------------------------------------------------------------------------
// Persistencia local (los cambios sobreviven a un cierre accidental de la pantalla)
// ---------------------------------------------------------------------------------------------
export function serializePending(pending: PendingChanges): string {
  return JSON.stringify(pending);
}

function isChange(value: unknown): value is QuickChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return isUuid(change.branchId) && isUuid(change.productId) && typeof change.productName === "string"
    && (change.unitType === "WEIGHT" || change.unitType === "UNIT") && (change.mode === "ADD" || change.mode === "REMOVE") && typeof change.raw === "string"
    && parseChangeQuantity(change.raw, change.unitType).ok;
}

/** Lee lo guardado descartando cualquier cosa corrupta o inválida (nunca lanza). */
export function deserializePending(json: string | null): PendingChanges {
  if (!json) return {};
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    let result: PendingChanges = {};
    for (const [branchId, branch] of Object.entries(data as Record<string, unknown>)) {
      if (typeof branch !== "object" || branch === null) continue;
      for (const [productId, change] of Object.entries(branch as Record<string, unknown>)) {
        if (isChange(change) && change.branchId === branchId && change.productId === productId) result = upsertChange(result, change);
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Pedido al servidor
// ---------------------------------------------------------------------------------------------
export type QuickApplyMode = "ADD" | "REMOVE" | "COUNT";

export interface QuickApplyItem {
  branchId: string;
  productId: string;
  mode: QuickApplyMode;
  /** Agregar / quitar: lo escrito; conteo: lo contado. El servidor lo convierte con el tipo real del producto. */
  raw: string;
  /** Sólo conteo: el stock del sistema que la pantalla mostraba (si cambió, el conteo no se aplica). */
  expectedSystemQuantity?: number;
}

export const MAX_QUICK_ITEMS = 200;

/** Clave nueva para un pedido (UUID v4). `randomUUID` sólo existe en contexto seguro (https / localhost): sin él se arma con getRandomValues. */
export function newRequestKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Líneas del pedido en un orden estable (sucursal, producto): el mismo pedido da siempre la misma huella y el mismo hash. */
export function buildApplyItems(pending: PendingChanges): QuickApplyItem[] {
  return pendingList(pending)
    .map((change): QuickApplyItem => ({ branchId: change.branchId, productId: change.productId, mode: change.mode, raw: change.raw.trim() }))
    .sort((a, b) => a.branchId.localeCompare(b.branchId) || a.productId.localeCompare(b.productId));
}

export function itemsSignature(items: readonly QuickApplyItem[]): string {
  return JSON.stringify(items);
}

/**
 * Clave de idempotencia del pedido: la MISMA mientras el pedido no cambie (un reintento tras un corte de red no duplica nada) y NUEVA en cuanto cambia o
 * el servidor ya respondió. Sin esto un segundo toque a «Guardar» registraría otra vez el mismo ingreso.
 */
export class RequestKeyBook {
  private current: { signature: string; key: string } | null = null;

  keyFor(signature: string, generate: () => string): string {
    if (this.current?.signature !== signature) this.current = { signature, key: generate() };
    return this.current.key;
  }

  /** El servidor respondió (bien o mal): el próximo pedido, aunque sea idéntico, se evalúa de nuevo. */
  clear(): void {
    this.current = null;
  }
}

/**
 * Un solo guardado a la vez: mientras uno está en curso, otro toque (doble toque, o un botón distinto) NO lanza otro. Es la primera defensa contra
 * duplicar un ingreso; la segunda es la clave de idempotencia del servidor (`apply_quick_stock_changes`).
 */
export class SingleFlight {
  private busy = false;

  /** `ran: false` = ya había uno en curso y esta llamada no hizo nada. */
  async run<T>(task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy) return { ran: false };
    this.busy = true;
    try {
      return { ran: true, value: await task() };
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------------------------
export type QuickItemOutcome =
  | { ok: true; branchId: string; productId: string; mode: QuickApplyMode; unchanged: boolean; before: number; after: number; difference: number }
  | { ok: false; branchId: string; productId: string; mode: QuickApplyMode; code: string; current: number | null; message: string | null };

export interface QuickStockOutcome {
  applied: number;
  unchanged: number;
  failed: number;
  replayed: boolean;
  items: QuickItemOutcome[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Lee la respuesta de `apply_quick_stock_changes` de forma defensiva (nunca lanza: una respuesta rara es un error de la operación, no un cierre). */
export function parseQuickOutcome(data: unknown): QuickStockOutcome | null {
  if (!isRecord(data) || !Array.isArray(data.items)) return null;
  const items: QuickItemOutcome[] = [];
  for (const raw of data.items) {
    if (!isRecord(raw) || typeof raw.branchId !== "string" || typeof raw.productId !== "string") continue;
    const mode: QuickApplyMode = raw.mode === "REMOVE" || raw.mode === "COUNT" ? raw.mode : "ADD";
    if (raw.ok === true) {
      items.push({ ok: true, branchId: raw.branchId, productId: raw.productId, mode, unchanged: raw.unchanged === true, before: numberOrNull(raw.before) ?? 0, after: numberOrNull(raw.after) ?? 0, difference: numberOrNull(raw.difference) ?? 0 });
    } else {
      items.push({ ok: false, branchId: raw.branchId, productId: raw.productId, mode, code: typeof raw.code === "string" ? raw.code : "FAILED", current: numberOrNull(raw.current), message: typeof raw.message === "string" ? raw.message : null });
    }
  }
  const failed = items.filter((item) => !item.ok).length;
  const unchanged = items.filter((item) => item.ok && item.unchanged).length;
  return { applied: items.length - failed - unchanged, unchanged, failed, replayed: data.replayed === true, items };
}

/** Por qué no se pudo guardar un producto, en palabras del negocio. */
export function failureText(item: Extract<QuickItemOutcome, { ok: false }>, unitType: StockUnit): string {
  switch (item.code) {
    case "NOT_IN_BRANCH": return "Este producto no se vende en esta sucursal.";
    case "INSUFFICIENT_STOCK": return item.current === null ? "No hay tanto stock para quitar." : `Hay sólo ${formatStockQuantity(item.current, unitType)}: no se puede quitar tanto.`;
    case "STOCK_CHANGED": return "El stock cambió mientras tanto (una venta o un movimiento). Volvé a contar.";
    default: return "No se pudo guardar. Probá de nuevo.";
  }
}

/** Saca de los pendientes lo que el servidor guardó (o ya coincidía). Lo que falló queda para reintentar, sin perderse. */
export function reconcilePending(pending: PendingChanges, outcome: QuickStockOutcome): PendingChanges {
  let next = pending;
  for (const item of outcome.items) if (item.ok) next = removeChange(next, item.branchId, item.productId);
  return next;
}

/** «4 productos modificados» (los que ya coincidían no cuentan como modificados). */
export function savedSummary(outcome: Pick<QuickStockOutcome, "applied">): string {
  return `${productsText(outcome.applied)} ${outcome.applied === 1 ? "modificado" : "modificados"}`;
}
