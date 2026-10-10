import type { StockUnit } from "@carnicerias/business-logic";
import type { Database } from "@carnicerias/database";

import { coverageDays, dailyAverage } from "./branch-insights";
import { quickSummary, salesCheckHasDiscrepancy, type StockAuditSummary } from "./stock-audit";

/**
 * Modal de producto del Resumen de sucursal: «qué pasa con ESTE producto en ESTA sucursal». No calcula stock ni
 * ventas por su cuenta: junta la auditoría de ledger que ya existe (`get_stock_audit_summary`, desde el último
 * ingreso) con el estado de las demás sucursales (`get_product_branch_activity`, últimos 7 días) y ordena los
 * números para leerlos.
 */

export type ProductActivityRpcRow = Database["public"]["Functions"]["get_product_branch_activity"]["Returns"][number];

export interface ProductBranchActivity {
  branchId: string;
  branchName: string;
  isProduction: boolean;
  unitType: StockUnit;
  current: number;
  sold7d: number;
  lastSaleAt: string | null;
}

export function toProductActivity(rows: readonly ProductActivityRpcRow[]): ProductBranchActivity[] {
  return rows.map((row) => ({
    branchId: row.branch_id, branchName: row.branch_name, isProduction: row.is_production, unitType: row.unit_type,
    current: row.current_quantity, sold7d: row.sold_7d, lastSaleAt: row.last_sale_at
  }));
}

export interface ProductModalData {
  audit: StockAuditSummary;
  activity: ProductBranchActivity[];
}

/** Cómo cierran las cuentas desde el último ingreso (sólo si el usuario puede ver ventas). */
export interface ProductLedgerReconciliation {
  /** Stock del ledger justo antes del último ingreso. */
  before: number;
  entered: number;
  /** Lo que dicen los tickets (COMPLETED + pago pendiente, que ya reserva stock). */
  soldByTickets: number;
  waste: number;
  adjustments: number;
  otherOutflows: number;
  /** Lo que debería quedar si cada ticket hubiera descontado lo vendido. */
  expected: number;
  /** Lo que informa el ledger (stock del sistema). */
  ledger: number;
  /** ledger - expected: positivo = el sistema muestra de más (se vendió más de lo que se descontó). */
  difference: number;
  /** Hay tickets, o movimientos de venta sin línea, que no coinciden (aunque el neto sea 0). */
  hasDiscrepancy: boolean;
  mismatchedTickets: number;
}

export interface ProductInsight {
  stock: number;
  sold7d: number;
  dailyAverage: number;
  /** Días de cobertura al ritmo de 7 días; null = sin ventas en 7 días. */
  coverageDays: number | null;
  lastSaleAt: string | null;
  lastInbound: { quantity: number; at: string; type: string } | null;
  /** Desde cuándo se cuentan las cifras del ledger. */
  ledgerMode: StockAuditSummary["mode"];
  reconciliation: ProductLedgerReconciliation | null;
  /** Las demás sucursales que lo tienen en su surtido (sin la sucursal productiva, que no aporta a la comparación). */
  others: ProductBranchActivity[];
}

export function reconcileLedger(audit: StockAuditSummary): ProductLedgerReconciliation | null {
  const check = audit.sales;
  if (!check) return null;
  const quick = quickSummary(audit.byType);
  const soldByTickets = check.completedQuantity + check.pendingPaymentQuantity;
  const expected = audit.openingQuantity + quick.entered - soldByTickets - quick.waste + quick.adjustments - quick.otherOutflows;
  const difference = audit.currentQuantity - expected;
  return {
    before: audit.openingQuantity, entered: quick.entered, soldByTickets, waste: quick.waste, adjustments: quick.adjustments,
    otherOutflows: quick.otherOutflows, expected, ledger: audit.currentQuantity, difference,
    hasDiscrepancy: difference !== 0 || salesCheckHasDiscrepancy(check), mismatchedTickets: check.mismatchedSales
  };
}

export function buildProductInsight(data: ProductModalData, branchId: string): ProductInsight {
  const { audit, activity } = data;
  const own = activity.find((row) => row.branchId === branchId);
  const sold7d = own?.sold7d ?? 0;
  return {
    stock: audit.currentQuantity,
    sold7d,
    dailyAverage: dailyAverage(sold7d),
    coverageDays: coverageDays(audit.currentQuantity, sold7d),
    lastSaleAt: own?.lastSaleAt ?? null,
    lastInbound: audit.anchor ? { quantity: audit.anchor.quantity, at: audit.anchor.occurredAt, type: audit.anchor.type } : null,
    ledgerMode: audit.mode,
    reconciliation: reconcileLedger(audit),
    others: activity.filter((row) => row.branchId !== branchId && !row.isProduction)
  };
}
