import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AuditMovementsPage, AuditSalesCheck, StockAuditSummary } from "../lib/stock-audit";

vi.mock("../app/admin/actions", () => ({ applyPhysicalCountAdjustmentAction: () => Promise.resolve({ ok: true, difference: 0 }) }));

import { AuditMovementsTable, AuditSalesCheckCard, AuditSummaryCard } from "./stock-audit-panels";
import { ProductSalesSummary } from "./product-sales-summary";
import { StockPhysicalCount } from "./stock-physical-count";

const TZ = "America/Argentina/Buenos_Aires";

const cleanSales: AuditSalesCheck = {
  completedTickets: 37, completedQuantity: 25_400, completedRevenueCents: 123_456_00, ledgerQuantityForCompleted: 25_400, difference: 0,
  pendingPaymentTickets: 0, pendingPaymentQuantity: 0, mismatchedSales: 0, mismatches: [], orphanSaleMovements: { count: 0, quantity: 0 }
};

// El caso real: Avenida / Pata Muslo. Entró 42 kg, se vendieron 25,4 kg => el sistema dice 16,6 kg.
const summary: StockAuditSummary = {
  product: { id: "p1", name: "Pata Muslo de Pollo", sku: "PMU", unitType: "WEIGHT", active: true },
  branch: { id: "b1", name: "Avenida" },
  mode: "SINCE_LAST_INBOUND", timezone: TZ,
  periodStart: "2026-10-02T13:00:00Z", periodEnd: null,
  anchor: { movementId: "m1", type: "TRANSFER_IN", occurredAt: "2026-10-02T13:00:00Z", quantity: 42_000 },
  openingQuantity: 0, windowQuantity: 16_600, closingQuantity: 16_600, afterPeriodQuantity: 0, currentQuantity: 16_600, movementCount: 38,
  byType: [{ type: "TRANSFER_IN", count: 1, quantity: 42_000 }, { type: "SALE", count: 37, quantity: -25_400 }],
  sales: cleanSales, computedAt: "2026-10-09T15:00:00Z"
};

describe("AuditSummaryCard", () => {
  const html = renderToStaticMarkup(<AuditSummaryCard summary={summary} timeZone={TZ} />);

  it("muestra el resumen corto del caso real: entró 42, vendido 25,4 y resultado 16,6", () => {
    const quick = html.slice(html.indexOf('data-testid="audit-quick-summary"'), html.indexOf("</dl>"));
    expect(quick).toContain("42,000 kg");
    expect(quick).toContain("25,400 kg");
    expect(quick).toContain("16,600 kg");
    expect(quick).toContain("Entró");
    expect(quick).toContain("Vendido (neto de anulaciones)");
  });

  it("la fórmula va de stock inicial a stock teórico actual con cada grupo de movimientos", () => {
    expect(html).toContain("Stock antes del ingreso");
    for (const label of ["Ingresos / recepciones", "Transferencias recibidas", "Devoluciones / anulaciones de venta", "Ventas", "Transferencias enviadas", "Mermas", "Ajustes de conteo (+)", "Ajustes de conteo (−)"]) expect(html).toContain(label);
    expect(html).toContain("+42,000 kg");
    expect(html).toContain("-25,400 kg");
    expect(html).toContain("= Stock al cierre del período");
    expect(html).toMatch(/data-testid="audit-current">16,600 kg</);
  });

  it("explica desde dónde se cuenta (el último ingreso, en hora de la organización)", () => {
    expect(html).toContain("Desde el último ingreso: 02/10/2026 10:00");
    expect(html).toContain("Transferencia recibida +42,000 kg");
  });

  it("si el período no llega a hoy muestra los movimientos posteriores y sigue cerrando en el actual", () => {
    const partial = renderToStaticMarkup(<AuditSummaryCard summary={{ ...summary, mode: "RANGE", periodStart: "2026-10-03T03:00:00Z", periodEnd: "2026-10-06T03:00:00Z", openingQuantity: 42_000, windowQuantity: -23_400, closingQuantity: 18_600, afterPeriodQuantity: -2_000, anchor: null }} timeZone={TZ} />);
    expect(partial).toContain("Stock al inicio del período");
    expect(partial).toContain("Movimientos posteriores al período");
    expect(partial).toContain("-2,000 kg");
    expect(partial).toContain("Del 03/10/2026 al 05/10/2026");
  });

  it("un producto por unidad se muestra en unidades, nunca en kg", () => {
    const units = renderToStaticMarkup(<AuditSummaryCard summary={{ ...summary, product: { ...summary.product, unitType: "UNIT" }, openingQuantity: 0, windowQuantity: 85, closingQuantity: 85, currentQuantity: 85, byType: [{ type: "PURCHASE", count: 1, quantity: 100 }, { type: "SALE", count: 3, quantity: -15 }] }} timeZone={TZ} />);
    expect(units).toContain("85 u");
    expect(units).not.toContain(" kg");
  });

  it("sin ingresos registrados lo dice y muestra todo el historial", () => {
    const all = renderToStaticMarkup(<AuditSummaryCard summary={{ ...summary, mode: "ALL_HISTORY", periodStart: null, anchor: null }} timeZone={TZ} />);
    expect(all).toContain("no tiene ingresos registrados");
    expect(all).toContain("Stock inicial");
  });
});

