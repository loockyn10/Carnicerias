import type { StockUnit } from "@carnicerias/business-logic";

import { formatRelativeTime, lowRotation, stockAttention, topSellers, type AttentionItem, type ConfiguredStockAlert, type InsightRow, type TopSeller } from "./branch-insights";
import { topCarryRows, type CarryPlanReport, type CarryPlanRow } from "./carry-plan";
import { formatIsoDate, type SalesRange } from "./date-range";

/**
 * Datos del bloque «Qué está pasando» del Resumen de sucursal, ya elegidos y serializables (el servidor los arma, el
 * cliente sólo los dibuja). Reúne las reglas de `branch-insights` con el informe «qué llevar» que ya existe.
 *
 * Qué período usa cada bloque (se lo dice al usuario en la pantalla):
 *   · Más vendidos      → el período elegido arriba (Hoy / Ayer / 7 días / 30 días / Desde-Hasta);
 *   · Qué llevar        → SIEMPRE los últimos 7 días (es la ventana de `get_branch_carry_plan`);
 *   · Baja rotación     → últimos 14 días;
 *   · Requiere atención → ventas y cobertura de los últimos 7 días, diferencias de ledger de los últimos 14.
 */

/** Cuántos productos muestra cada bloque en el Resumen; el resto queda detrás de «Ver todos». */
export const BOARD_LIMIT = 5;

export interface LowRotationView {
  productId: string;
  productName: string;
  unitType: StockUnit;
  label: string;
  reason: "NO_SALES" | "HIGH_COVERAGE";
  current: number;
  sold14d: number;
  /** «hace 8 días» o «Sin ventas en los últimos 90 días». */
  lastSaleText: string;
}

export interface CarryBlock {
  /** Las primeras filas que necesitan carga (vista compacta). */
  preview: CarryPlanRow[];
  /** Cuántos productos del surtido necesitan carga en total. */
  needing: number;
  calculatedAt: string;
}

export interface BranchBoardData {
  /** «Hoy», «Últimos 7 días», «01/10/2026 – 07/10/2026»… */
  periodTag: string;
  topSellers: TopSeller[];
  topSellersTotal: number;
  /** null en la sucursal productiva (la reposición se calcula hacia las demás). */
  carry: CarryBlock | { error: string } | null;
  lowRotation: { items: LowRotationView[]; all: LowRotationView[] } | null;
  attention: { items: AttentionItem[]; all: AttentionItem[] };
}

/** Cómo se llama el período elegido en el título del bloque «Más vendidos». */
export function periodTag(range: SalesRange): string {
  switch (range.preset) {
    case "today": return "Hoy";
    case "yesterday": return "Ayer";
    case "7d": return "Últimos 7 días";
    case "30d": return "Últimos 30 días";
    case "custom": return range.from === range.to ? formatIsoDate(range.from) : `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
  }
}

export function buildBranchBoard(input: {
  rows: readonly InsightRow[];
  configuredAlerts: readonly ConfiguredStockAlert[];
  /** null = la sucursal es la productiva y no se calcula «qué llevar»; un string = el motivo por el que no se pudo calcular. */
  carry: CarryPlanReport | string | null;
  isProductionBranch: boolean;
  range: SalesRange;
  now: Date;
}): BranchBoardData {
  const { rows, configuredAlerts, carry, isProductionBranch, range, now } = input;
  // «Hoy» es un día incompleto: compararlo con el día anterior entero engaña, así que no se muestra tendencia.
  const sellers = topSellers(rows, { limit: Number.MAX_SAFE_INTEGER, showTrend: range.preset !== "today" });
  const attentionAll = stockAttention(rows, configuredAlerts, { isProductionBranch });
  const rotationAll = isProductionBranch
    ? null
    : lowRotation(rows, now, { exclude: new Set(attentionAll.map((item) => item.productId)) }).map((item): LowRotationView => ({
      productId: item.productId, productName: item.productName, unitType: item.unitType, label: item.label, reason: item.reason, current: item.current, sold14d: item.sold14d,
      lastSaleText: item.lastSaleAt ? `Última venta: ${formatRelativeTime(item.lastSaleAt, now) ?? ""}` : "Sin ventas en los últimos 90 días"
    }));
  return {
    periodTag: periodTag(range),
    topSellers: sellers.slice(0, BOARD_LIMIT),
    topSellersTotal: sellers.length,
    carry: carry === null ? null : typeof carry === "string" ? { error: carry } : {
      preview: topCarryRows(carry.rows, BOARD_LIMIT), needing: carry.rows.filter((row) => row.suggestedQuantity > 0).length, calculatedAt: carry.calculatedAt
    },
    lowRotation: rotationAll ? { items: rotationAll.slice(0, BOARD_LIMIT), all: rotationAll } : null,
    attention: { items: attentionAll.slice(0, BOARD_LIMIT), all: attentionAll }
  };
}
