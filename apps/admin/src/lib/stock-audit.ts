import { formatStockQuantity, parseStockQuantityInput, type StockUnit } from "@carnicerias/business-logic";
import type { Database } from "@carnicerias/database";

import { isIsoDate, localDateString, rangeDays, MAX_RANGE_DAYS, shiftIsoDate } from "./date-range";

/**
 * Auditoría por producto + sucursal (sólo lectura). Las cifras salen de `get_stock_audit_summary` y
 * `list_stock_audit_movements` (agregación y paginación en el servidor, sobre `stock_movements`, que sigue
 * siendo el único stock). Este módulo sólo VALIDA esas respuestas, las AGRUPA para mostrarlas y calcula la
 * diferencia contra un conteo físico: no hay un segundo stock ni se corrige nada.
 *
 * Cantidades: gramos para un producto WEIGHT, unidades para un UNIT (la misma columna del ledger).
 */

export type AuditMode = "RANGE" | "SINCE_LAST_INBOUND" | "ALL_HISTORY";

export interface AuditTypeTotal { type: string; count: number; quantity: number }
export interface AuditAnchor { movementId: string; type: string; occurredAt: string; quantity: number }

export interface AuditSaleMismatch {
  saleId: string;
  status: string;
  completedAt: string;
  saleQuantity: number;
  ledgerQuantity: number;
  expectedQuantity: number;
}

/** Control ventas COMPLETED vs. lo que el ledger descontó por esas mismas ventas. null si el usuario no tiene sales.read. */
export interface AuditSalesCheck {
  completedTickets: number;
  completedQuantity: number;
  completedRevenueCents: number;
  ledgerQuantityForCompleted: number;
  difference: number;
  pendingPaymentTickets: number;
  pendingPaymentQuantity: number;
  mismatchedSales: number;
  mismatches: AuditSaleMismatch[];
  orphanSaleMovements: { count: number; quantity: number };
}

export interface StockAuditSummary {
  product: { id: string; name: string; sku: string | null; unitType: StockUnit; active: boolean };
  branch: { id: string; name: string };
  mode: AuditMode;
  timezone: string;
  periodStart: string | null;
  periodEnd: string | null;
  anchor: AuditAnchor | null;
  openingQuantity: number;
  windowQuantity: number;
  closingQuantity: number;
  afterPeriodQuantity: number;
  currentQuantity: number;
  movementCount: number;
  byType: AuditTypeTotal[];
  sales: AuditSalesCheck | null;
  computedAt: string;
}

export interface AuditMovement {
  id: string;
  occurredAt: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  reason: string | null;
  operatorName: string | null;
  saleId: string | null;
  saleStatus: string | null;
  transferId: string | null;
  counterpartBranchName: string | null;
  stockOperationId: string | null;
  supplier: string | null;
  productionBatchId: string | null;
}

export interface AuditMovementsPage {
  total: number;
  openingQuantity: number;
  limit: number;
  offset: number;
  newestFirst: boolean;
  rows: AuditMovement[];
}

// ---------------------------------------------------------------------------------------------
// Validación de las respuestas (una forma inesperada falla fuerte, igual que parsePricingRowsPage)
// ---------------------------------------------------------------------------------------------
const UNEXPECTED = "Respuesta inesperada de la auditoría de stock";

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(UNEXPECTED);
  return value as Obj;
}
function int(source: Obj, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(UNEXPECTED);
  return value;
}
function str(source: Obj, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(UNEXPECTED);
  return value;
}
function strOrNull(source: Obj, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}
function list(source: Obj, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(UNEXPECTED);
  return value;
}
function unit(value: unknown): StockUnit {
  if (value !== "WEIGHT" && value !== "UNIT") throw new Error(UNEXPECTED);
  return value;
}

function parseSalesCheck(value: unknown): AuditSalesCheck | null {
  if (value === null || value === undefined) return null;
  const root = obj(value);
  const orphan = obj(root.orphanSaleMovements);
  return {
    completedTickets: int(root, "completedTickets"),
    completedQuantity: int(root, "completedQuantity"),
    completedRevenueCents: int(root, "completedRevenueCents"),
    ledgerQuantityForCompleted: int(root, "ledgerQuantityForCompleted"),
    difference: int(root, "difference"),
    pendingPaymentTickets: int(root, "pendingPaymentTickets"),
    pendingPaymentQuantity: int(root, "pendingPaymentQuantity"),
    mismatchedSales: int(root, "mismatchedSales"),
    mismatches: list(root, "mismatches").map((entry): AuditSaleMismatch => {
      const row = obj(entry);
      return {
        saleId: str(row, "saleId"), status: str(row, "status"), completedAt: str(row, "completedAt"),
        saleQuantity: int(row, "saleQuantity"), ledgerQuantity: int(row, "ledgerQuantity"), expectedQuantity: int(row, "expectedQuantity")
      };
    }),
    orphanSaleMovements: { count: int(orphan, "count"), quantity: int(orphan, "quantity") }
  };
}

