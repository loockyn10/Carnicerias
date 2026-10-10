import { formatStockQuantity, type StockUnit } from "@carnicerias/business-logic";
import type { Database } from "@carnicerias/database";

/**
 * Resumen operativo de una sucursal ("Qué está pasando"): Más vendidos, Baja rotación y Requiere atención.
 *
 * Las CIFRAS salen del servidor en una sola llamada (`get_branch_operations_summary`: ventas del período, de 7 y
 * de 14 días, última venta/ingreso y diferencias ventas-vs-ledger, por producto del surtido). Este módulo sólo
 * aplica reglas simples y explicables para elegir qué mostrar: no hay predicciones ni puntajes opacos, y las
 * reglas viven en `INSIGHT_RULES` para poder ajustarlas sin tocar la base. NO recalcula "qué llevar" (eso es
 * `get_branch_carry_plan`) ni el stock (el ledger).
 *
 * Cantidades: gramos para un producto WEIGHT, unidades para un UNIT (la misma columna del ledger). Los kilos y
 * las unidades nunca se suman entre sí: cada regla se evalúa por producto, con su propia unidad.
 */

export type InsightRpcRow = Database["public"]["Functions"]["get_branch_operations_summary"]["Returns"][number];

export interface InsightRow {
  productId: string;
  productName: string;
  unitType: StockUnit;
  current: number;
  soldPeriod: number;
  revenuePeriodCents: number;
  soldPrevious: number;
  sold7d: number;
  sold14d: number;
  lastSaleAt: string | null;
  lastInboundAt: string | null;
  mismatchTickets: number;
  mismatchQuantity: number;
}

export function toInsightRows(rows: readonly InsightRpcRow[]): InsightRow[] {
  return rows.map((row) => ({
    productId: row.product_id, productName: row.product_name, unitType: row.unit_type, current: row.current_quantity,
    soldPeriod: row.sold_period, revenuePeriodCents: row.revenue_period_cents, soldPrevious: row.sold_previous,
    sold7d: row.sold_7d, sold14d: row.sold_14d, lastSaleAt: row.last_sale_at, lastInboundAt: row.last_inbound_at,
    mismatchTickets: row.ledger_mismatch_tickets, mismatchQuantity: row.ledger_mismatch_quantity
  }));
}