describe("AuditSalesCheckCard", () => {
  it("coincide: confirma que las ventas descontaron lo vendido", () => {
    const html = renderToStaticMarkup(<AuditSalesCheckCard summary={summary} timeZone={TZ} />);
    expect(html).toContain("Coincide");
    expect(html).toContain("descontaron exactamente lo vendido");
    expect(html).not.toContain('role="alert"');
  });

  it("25,4 kg vendidos contra 23,9 kg descontados: alerta con la diferencia y el ticket, sin corregir nada", () => {
    const html = renderToStaticMarkup(<AuditSalesCheckCard summary={{ ...summary, sales: {
      ...cleanSales, ledgerQuantityForCompleted: 23_900, difference: 1_500, mismatchedSales: 1,
      mismatches: [{ saleId: "abcdef12-3456", status: "COMPLETED", completedAt: "2026-10-08T22:00:00Z", saleQuantity: 3_000, ledgerQuantity: 1_500, expectedQuantity: 3_000 }]
    } }} timeZone={TZ} />);
    expect(html).toContain("Hay diferencias");
    expect(html).toContain('role="alert"');
    expect(html).toContain("dicen 25,400 kg y el ledger descontó 23,900 kg");
    expect(html).toContain("+1,500 kg");
    expect(html).toContain("no se corrigió nada");
    expect(html).toContain("abcdef12");
    expect(html).toContain("08/10/2026 19:00");
  });

  it("sin sales.read no se renderiza", () => {
    expect(renderToStaticMarkup(<AuditSalesCheckCard summary={{ ...summary, sales: null }} timeZone={TZ} />)).toBe("");
  });

  it("avisa de los SALE huérfanos aunque los totales coincidan", () => {
    const html = renderToStaticMarkup(<AuditSalesCheckCard summary={{ ...summary, sales: { ...cleanSales, orphanSaleMovements: { count: 2, quantity: 800 } } }} timeZone={TZ} />);
    expect(html).toContain("Hay diferencias");
    expect(html).toContain("2 movimientos de venta (0,800 kg)");
  });
});

describe("AuditMovementsTable", () => {
  const page: AuditMovementsPage = {
    total: 120, openingQuantity: 0, limit: 50, offset: 50, newestFirst: false,
    rows: [
      { id: "m1", occurredAt: "2026-10-08T13:15:00Z", type: "TRANSFER_IN", quantity: 20_000, balanceAfter: 20_000, reason: null, operatorName: "Ana", saleId: null, saleStatus: null, transferId: "t", counterpartBranchName: "Central", stockOperationId: null, supplier: null, productionBatchId: null },
      { id: "m2", occurredAt: "2026-10-08T14:42:00Z", type: "SALE", quantity: -1_350, balanceAfter: 18_650, reason: null, operatorName: "Luis", saleId: "abcdef12-0000", saleStatus: "COMPLETED", transferId: null, counterpartBranchName: null, stockOperationId: null, supplier: null, productionBatchId: null }
    ]
  };
  const html = renderToStaticMarkup(<AuditMovementsTable hrefFor={({ page: target, newestFirst }) => `/m?page=${String(target)}&n=${String(newestFirst)}`} page={page} summary={summary} timeZone={TZ} />);

  it("muestra fecha/hora local, tipo, cantidad con signo, saldo resultante, origen y operador", () => {
    expect(html).toContain("08/10/2026 10:15");
    expect(html).toContain("Transferencia recibida");
    expect(html).toContain("+20,000 kg");
    expect(html).toContain("-1,350 kg");
    expect(html).toContain("18,650 kg");
    expect(html).toContain("Desde Central");
    expect(html).toContain("Ticket abcdef12");
    expect(html).toContain("Ana");
    expect(html).toContain("Luis");
  });

  it("pagina: dice qué tramo se ve y enlaza anterior/siguiente sin perder el orden", () => {
    expect(html).toContain("51–100 de 120 movimientos");
    expect(html).toContain("Página 2 de 3");
    expect(html).toContain('href="/m?page=1&amp;n=false"');
    expect(html).toContain('href="/m?page=3&amp;n=false"');
    expect(html).toContain("Más recientes primero");
  });

  it("sin movimientos lo dice", () => {
    const empty = renderToStaticMarkup(<AuditMovementsTable hrefFor={() => "/m"} page={{ ...page, total: 0, offset: 0, rows: [] }} summary={summary} timeZone={TZ} />);
    expect(empty).toContain("No hay movimientos en este período.");
  });
});