export function parseStockAuditSummary(data: unknown): StockAuditSummary {
  const root = obj(data);
  const product = obj(root.product);
  const branch = obj(root.branch);
  const mode = root.mode;
  if (mode !== "RANGE" && mode !== "SINCE_LAST_INBOUND" && mode !== "ALL_HISTORY") throw new Error(UNEXPECTED);
  const anchorValue = root.anchor;
  let anchor: AuditAnchor | null = null;
  if (anchorValue !== null && anchorValue !== undefined) {
    const row = obj(anchorValue);
    anchor = { movementId: str(row, "movementId"), type: str(row, "type"), occurredAt: str(row, "occurredAt"), quantity: int(row, "quantity") };
  }
  return {
    product: { id: str(product, "id"), name: str(product, "name"), sku: strOrNull(product, "sku"), unitType: unit(product.unitType), active: product.active === true },
    branch: { id: str(branch, "id"), name: str(branch, "name") },
    mode,
    timezone: str(root, "timezone"),
    periodStart: strOrNull(root, "periodStart"),
    periodEnd: strOrNull(root, "periodEnd"),
    anchor,
    openingQuantity: int(root, "openingQuantity"),
    windowQuantity: int(root, "windowQuantity"),
    closingQuantity: int(root, "closingQuantity"),
    afterPeriodQuantity: int(root, "afterPeriodQuantity"),
    currentQuantity: int(root, "currentQuantity"),
    movementCount: int(root, "movementCount"),
    byType: list(root, "byType").map((entry): AuditTypeTotal => {
      const row = obj(entry);
      return { type: str(row, "type"), count: int(row, "count"), quantity: int(row, "quantity") };
    }),
    sales: parseSalesCheck(root.sales),
    computedAt: str(root, "computedAt")
  };
}