/** Umbrales de las reglas. Cantidades crudas (gramos / unidades). */
export const INSIGHT_RULES = {
  /** Ventana de la venta promedio diaria y de la cobertura. */
  coverageWindowDays: 7,
  /** Ventana de «Baja rotación». */
  lowRotationWindowDays: 14,
  /** Un producto recién ingresado no se juzga: tiene que llevar al menos estos días en la sucursal. */
  lowRotationMinDaysSinceInbound: 7,
  /** «Stock alto para su venta»: con la venta de 14 días, alcanza para al menos estos días. */
  highCoverageDays: 30,
  /** Stock que vale la pena mirar: un resto de 200 g o 1 unidad no es «stock parado». */
  meaningfulStock: { WEIGHT: 1_000, UNIT: 2 } satisfies Record<StockUnit, number>,
  /** «Vende bien»: lo vendido en 7 días llega a esto (3 kg / 5 unidades). */
  sellsWell7d: { WEIGHT: 3_000, UNIT: 5 } satisfies Record<StockUnit, number>,
  /** Cobertura (días) por debajo de la cual un producto que vende bien merece una alerta. */
  lowCoverageDays: 2,
  criticalCoverageDays: 1
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Cobertura y formato
// ---------------------------------------------------------------------------------------------
/** Venta promedio diaria de los últimos 7 días (en la unidad cruda del producto). */
export function dailyAverage(sold7d: number): number {
  return sold7d / INSIGHT_RULES.coverageWindowDays;
}

/**
 * Días que alcanza el stock actual al ritmo de los últimos 7 días. `null` cuando no hubo ventas (no se divide por
 * cero). Un stock negativo cuenta como 0, igual que en «qué llevar».
 */
export function coverageDays(current: number, sold7d: number): number | null {
  if (sold7d <= 0) return null;
  return Math.max(current, 0) / dailyAverage(sold7d);
}

const KG_FORMATTER = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const DAYS_FORMATTER = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const DAYS_ROUNDED_FORMATTER = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

/** «≈ 1,3 días», «≈ 1 día», «≈ 12 días». */
export function formatCoverageDays(days: number): string {
  const text = days >= 10 ? DAYS_ROUNDED_FORMATTER.format(days) : DAYS_FORMATTER.format(days);
  return `≈ ${text} ${text === "1" ? "día" : "días"}`;
}

/** Texto de cobertura de un producto: «≈ 1,3 días» o, sin ventas en 7 días, «Sin ventas últimos 7 días». */
export function coverageText(current: number, sold7d: number): string {
  const days = coverageDays(current, sold7d);
  return days === null ? "Sin ventas últimos 7 días" : formatCoverageDays(days);
}

/** «5 kg/día» / «3,4 u/día» (promedio de los últimos 7 días). */
export function formatDailyAverage(sold7d: number, unitType: StockUnit): string {
  const average = dailyAverage(sold7d);
  if (unitType === "WEIGHT") return `${KG_FORMATTER.format(average / 1_000)} kg/día`;
  return `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(average)} u/día`;
}

/** «hace 3 horas», «hace 8 días»… Con `null` no hay dato. */
export function formatRelativeTime(instant: string | null, now: Date): string | null {
  if (!instant) return null;
  const elapsed = Math.max(0, now.getTime() - Date.parse(instant));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "hace instantes";
  if (minutes < 60) return `hace ${String(minutes)} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${String(hours)} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.floor(hours / 24);
  return `hace ${String(days)} ${days === 1 ? "día" : "días"}`;
}

/** Días enteros desde un instante (o `null` si no hay dato). */
export function daysSince(instant: string | null, now: Date): number | null {
  if (!instant) return null;
  return Math.floor(Math.max(0, now.getTime() - Date.parse(instant)) / DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Más vendidos
// ---------------------------------------------------------------------------------------------
export interface TopSeller {
  productId: string;
  productName: string;
  unitType: StockUnit;
  quantity: number;
  revenueCents: number;
  /** Variación porcentual de la cantidad contra el período anterior; `null` si no se puede comparar limpiamente. */
  trendPercent: number | null;
}

/**
 * Cuánto cambió la cantidad vendida contra el período anterior. `null` si el período anterior no vendió (no hay
 * base de comparación) o si se pidió ocultar la tendencia.
 */
export function trendPercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Los más vendidos del período elegido, ordenados por facturación (la semántica que ya tenía el bloque) y
 * mostrados con su cantidad. La tendencia compara la cantidad contra el período anterior de la misma longitud; con
 * `showTrend = false` (por ejemplo «hoy», que es un día incompleto) no se calcula.
 */
export function topSellers(rows: readonly InsightRow[], options: { limit?: number; showTrend?: boolean } = {}): TopSeller[] {
  const { limit = 5, showTrend = true } = options;
  return rows
    .filter((row) => row.soldPeriod > 0)
    .sort((a, b) => b.revenuePeriodCents - a.revenuePeriodCents || b.soldPeriod - a.soldPeriod || a.productName.localeCompare(b.productName, "es"))
    .slice(0, limit)
    .map((row) => ({
      productId: row.productId, productName: row.productName, unitType: row.unitType,
      quantity: row.soldPeriod, revenueCents: row.revenuePeriodCents,
      trendPercent: showTrend ? trendPercent(row.soldPeriod, row.soldPrevious) : null
    }));
}

// ---------------------------------------------------------------------------------------------
// Baja rotación
// ---------------------------------------------------------------------------------------------
export type LowRotationReason = "NO_SALES" | "HIGH_COVERAGE";

export interface LowRotationItem {
  productId: string;
  productName: string;
  unitType: StockUnit;
  reason: LowRotationReason;
  /** Etiqueta corta (nunca una orden): «Baja rotación» / «Stock alto para su venta». */
  label: string;
  current: number;
  sold14d: number;
  /** Última venta registrada (últimos 90 días); `null` = ninguna. */
  lastSaleAt: string | null;
  /** Días desde la última venta; `null` = sin ventas registradas en los últimos 90 días. */
  daysSinceLastSale: number | null;
  /** Cobertura con la venta de 14 días (sólo HIGH_COVERAGE). */
  coverageDays: number | null;
}

/**
 * Productos del surtido que razonablemente merecen atención por vender poco. Regla:
 *   1. tiene stock «con sentido» (≥ 1 kg / ≥ 2 u); un stock cero o negativo no es stock parado;
 *   2. el stock no es reciente: el último ingreso fue hace al menos 7 días (si acaba de llegar no hay evidencia);
 *   3. y además
 *        · NO vendió nada en los últimos 14 días  → «Baja rotación»; o
 *        · vendió algo pero lo que tiene alcanza para ≥ 30 días al ritmo de 14 días → «Stock alto para su venta».
 * Orden: primero los que no venden, del que hace más que no vende al que menos; después los de mayor cobertura.
 * Es información para decidir, no una orden: nunca dice «no mandar».
 */
export function lowRotation(rows: readonly InsightRow[], now: Date, options: { exclude?: ReadonlySet<string> } = {}): LowRotationItem[] {
  const items: LowRotationItem[] = [];
  for (const row of rows) {
    if (options.exclude?.has(row.productId)) continue;
    if (row.current < INSIGHT_RULES.meaningfulStock[row.unitType]) continue;
    const sinceInbound = daysSince(row.lastInboundAt, now);
    if (sinceInbound !== null && sinceInbound < INSIGHT_RULES.lowRotationMinDaysSinceInbound) continue;
    const base = {
      productId: row.productId, productName: row.productName, unitType: row.unitType,
      current: row.current, sold14d: row.sold14d, lastSaleAt: row.lastSaleAt, daysSinceLastSale: daysSince(row.lastSaleAt, now)
    };
    if (row.sold14d <= 0) {
      items.push({ ...base, reason: "NO_SALES", label: "Baja rotación", coverageDays: null });
      continue;
    }
    const coverage = row.current / (row.sold14d / INSIGHT_RULES.lowRotationWindowDays);
    if (coverage >= INSIGHT_RULES.highCoverageDays) items.push({ ...base, reason: "HIGH_COVERAGE", label: "Stock alto para su venta", coverageDays: coverage });
  }
  return items.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "NO_SALES" ? -1 : 1;
    if (a.reason === "NO_SALES") {
      // Sin última venta registrada (más de 90 días) = el que más hace que no vende.
      const left = a.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
      const right = b.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
      return right - left || b.current - a.current || a.productName.localeCompare(b.productName, "es");
    }
    return (b.coverageDays ?? 0) - (a.coverageDays ?? 0) || a.productName.localeCompare(b.productName, "es");
  });
}

// ---------------------------------------------------------------------------------------------
// Requiere atención
// ---------------------------------------------------------------------------------------------
export type AttentionKind = "NO_STOCK_SELLING" | "NEGATIVE" | "LOW_COVERAGE" | "INCONSISTENT" | "OUT_OF_STOCK" | "LOW_STOCK";

/** Una alerta de stock ya existente (`get_branch_stock_status`, ranking por mínimo configurado). */
export interface ConfiguredStockAlert {
  productId: string;
  productName: string;
  unitType: StockUnit;
  current: number;
  suggested: number;
  /** 0 = crítico (sin stock), 1 = alto (bajo mínimo). */
  rank: number;
}

export interface AttentionItem {
  productId: string;
  productName: string;
  unitType: StockUnit;
  kind: AttentionKind;
  severity: "critical" | "warning";
  headline: string;
  detail: string;
  /** Menor = más urgente. */
  priority: number;
}

function sellsWell(row: InsightRow): boolean {
  return row.sold7d >= INSIGHT_RULES.sellsWell7d[row.unitType];
}

function insightAttention(row: InsightRow): AttentionItem | null {
  const base = { productId: row.productId, productName: row.productName, unitType: row.unitType };
  const unit = row.unitType;
  const days = coverageDays(row.current, row.sold7d);
  const selling = sellsWell(row);
  const stockText = `Sistema: ${formatStockQuantity(row.current, unit)}`;
  const averageText = `vende ${formatDailyAverage(row.sold7d, unit)}`;
  if (row.current < 0) {
    return { ...base, kind: "NEGATIVE", severity: "critical", priority: selling ? 0 : 2, headline: "Stock negativo", detail: selling ? `${stockText} · ${averageText}` : `${stockText} · hubo ventas sin ingreso registrado` };
  }
  if (selling && row.current === 0) {
    return { ...base, kind: "NO_STOCK_SELLING", severity: "critical", priority: 0, headline: "Sin stock y vende bien", detail: `${averageText} · últimos 7 días` };
  }
  if (selling && days !== null && days < INSIGHT_RULES.lowCoverageDays) {
    const critical = days < INSIGHT_RULES.criticalCoverageDays;
    return { ...base, kind: "LOW_COVERAGE", severity: critical ? "critical" : "warning", priority: critical ? 1 : 3, headline: "Queda poco stock", detail: `${formatCoverageDays(days)} de venta · stock ${formatStockQuantity(row.current, unit)} · ${averageText}` };
  }
  if (row.mismatchTickets > 0) {
    const gap = row.mismatchQuantity === 0 ? "" : ` · el sistema muestra ${formatStockQuantity(Math.abs(row.mismatchQuantity), unit)} ${row.mismatchQuantity > 0 ? "de más" : "de menos"}`;
    return { ...base, kind: "INCONSISTENT", severity: "warning", priority: 2, headline: "Stock inconsistente", detail: `${String(row.mismatchTickets)} ${row.mismatchTickets === 1 ? "ticket" : "tickets"} sin el descuento esperado${gap} · últimos 14 días` };
  }
  return null;
}

/**
 * Qué mirar primero. Orden de prioridad:
 *   0  vende bien y está sin stock (o con stock negativo);
 *   1  vende bien y le queda menos de 1 día;
 *   2  stock negativo / inconsistencia entre ventas y ledger;
 *   3  vende bien y le quedan 1–2 días;
 *   4  agotado según el mínimo configurado;  5  bajo el mínimo configurado.
 * Un producto aparece una sola vez (con su motivo más urgente). Las reglas de venta/cobertura/inconsistencia NO se
 * aplican a la sucursal productiva (Central tiene reglas de stock especiales): ahí sólo valen las alertas
 * configuradas. «Producto con stock pero sin rotación» NO está acá: vive en «Baja rotación» (no se repite).
 */
export function stockAttention(rows: readonly InsightRow[], configured: readonly ConfiguredStockAlert[], options: { isProductionBranch: boolean }): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  const sold7dOf = new Map(rows.map((row) => [row.productId, row.sold7d]));
  if (!options.isProductionBranch) {
    for (const row of rows) {
      const item = insightAttention(row);
      if (item) items.set(item.productId, item);
    }
  }
  for (const alert of configured) {
    if (items.has(alert.productId)) continue;
    const out = alert.rank === 0;
    const unit = alert.unitType;
    const detail = alert.current < 0
      ? `Faltante: ${formatStockQuantity(Math.abs(alert.current), unit)}`
      : alert.current === 0 ? (alert.suggested > 0 ? `Reponer: ${formatStockQuantity(alert.suggested, unit)}` : "Sin stock en el sistema") : `Actual: ${formatStockQuantity(alert.current, unit)} · Reponer: ${formatStockQuantity(alert.suggested, unit)}`;
    items.set(alert.productId, { productId: alert.productId, productName: alert.productName, unitType: unit, kind: out ? "OUT_OF_STOCK" : "LOW_STOCK", severity: out ? "critical" : "warning", priority: out ? 4 : 5, headline: out ? "Sin stock" : "Bajo el mínimo", detail });
  }
  return [...items.values()].sort((a, b) =>
    a.priority - b.priority || (sold7dOf.get(b.productId) ?? 0) - (sold7dOf.get(a.productId) ?? 0) || a.productName.localeCompare(b.productName, "es"));
}