describe("ProductSalesSummary", () => {
  const product = { id: "p1", name: "Pata Muslo de Pollo", unitType: "WEIGHT" as const, active: true };
  const range = { from: "2026-10-02", to: "2026-10-09" };

  it("una sucursal: kg vendidos, importe, tickets y el enlace a stock y movimientos con el mismo rango", () => {
    const html = renderToStaticMarkup(<ProductSalesSummary product={product} range={range} rows={[{ branchId: "b1", branchName: "Avenida", quantity: 25_400, revenueCents: 123_456_00, tickets: 37 }]} singleBranch />);
    expect(html).toContain("Pata Muslo de Pollo");
    expect(html).toContain("25,400 kg");
    expect(html).toContain("$ 123.456");
    expect(html).toContain(">37<");
    expect(html).toContain("Avenida");
    expect(html).toContain("02/10/2026 – 09/10/2026");
    expect(html).toContain("sólo ventas completadas");
    expect(html).toContain('href="/admin/branch-stock/movements?branch=b1&amp;product=p1&amp;mode=range&amp;from=2026-10-02&amp;to=2026-10-09"');
  });

  it("producto por unidad: unidades, no kg", () => {
    const html = renderToStaticMarkup(<ProductSalesSummary product={{ ...product, unitType: "UNIT" }} range={range} rows={[{ branchId: "b1", branchName: "Avenida", quantity: 15, revenueCents: 150_000, tickets: 3 }]} singleBranch />);
    expect(html).toContain("15 u");
    expect(html).not.toContain(" kg");
  });

  it("todas las sucursales: una fila por sucursal, total y un enlace por sucursal", () => {
    const html = renderToStaticMarkup(<ProductSalesSummary product={product} range={range} rows={[
      { branchId: "b1", branchName: "Avenida", quantity: 25_400, revenueCents: 250_000, tickets: 4 },
      { branchId: "b2", branchName: "Janssen", quantity: 3_000, revenueCents: 30_000, tickets: 1 }
    ]} singleBranch={false} />);
    expect(html).toContain("Todas las sucursales");
    expect(html).toContain("28,400 kg");
    expect(html).toContain("Total");
    expect(html.match(/Ver stock y movimientos/g)).toHaveLength(2);
    expect(html).toContain("branch=b2");
  });

  it("un rango de un solo día se muestra como una fecha", () => {
    const html = renderToStaticMarkup(<ProductSalesSummary product={product} range={{ from: "2026-10-09", to: "2026-10-09" }} rows={[{ branchId: "b1", branchName: "Avenida", quantity: 0, revenueCents: 0, tickets: 0 }]} singleBranch />);
    expect(html).toContain("09/10/2026 ·");
    expect(html).toContain("0,000 kg");
  });
});

describe("StockPhysicalCount", () => {
  it("de entrada no muestra ninguna diferencia ni botón de ajuste, y aclara que no modifica nada", () => {
    const html = renderToStaticMarkup(<StockPhysicalCount branchId="b1" productId="p1" systemQuantity={16_600} unitType="WEIGHT" />);
    expect(html).toContain("No se modifica nada");
    expect(html).not.toContain("physical-count-result");
    expect(html).not.toContain("Registrar ajuste");
    expect(html).toContain("Stock físico (kg)");
  });

  it("un producto por unidad pide unidades", () => {
    expect(renderToStaticMarkup(<StockPhysicalCount branchId="b1" productId="p1" systemQuantity={10} unitType="UNIT" />)).toContain("Stock físico (u)");
  });
});