export function parseAuditMovementsPage(data: unknown): AuditMovementsPage {
  const root = obj(data);
  return {
    total: int(root, "total"),
    openingQuantity: int(root, "openingQuantity"),
    limit: int(root, "limit"),
    offset: int(root, "offset"),
    newestFirst: root.newestFirst === true,
    rows: list(root, "rows").map((entry): AuditMovement => {
      const row = obj(entry);
      return {
        id: str(row, "id"), occurredAt: str(row, "occurredAt"), type: str(row, "type"),
        quantity: int(row, "quantity"), balanceAfter: int(row, "balanceAfter"),
        reason: strOrNull(row, "reason"), operatorName: strOrNull(row, "operatorName"),
        saleId: strOrNull(row, "saleId"), saleStatus: strOrNull(row, "saleStatus"),
        transferId: strOrNull(row, "transferId"), counterpartBranchName: strOrNull(row, "counterpartBranchName"),
        stockOperationId: strOrNull(row, "stockOperationId"), supplier: strOrNull(row, "supplier"),
        productionBatchId: strOrNull(row, "productionBatchId")
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------
// Tipos del ledger y su agrupación
// ---------------------------------------------------------------------------------------------
export type StockMovementType = Database["public"]["Enums"]["stock_movement_type"];

/**
 * Etiqueta de cada tipo REAL de `stock_movement_type`. El `Record` exhaustivo hace que el typecheck falle si
 * una migración agrega un tipo al enum y nadie decide cómo se muestra (no se inventan ni se omiten tipos).
 */
export const MOVEMENT_TYPE_LABELS: Readonly<Record<StockMovementType, string>> = {
  PURCHASE: "Ingreso / recepción",
  TRANSFER_IN: "Transferencia recibida",
  RETURN: "Devolución / anulación de venta",
  SALE: "Venta",
  TRANSFER_OUT: "Transferencia enviada",
  WASTE: "Merma",
  ADJUSTMENT_POSITIVE: "Ajuste (+)",
  ADJUSTMENT_NEGATIVE: "Ajuste (−)",
  PRODUCTION_YIELD: "Producción de desposte",
  PRODUCTION_CONSUME: "Consumo en desposte",
  OPENING_BALANCE: "Saldo inicial"
};

export function movementTypeLabel(type: string): string {
  return (MOVEMENT_TYPE_LABELS as Readonly<Record<string, string>>)[type] ?? `Otro movimiento (${type})`;
}

interface AuditGroupDefinition { key: string; label: string; types: readonly string[]; sign: "+" | "−" | "±"; always: boolean }

/**
 * Cómo se agrupan los tipos en el resumen. El orden es el de la fórmula del stock. Cada tipo del enum
 * pertenece a UN grupo; un tipo que algún día se agregue y no figure acá aparece como «Otros movimientos»
 * (nunca se pierde, así la fórmula siempre cierra).
 */
const AUDIT_GROUPS: readonly AuditGroupDefinition[] = [
  { key: "RECEPTIONS", label: "Ingresos / recepciones", types: ["PURCHASE"], sign: "+", always: true },
  { key: "PRODUCTION_YIELD", label: "Producción de desposte", types: ["PRODUCTION_YIELD"], sign: "+", always: false },
  { key: "OPENING_BALANCE", label: "Saldo inicial migrado", types: ["OPENING_BALANCE"], sign: "+", always: false },
  { key: "TRANSFERS_IN", label: "Transferencias recibidas", types: ["TRANSFER_IN"], sign: "+", always: true },
  { key: "RETURNS", label: "Devoluciones / anulaciones de venta", types: ["RETURN"], sign: "+", always: true },
  { key: "SALES", label: "Ventas", types: ["SALE"], sign: "−", always: true },
  { key: "TRANSFERS_OUT", label: "Transferencias enviadas", types: ["TRANSFER_OUT"], sign: "−", always: true },
  { key: "WASTE", label: "Mermas", types: ["WASTE"], sign: "−", always: true },
  { key: "PRODUCTION_CONSUME", label: "Consumo en desposte", types: ["PRODUCTION_CONSUME"], sign: "−", always: false },
  { key: "ADJUSTMENT_POSITIVE", label: "Ajustes de conteo (+)", types: ["ADJUSTMENT_POSITIVE"], sign: "+", always: true },
  { key: "ADJUSTMENT_NEGATIVE", label: "Ajustes de conteo (−)", types: ["ADJUSTMENT_NEGATIVE"], sign: "−", always: true }
];

export interface AuditGroupRow { key: string; label: string; sign: "+" | "−" | "±"; count: number; quantity: number }

/** Una fila por grupo (siempre las «habituales», las demás sólo si tuvieron movimientos). La suma de las filas == suma de byType. */
export function groupAuditMovements(byType: readonly AuditTypeTotal[]): AuditGroupRow[] {
  const known = new Set(AUDIT_GROUPS.flatMap((group) => group.types));
  const rows: AuditGroupRow[] = [];
  for (const group of AUDIT_GROUPS) {
    const members = byType.filter((entry) => group.types.includes(entry.type));
    const count = members.reduce((total, entry) => total + entry.count, 0);
    const quantity = members.reduce((total, entry) => total + entry.quantity, 0);
    if (group.always || count > 0) rows.push({ key: group.key, label: group.label, sign: group.sign, count, quantity });
  }
  for (const entry of byType.filter((candidate) => !known.has(candidate.type))) {
    rows.push({ key: entry.type, label: `Otros movimientos (${entry.type})`, sign: "±", count: entry.count, quantity: entry.quantity });
  }
  return rows;
}

/** Entradas «reales» de mercadería: las que definen el ancla de «Desde el último ingreso». */
export const INBOUND_TYPES: readonly string[] = ["PURCHASE", "TRANSFER_IN", "PRODUCTION_YIELD", "OPENING_BALANCE"];

export interface AuditQuickSummary {
  /** Lo que entró (recepciones, transferencias recibidas, producción, saldo inicial). */
  entered: number;
  /** Vendido neto de anulaciones: -(SALE + RETURN). Es lo que se compara con las ventas COMPLETED. */
  sold: number;
  /** Mermas (positivo = cantidad perdida). */
  waste: number;
  /** Ajustes de conteo netos (con signo). */
  adjustments: number;
  /** Salió por otros motivos: transferencias enviadas, consumo en desposte y tipos desconocidos (positivo = salió). */
  otherOutflows: number;
}

/** Resumen corto del período: Entró / Vendido / Merma / Ajustes / Otras salidas. opening + entered - sold - waste + adjustments - otherOutflows == closing. */
export function quickSummary(byType: readonly AuditTypeTotal[]): AuditQuickSummary {
  const sum = (types: readonly string[]) => byType.filter((entry) => types.includes(entry.type)).reduce((total, entry) => total + entry.quantity, 0);
  // Nunca -0: Intl lo mostraría como «-0,000 kg».
  const outflow = (quantity: number) => (quantity === 0 ? 0 : -quantity);
  const entered = sum(INBOUND_TYPES);
  const sold = outflow(sum(["SALE"]) + sum(["RETURN"]));
  const waste = outflow(sum(["WASTE"]));
  const adjustments = sum(["ADJUSTMENT_POSITIVE", "ADJUSTMENT_NEGATIVE"]);
  const accounted = new Set([...INBOUND_TYPES, "SALE", "RETURN", "WASTE", "ADJUSTMENT_POSITIVE", "ADJUSTMENT_NEGATIVE"]);
  const otherOutflows = outflow(byType.filter((entry) => !accounted.has(entry.type)).reduce((total, entry) => total + entry.quantity, 0));
  return { entered, sold, waste, adjustments, otherOutflows };
}

/** ¿Lo que dicen las ventas COMPLETED coincide con lo que el ledger descontó? Cualquier diferencia se informa, nunca se corrige. */
export function salesCheckHasDiscrepancy(check: AuditSalesCheck): boolean {
  return check.difference !== 0 || check.mismatchedSales > 0 || check.orphanSaleMovements.count > 0;
}

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------
/** «+20,000 kg» / «-1,350 kg» / «0,000 kg»; unidades sin decimales. */
export function formatSignedQuantity(quantity: number, unitType: StockUnit): string {
  const text = formatStockQuantity(quantity, unitType);
  return quantity > 0 ? `+${text}` : text;
}

/** Qué originó el movimiento, en una línea (ticket, transferencia, proveedor, motivo…). */
export function describeMovementReference(movement: AuditMovement): string {
  switch (movement.type) {
    case "SALE":
    case "RETURN": {
      if (!movement.saleId) return movement.reason ?? "";
      const ticket = `Ticket ${movement.saleId.slice(0, 8)}`;
      const status = movement.saleStatus === "CANCELLED" ? " · anulada" : movement.saleStatus === "PENDING_PAYMENT" ? " · pago pendiente" : "";
      return `${ticket}${status}${movement.type === "RETURN" && movement.reason ? ` · ${movement.reason}` : ""}`;
    }
    case "TRANSFER_IN": return movement.counterpartBranchName ? `Desde ${movement.counterpartBranchName}` : "Transferencia";
    case "TRANSFER_OUT": return movement.counterpartBranchName ? `Hacia ${movement.counterpartBranchName}` : "Transferencia";
    case "PURCHASE": return [movement.supplier ? `Proveedor ${movement.supplier}` : null, movement.reason].filter(Boolean).join(" · ");
    case "PRODUCTION_YIELD":
    case "PRODUCTION_CONSUME": return movement.productionBatchId ? `Desposte ${movement.productionBatchId.slice(0, 8)}` : "Desposte";
    default: return movement.reason ?? "";
  }
}

// ---------------------------------------------------------------------------------------------
// Conteo físico: sólo muestra la diferencia; el ajuste real lo hace el flujo existente
// (record_stock_operation ADJUSTMENT) después de que alguien lo confirme.
// ---------------------------------------------------------------------------------------------
export type PhysicalCountResult =
  | { state: "empty" }
  | { state: "invalid"; message: string }
  | { state: "ok"; physicalQuantity: number; systemQuantity: number; difference: number; matches: boolean };

export function physicalCountDifference(raw: string, unitType: StockUnit, systemQuantity: number): PhysicalCountResult {
  if (!raw.trim()) return { state: "empty" };
  try {
    const physicalQuantity = parseStockQuantityInput(raw, unitType, { allowZero: true });
    const difference = physicalQuantity - systemQuantity;
    return { state: "ok", physicalQuantity, systemQuantity, difference, matches: difference === 0 };
  } catch (error) {
    return { state: "invalid", message: error instanceof Error ? error.message : "Cantidad inválida" };
  }
}

// ---------------------------------------------------------------------------------------------
// Período de la URL y enlaces entre vistas (Ventas ⇄ Stock/movimientos)
// ---------------------------------------------------------------------------------------------
export type AuditPeriod = { mode: "since-inbound" } | { mode: "range"; from: string; to: string };

/**
 * Interpreta ?mode=&from=&to=. Sin nada → «Desde el último ingreso» (lo que se necesita para ver por qué el
 * sistema dice 16,6 kg). Con fechas (o mode=range) → rango de días de la organización; uno inválido no rompe
 * la pantalla: vuelve a los últimos 7 días y devuelve `error`.
 */
export function resolveAuditPeriod(
  input: { mode?: string | undefined; from?: string | undefined; to?: string | undefined },
  timeZone: string,
  now: Date = new Date()
): { period: AuditPeriod; error?: string } {
  const from = (input.from ?? "").trim();
  const to = (input.to ?? "").trim();
  const wantsRange = input.mode === "range" || Boolean(from) || Boolean(to);
  if (!wantsRange) return { period: { mode: "since-inbound" } };
  const today = localDateString(timeZone, now);
  const fallback = (error?: string): { period: AuditPeriod; error?: string } => ({
    period: { mode: "range", from: shiftIsoDate(today, -6), to: today }, ...(error ? { error } : {})
  });
  if (!from && !to) return fallback();
  if (!from || !to) return fallback("Elegí las dos fechas: Desde y Hasta.");
  if (!isIsoDate(from) || !isIsoDate(to)) return fallback("Alguna de las fechas no es válida.");
  if (from > to) return fallback("La fecha Desde no puede ser posterior a Hasta.");
  if (rangeDays(from, to) > MAX_RANGE_DAYS) return fallback(`El rango no puede superar ${String(MAX_RANGE_DAYS)} días.`);
  return { period: { mode: "range", from, to } };
}

/** Argumentos de los RPC a partir del período. */
export function periodRpcArgs(period: AuditPeriod): { p_since_last_inbound: boolean; p_from?: string; p_to?: string } {
  return period.mode === "since-inbound" ? { p_since_last_inbound: true } : { p_since_last_inbound: false, p_from: period.from, p_to: period.to };
}

/** Pantalla de movimientos de un producto en una sucursal. */
export function stockAuditHref(input: { branchId: string; productId: string; period?: AuditPeriod | null; page?: number; newestFirst?: boolean }): string {
  const query = new URLSearchParams({ branch: input.branchId, product: input.productId });
  if (input.period?.mode === "range") {
    query.set("mode", "range");
    query.set("from", input.period.from);
    query.set("to", input.period.to);
  }
  if (input.newestFirst) query.set("order", "newest");
  if (input.page && input.page > 1) query.set("page", String(input.page));
  return `/admin/branch-stock/movements?${query.toString()}`;
}

/** Ventas filtradas por producto (y sucursal/rango si se conocen). El estado queda en «Completadas»: lo que se audita. */
export function productSalesHref(input: { productId: string; branchId?: string | null; range?: { from: string; to: string } | null; preset?: "today" | "yesterday" | "week" | "month" }): string {
  const query = new URLSearchParams({ product: input.productId, status: "COMPLETED" });
  if (input.branchId) query.set("branch", input.branchId);
  if (input.range) {
    query.set("preset", "custom");
    query.set("from", input.range.from);
    query.set("to", input.range.to);
  } else if (input.preset) {
    query.set("preset", input.preset);
  }
  return `/admin/sales?${query.toString()}`;
}

/**
 * Rango de días (de la organización) que cubre el período auditado, para saltar a Ventas con el mismo
 * recorte: «desde el último ingreso» va del día del ingreso a hoy; «todo el historial» queda acotado al máximo
 * que admiten los RPC de ventas.
 */
export function auditPeriodDateRange(summary: StockAuditSummary, timeZone: string, now: Date = new Date()): { from: string; to: string } {
  const today = localDateString(timeZone, now);
  if (summary.mode === "RANGE" && summary.periodStart && summary.periodEnd) {
    // periodEnd es la medianoche local SIGUIENTE (exclusiva): el último día incluido es un instante antes.
    return { from: localDateString(timeZone, new Date(summary.periodStart)), to: localDateString(timeZone, new Date(Date.parse(summary.periodEnd) - 1)) };
  }
  const oldest = shiftIsoDate(today, -(MAX_RANGE_DAYS - 1));
  if (summary.mode === "SINCE_LAST_INBOUND" && summary.periodStart) {
    const from = localDateString(timeZone, new Date(summary.periodStart));
    return { from: from < oldest ? oldest : from, to: today };
  }
  return { from: oldest, to: today };
}
