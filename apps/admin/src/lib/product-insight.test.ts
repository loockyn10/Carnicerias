import { describe, expect, it } from "vitest";

import { buildProductInsight, reconcileLedger, toProductActivity, type ProductBranchActivity, type ProductModalData } from "./product-insight";
import type { AuditSalesCheck, StockAuditSummary } from "./stock-audit";

const check = (overrides: Partial<AuditSalesCheck>): AuditSalesCheck => ({
  completedTickets: 0, completedQuantity: 0, completedRevenueCents: 0, ledgerQuantityForCompleted: 0, difference: 0, pendingPaymentTickets: 0,
  pendingPaymentQuantity: 0, mismatchedSales: 0, mismatches: [], orphanSaleMovements: { count: 0, quantity: 0 }, ...overrides
});

function audit(overrides: Partial<StockAuditSummary>): StockAuditSummary {
  return {
    product: { id: "pm", name: "Pata muslo", sku: "PMU", unitType: "WEIGHT", active: true }, branch: { id: "av", name: "Avenida" },
    mode: "SINCE_LAST_INBOUND", timezone: "America/Argentina/Buenos_Aires", periodStart: "2026-10-07T12:32:00Z", periodEnd: null,
    anchor: { movementId: "m1", type: "PURCHASE", occurredAt: "2026-10-07T12:32:00Z", quantity: 15_000 },
    openingQuantity: 0, windowQuantity: 0, closingQuantity: 0, afterPeriodQuantity: 0, currentQuantity: 0, movementCount: 0, byType: [], sales: null, computedAt: "2026-10-10T15:00:00Z", ...overrides
  };
}

describe("reconcileLedger — el caso de Pata Muslo", () => {
  // Entró 22,5 kg, los tickets venden 9 kg pero el ledger sólo descontó 6 kg → el sistema muestra 16,5 kg y debería mostrar 13,5.
  const pataMuslo = audit({
    currentQuantity: 16_500, closingQuantity: 16_500, windowQuantity: 16_500,
    byType: [{ type: "PURCHASE", count: 2, quantity: 22_500 }, { type: "SALE", count: 3, quantity: -6_000 }],
    sales: check({ completedTickets: 4, completedQuantity: 9_000, ledgerQuantityForCompleted: 6_000, difference: 3_000, mismatchedSales: 1 })
  });

  it("arma Ingresó / Vendido / Debería quedar / Stock ledger y detecta la diferencia de 3 kg", () => {
    expect(reconcileLedger(pataMuslo)).toEqual({
      before: 0, entered: 22_500, soldByTickets: 9_000, waste: 0, adjustments: 0, otherOutflows: 0,
      expected: 13_500, ledger: 16_500, difference: 3_000, hasDiscrepancy: true, mismatchedTickets: 1
    });
  });

  it("incluye mermas, ajustes y salidas por transferencia, y el stock de antes del ingreso", () => {
    const summary = audit({
      openingQuantity: 2_000, currentQuantity: 12_000,
      byType: [{ type: "PURCHASE", count: 1, quantity: 15_000 }, { type: "SALE", count: 2, quantity: -4_000 }, { type: "WASTE", count: 1, quantity: -500 }, { type: "ADJUSTMENT_POSITIVE", count: 1, quantity: 300 }, { type: "TRANSFER_OUT", count: 1, quantity: -800 }],
      sales: check({ completedQuantity: 4_000, ledgerQuantityForCompleted: 4_000 })
    });
    const result = reconcileLedger(summary);
    expect(result).toMatchObject({ before: 2_000, entered: 15_000, soldByTickets: 4_000, waste: 500, adjustments: 300, otherOutflows: 800, expected: 12_000, ledger: 12_000, difference: 0, hasDiscrepancy: false });
  });

  it("un ticket con pago pendiente ya reservó stock: cuenta como vendido", () => {
    const summary = audit({ currentQuantity: 8_000, byType: [{ type: "PURCHASE", count: 1, quantity: 10_000 }, { type: "SALE", count: 2, quantity: -2_000 }], sales: check({ completedQuantity: 1_500, pendingPaymentQuantity: 500, ledgerQuantityForCompleted: 1_500 }) });
    expect(reconcileLedger(summary)).toMatchObject({ soldByTickets: 2_000, expected: 8_000, difference: 0, hasDiscrepancy: false });
  });

  it("aunque el neto dé 0, tickets que no coinciden (uno de más, otro de menos) siguen siendo una discrepancia", () => {
    const summary = audit({ currentQuantity: 5_000, byType: [{ type: "PURCHASE", count: 1, quantity: 10_000 }, { type: "SALE", count: 2, quantity: -5_000 }], sales: check({ completedQuantity: 5_000, ledgerQuantityForCompleted: 5_000, mismatchedSales: 2 }) });
    expect(reconcileLedger(summary)).toMatchObject({ difference: 0, hasDiscrepancy: true, mismatchedTickets: 2 });
  });

  it("un movimiento de venta sin línea del producto en su ticket también cuenta como discrepancia", () => {
    const summary = audit({ currentQuantity: 5_000, byType: [{ type: "PURCHASE", count: 1, quantity: 10_000 }, { type: "SALE", count: 1, quantity: -5_000 }], sales: check({ completedQuantity: 5_000, ledgerQuantityForCompleted: 5_000, orphanSaleMovements: { count: 1, quantity: 400 } }) });
    expect(reconcileLedger(summary)?.hasDiscrepancy).toBe(true);
  });

  it("sin permiso de ventas no hay conciliación (se muestra sólo lo del ledger)", () => {
    expect(reconcileLedger(audit({ sales: null }))).toBeNull();
  });

  it("UNIT: la misma cuenta, en unidades", () => {
    const summary = audit({ product: { id: "h", name: "Hamburguesa", sku: null, unitType: "UNIT", active: true }, currentQuantity: 94, byType: [{ type: "PURCHASE", count: 1, quantity: 100 }, { type: "SALE", count: 1, quantity: -6 }], sales: check({ completedQuantity: 6, ledgerQuantityForCompleted: 6 }) });
    expect(reconcileLedger(summary)).toMatchObject({ entered: 100, soldByTickets: 6, expected: 94, difference: 0 });
  });
});

