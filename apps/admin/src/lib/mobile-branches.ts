import type { Database } from "@carnicerias/database";

/**
 * «Ver sucursales» en el celular: una tarjeta por sucursal con lo que Fran quiere saber de un vistazo. NO calcula nada propio: junta lo que ya
 * devuelven `get_branch_sales_summary` (ventas, kg, tickets), `get_branch_profitability_summary` (ganancia bruta y margen: las mismas fórmulas
 * que Rentabilidad) y `get_branch_stock_summary` (alertas). Las sucursales para vender van primero; la productiva (el depósito), al final.
 */

type SalesRow = Database["public"]["Functions"]["get_branch_sales_summary"]["Returns"][number];
type ProfitRow = Database["public"]["Functions"]["get_branch_profitability_summary"]["Returns"][number];
type StockRow = Database["public"]["Functions"]["get_branch_stock_summary"]["Returns"][number];

export interface BranchCardData {
  id: string;
  name: string;
  isProduction: boolean;
  revenueCents: number;
  grams: number;
  units: number;
  tickets: number;
  /** `null` = la ganancia no se pudo calcular (sin permiso o error): la tarjeta muestra «—», nunca un 0 inventado. */
  profitCents: number | null;
  marginBps: number | null;
  /** Productos vendidos sin costo conocido en el período: la ganancia puede estar incompleta. */
  missingCostItems: number;
  /** Productos agotados + por debajo del mínimo. */
  alerts: number;
  outOfStock: number;
}

export function buildBranchCards(input: {
  branches: readonly { id: string; name: string }[];
  productionBranchId: string | null;
  sales: readonly SalesRow[];
  /** `null` = no disponible. */
  profit: readonly ProfitRow[] | null;
  stock: readonly StockRow[];
}): BranchCardData[] {
  const salesByBranch = new Map(input.sales.map((row) => [row.branch_id, row]));
  const profitByBranch = new Map((input.profit ?? []).map((row) => [row.branch_id, row]));
  const stockByBranch = new Map(input.stock.map((row) => [row.branch_id, row]));
  return input.branches.map((branch): BranchCardData => {
    const sales = salesByBranch.get(branch.id);
    const profit = input.profit === null ? undefined : profitByBranch.get(branch.id);
    const stock = stockByBranch.get(branch.id);
    return {
      id: branch.id, name: branch.name, isProduction: branch.id === input.productionBranchId,
      revenueCents: sales?.total_cents ?? 0, grams: sales?.weight_grams ?? 0, units: sales?.units ?? 0, tickets: sales?.sales_count ?? 0,
      profitCents: input.profit === null ? null : profit?.gross_profit_cents ?? 0,
      marginBps: input.profit === null ? null : profit && profit.costed_revenue_cents > 0 ? profit.gross_margin_bps : null,
      missingCostItems: profit?.missing_cost_items ?? 0,
      alerts: (stock?.out_of_stock_count ?? 0) + (stock?.low_stock_count ?? 0), outOfStock: stock?.out_of_stock_count ?? 0
    };
  }).sort((a, b) => Number(a.isProduction) - Number(b.isProduction) || a.name.localeCompare(b.name, "es"));
}

/** «2 alertas» / «1 alerta» / «Sin alertas». */
export function alertsText(alerts: number): string {
  if (alerts === 0) return "Sin alertas";
  return `${String(alerts)} ${alerts === 1 ? "alerta" : "alertas"}`;
}