describe("buildProductInsight", () => {
  const activity: ProductBranchActivity[] = [
    { branchId: "ce", branchName: "Central", isProduction: true, unitType: "WEIGHT", current: 100_000, sold7d: 1_000, lastSaleAt: null },
    { branchId: "av", branchName: "Avenida", isProduction: false, unitType: "WEIGHT", current: 16_500, sold7d: 31_400, lastSaleAt: "2026-10-10T12:00:00Z" },
    { branchId: "ja", branchName: "Janssen", isProduction: false, unitType: "WEIGHT", current: 4_000, sold7d: 17_200, lastSaleAt: "2026-10-10T09:00:00Z" }
  ];
  const data: ProductModalData = { audit: audit({ currentQuantity: 16_500, sales: check({}) }), activity };

  it("juntas las cifras de la sucursal: stock del ledger, vendido 7 días, promedio, cobertura, última venta y último ingreso", () => {
    const insight = buildProductInsight(data, "av");
    expect(insight).toMatchObject({ stock: 16_500, sold7d: 31_400, lastSaleAt: "2026-10-10T12:00:00Z", ledgerMode: "SINCE_LAST_INBOUND", lastInbound: { quantity: 15_000, type: "PURCHASE" } });
    expect(insight.dailyAverage).toBeCloseTo(4_485.7, 1);
    expect(insight.coverageDays).toBeCloseTo(3.68, 2);
  });

  it("la comparación lista las otras sucursales y deja afuera a la actual y a la productiva", () => {
    expect(buildProductInsight(data, "av").others.map((other) => other.branchName)).toEqual(["Janssen"]);
    expect(buildProductInsight(data, "ja").others.map((other) => other.branchName)).toEqual(["Avenida"]);
  });

  it("sin ventas en 7 días no hay cobertura (no se divide por cero) ni última venta", () => {
    const quiet: ProductModalData = { audit: audit({ currentQuantity: 5_000, sales: check({}) }), activity: [{ branchId: "av", branchName: "Avenida", isProduction: false, unitType: "WEIGHT", current: 5_000, sold7d: 0, lastSaleAt: null }] };
    const insight = buildProductInsight(quiet, "av");
    expect(insight.coverageDays).toBeNull();
    expect(insight.lastSaleAt).toBeNull();
    expect(insight.dailyAverage).toBe(0);
  });

  it("un producto sin ningún ingreso registrado no inventa «último ingreso»", () => {
    const insight = buildProductInsight({ audit: audit({ mode: "ALL_HISTORY", anchor: null, sales: check({}) }), activity }, "av");
    expect(insight.lastInbound).toBeNull();
    expect(insight.ledgerMode).toBe("ALL_HISTORY");
  });
});

describe("toProductActivity", () => {
  it("convierte las filas de get_product_branch_activity", () => {
    expect(toProductActivity([{ branch_id: "av", branch_name: "Avenida", is_production: false, unit_type: "UNIT", current_quantity: 94, sold_7d: 6, last_sale_at: null }])).toEqual([
      { branchId: "av", branchName: "Avenida", isProduction: false, unitType: "UNIT", current: 94, sold7d: 6, lastSaleAt: null }
    ]);
  });
});
