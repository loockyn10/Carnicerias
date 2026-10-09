import { describe, expect, it } from "vitest";

import {
  MOVEMENT_TYPE_LABELS, auditPeriodDateRange, describeMovementReference, formatSignedQuantity, groupAuditMovements, parseAuditMovementsPage,
  parseStockAuditSummary, periodRpcArgs, physicalCountDifference, productSalesHref, quickSummary, resolveAuditPeriod,
  salesCheckHasDiscrepancy, stockAuditHref, type AuditMovement, type AuditSalesCheck, type AuditTypeTotal, type StockAuditSummary, type StockMovementType
} from "./stock-audit";

const ALL_TYPES = Object.keys(MOVEMENT_TYPE_LABELS) as StockMovementType[];
const total = (type: string, quantity: number, count = 1): AuditTypeTotal => ({ type, count, quantity });

describe("tipos reales del ledger", () => {
  it("todos los tipos del enum de la base tienen etiqueta y pertenecen a un grupo conocido (nada se agrupa como «Otros»)", () => {
    for (const type of ALL_TYPES) expect(MOVEMENT_TYPE_LABELS[type], type).toBeDefined();
    const rows = groupAuditMovements(ALL_TYPES.map((type) => total(type, 1)));
    expect(rows.some((row) => row.label.startsWith("Otros movimientos"))).toBe(false);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(ALL_TYPES.length);
  });

  it("un tipo futuro que no esté en el mapa no se pierde: aparece como «Otros movimientos» y la suma sigue cerrando", () => {
    const byType = [total("PURCHASE", 1000), total("FUTURE_TYPE", -250)];
    const rows = groupAuditMovements(byType);
    expect(rows.find((row) => row.key === "FUTURE_TYPE")?.label).toBe("Otros movimientos (FUTURE_TYPE)");
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(750);
  });
});

describe("agrupación del resumen", () => {
  it("la suma de los grupos es siempre la suma de los tipos y se muestran las filas habituales aunque estén en cero", () => {
    const byType = [total("TRANSFER_IN", 42_000), total("SALE", -25_400, 4)];
    const rows = groupAuditMovements(byType);
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(16_600);
    expect(rows.map((row) => row.key)).toEqual(["RECEPTIONS", "TRANSFERS_IN", "RETURNS", "SALES", "TRANSFERS_OUT", "WASTE", "ADJUSTMENT_POSITIVE", "ADJUSTMENT_NEGATIVE"]);
    expect(rows.find((row) => row.key === "WASTE")?.quantity).toBe(0);
  });

  it("producción y saldo inicial sólo aparecen si hubo movimientos de ese tipo", () => {
    const rows = groupAuditMovements([total("PRODUCTION_YIELD", 8_000), total("PRODUCTION_CONSUME", -3_000), total("OPENING_BALANCE", 500)]);
    expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining(["PRODUCTION_YIELD", "PRODUCTION_CONSUME", "OPENING_BALANCE"]));
  });

  it("el resumen corto reproduce el caso real: entró 42 kg, se vendieron 25,4 kg y quedan 16,6 kg", () => {
    const summary = quickSummary([total("TRANSFER_IN", 42_000), total("SALE", -25_400, 4)]);
    expect(summary).toEqual({ entered: 42_000, sold: 25_400, waste: 0, adjustments: 0, otherOutflows: 0 });
    expect(0 + summary.entered - summary.sold - summary.waste + summary.adjustments - summary.otherOutflows).toBe(16_600);
  });

  it("la fórmula cierra con todos los tipos mezclados (ingresos, devoluciones, mermas, ajustes +/-, transferencias, desposte)", () => {
    const byType = [
      total("PURCHASE", 20_000), total("TRANSFER_IN", 5_000), total("PRODUCTION_YIELD", 2_000), total("OPENING_BALANCE", 1_000),
      total("SALE", -21_000), total("RETURN", 9_000), total("WASTE", -300), total("ADJUSTMENT_NEGATIVE", -200), total("ADJUSTMENT_POSITIVE", 100),
      total("TRANSFER_OUT", -4_000), total("PRODUCTION_CONSUME", -1_500), total("FUTURE_TYPE", -50)
    ];
    const opening = 5_000;
    const window = byType.reduce((sum, entry) => sum + entry.quantity, 0);
    const quick = quickSummary(byType);
    expect(quick.sold).toBe(12_000);
    expect(quick.otherOutflows).toBe(4_000 + 1_500 + 50);
    expect(opening + quick.entered - quick.sold - quick.waste + quick.adjustments - quick.otherOutflows).toBe(opening + window);
  });

  it("una devolución mayor a las ventas no rompe el signo del vendido neto", () => {
    expect(quickSummary([total("SALE", -3_000), total("RETURN", 3_000)]).sold).toBe(0);
  });
});

describe("control ventas vs ledger", () => {
  const clean: AuditSalesCheck = {
    completedTickets: 37, completedQuantity: 25_400, completedRevenueCents: 1_000_000, ledgerQuantityForCompleted: 25_400, difference: 0,
    pendingPaymentTickets: 0, pendingPaymentQuantity: 0, mismatchedSales: 0, mismatches: [], orphanSaleMovements: { count: 0, quantity: 0 }
  };

  it("sin diferencias no hay alerta", () => {
    expect(salesCheckHasDiscrepancy(clean)).toBe(false);
  });

  it("25,4 kg vendidos contra 23,9 kg descontados es una discrepancia", () => {
    expect(salesCheckHasDiscrepancy({ ...clean, ledgerQuantityForCompleted: 23_900, difference: 1_500 })).toBe(true);
  });

  it("un ticket discrepante o un SALE huérfano alcanza para alertar aunque los totales se compensen", () => {
    expect(salesCheckHasDiscrepancy({ ...clean, mismatchedSales: 2 })).toBe(true);
    expect(salesCheckHasDiscrepancy({ ...clean, orphanSaleMovements: { count: 1, quantity: 400 } })).toBe(true);
  });
});

describe("conteo físico", () => {
  it("no hace nada hasta que se escribe algo", () => {
    expect(physicalCountDifference("", "WEIGHT", 16_600)).toEqual({ state: "empty" });
    expect(physicalCountDifference("   ", "WEIGHT", 16_600)).toEqual({ state: "empty" });
  });

  it("0 kg físicos contra 16,6 kg del sistema: diferencia de -16,6 kg", () => {
    expect(physicalCountDifference("0", "WEIGHT", 16_600)).toEqual({ state: "ok", physicalQuantity: 0, systemQuantity: 16_600, difference: -16_600, matches: false });
    expect(formatSignedQuantity(-16_600, "WEIGHT")).toBe("-16,600 kg");
  });

  it("acepta coma decimal y detecta cuando coincide o sobra", () => {
    expect(physicalCountDifference("16,6", "WEIGHT", 16_600)).toMatchObject({ state: "ok", difference: 0, matches: true });
    expect(physicalCountDifference("18", "WEIGHT", 16_600)).toMatchObject({ state: "ok", difference: 1_400, matches: false });
  });

  it("un producto por unidad cuenta unidades enteras", () => {
    expect(physicalCountDifference("8", "UNIT", 10)).toMatchObject({ state: "ok", difference: -2 });
    expect(physicalCountDifference("2,5", "UNIT", 10)).toMatchObject({ state: "invalid" });
  });

  it("rechaza texto y negativos sin lanzar", () => {
    expect(physicalCountDifference("abc", "WEIGHT", 100)).toMatchObject({ state: "invalid" });
    expect(physicalCountDifference("-1", "WEIGHT", 100)).toMatchObject({ state: "invalid" });
  });
});

describe("formato", () => {
  it("cantidades con signo en kg y en unidades", () => {
    expect(formatSignedQuantity(20_000, "WEIGHT")).toBe("+20,000 kg");
    expect(formatSignedQuantity(-1_350, "WEIGHT")).toBe("-1,350 kg");
    expect(formatSignedQuantity(0, "WEIGHT")).toBe("0,000 kg");
    expect(formatSignedQuantity(12, "UNIT")).toBe("+12 u");
    expect(formatSignedQuantity(-3, "UNIT")).toBe("-3 u");
  });

  it("referencias del detalle", () => {
    const base: AuditMovement = {
      id: "m", occurredAt: "2026-10-08T13:15:00Z", type: "SALE", quantity: -1_350, balanceAfter: 0, reason: null, operatorName: null, saleId: "abcdef12-0000", saleStatus: "COMPLETED",
      transferId: null, counterpartBranchName: null, stockOperationId: null, supplier: null, productionBatchId: null
    };
    expect(describeMovementReference(base)).toBe("Ticket abcdef12");
    expect(describeMovementReference({ ...base, saleStatus: "CANCELLED" })).toBe("Ticket abcdef12 · anulada");
    expect(describeMovementReference({ ...base, type: "TRANSFER_IN", saleId: null, counterpartBranchName: "Central" })).toBe("Desde Central");
    expect(describeMovementReference({ ...base, type: "TRANSFER_OUT", saleId: null, counterpartBranchName: "Avenida" })).toBe("Hacia Avenida");
    expect(describeMovementReference({ ...base, type: "PURCHASE", saleId: null, supplier: "Frigorífico X" })).toBe("Proveedor Frigorífico X");
    expect(describeMovementReference({ ...base, type: "WASTE", saleId: null, reason: "DISCARD" })).toBe("DISCARD");
  });
});

describe("período y enlaces", () => {
  const tz = "America/Argentina/Buenos_Aires";
  const now = new Date("2026-10-09T15:00:00Z");

  it("sin parámetros: desde el último ingreso", () => {
    expect(resolveAuditPeriod({}, tz, now)).toEqual({ period: { mode: "since-inbound" } });
  });

  it("con fechas válidas: rango de días de la organización", () => {
    expect(resolveAuditPeriod({ from: "2026-10-02", to: "2026-10-09" }, tz, now)).toEqual({ period: { mode: "range", from: "2026-10-02", to: "2026-10-09" } });
  });

  it("mode=range sin fechas cae a los últimos 7 días; fechas inválidas devuelven error sin romper", () => {
    expect(resolveAuditPeriod({ mode: "range" }, tz, now).period).toEqual({ mode: "range", from: "2026-10-03", to: "2026-10-09" });
    expect(resolveAuditPeriod({ from: "2026-10-09", to: "2026-10-01" }, tz, now).error).toMatch(/Desde/);
    expect(resolveAuditPeriod({ from: "2026-02-31", to: "2026-03-01" }, tz, now).error).toMatch(/válida/);
    expect(resolveAuditPeriod({ from: "2026-10-01" }, tz, now).error).toMatch(/dos fechas/);
    expect(resolveAuditPeriod({ from: "2024-01-01", to: "2026-10-09" }, tz, now).error).toMatch(/366/);
  });

  it("a las 23:30 locales el «hoy» sigue siendo el día local, no el UTC", () => {
    expect(resolveAuditPeriod({ mode: "range" }, tz, new Date("2026-10-10T02:30:00Z")).period).toEqual({ mode: "range", from: "2026-10-03", to: "2026-10-09" });
  });

  it("argumentos de los RPC", () => {
    expect(periodRpcArgs({ mode: "since-inbound" })).toEqual({ p_since_last_inbound: true });
    expect(periodRpcArgs({ mode: "range", from: "2026-10-02", to: "2026-10-09" })).toEqual({ p_since_last_inbound: false, p_from: "2026-10-02", p_to: "2026-10-09" });
  });

  it("enlaces: conservan sucursal, producto y rango", () => {
    expect(stockAuditHref({ branchId: "b1", productId: "p1" })).toBe("/admin/branch-stock/movements?branch=b1&product=p1");
    expect(stockAuditHref({ branchId: "b1", productId: "p1", period: { mode: "range", from: "2026-10-02", to: "2026-10-09" }, page: 3, newestFirst: true }))
      .toBe("/admin/branch-stock/movements?branch=b1&product=p1&mode=range&from=2026-10-02&to=2026-10-09&order=newest&page=3");
    expect(productSalesHref({ productId: "p1", branchId: "b1", range: { from: "2026-10-02", to: "2026-10-09" } }))
      .toBe("/admin/sales?product=p1&status=COMPLETED&branch=b1&preset=custom&from=2026-10-02&to=2026-10-09");
    expect(productSalesHref({ productId: "p1" })).toBe("/admin/sales?product=p1&status=COMPLETED");
    expect(productSalesHref({ productId: "p1", branchId: "b1", preset: "month" })).toBe("/admin/sales?product=p1&status=COMPLETED&branch=b1&preset=month");
    expect(productSalesHref({ productId: "p1", range: { from: "2026-10-02", to: "2026-10-09" }, preset: "month" })).toContain("preset=custom");
  });

  const baseSummary = (overrides: Partial<StockAuditSummary>): StockAuditSummary => ({
    product: { id: "p", name: "Pata Muslo", sku: null, unitType: "WEIGHT", active: true }, branch: { id: "b", name: "Avenida" }, mode: "RANGE", timezone: tz,
    periodStart: null, periodEnd: null, anchor: null, openingQuantity: 0, windowQuantity: 0, closingQuantity: 0, afterPeriodQuantity: 0, currentQuantity: 0,
    movementCount: 0, byType: [], sales: null, computedAt: now.toISOString(), ...overrides
  });

  it("el rango de ventas de un período manual es el mismo que se pidió (el fin exclusivo no corre un día)", () => {
    const summary = baseSummary({ mode: "RANGE", periodStart: "2026-10-02T03:00:00Z", periodEnd: "2026-10-10T03:00:00Z" });
    expect(auditPeriodDateRange(summary, tz, now)).toEqual({ from: "2026-10-02", to: "2026-10-09" });
  });

  it("desde el último ingreso: del día del ingreso (hora local) a hoy", () => {
    const summary = baseSummary({ mode: "SINCE_LAST_INBOUND", periodStart: "2026-10-02T01:30:00Z" });
    expect(auditPeriodDateRange(summary, tz, now)).toEqual({ from: "2026-10-01", to: "2026-10-09" });
  });

  it("un ingreso de hace más de un año queda acotado al máximo de los RPC de ventas", () => {
    const summary = baseSummary({ mode: "SINCE_LAST_INBOUND", periodStart: "2024-01-01T12:00:00Z" });
    expect(auditPeriodDateRange(summary, tz, now)).toEqual({ from: "2025-10-09", to: "2026-10-09" });
    expect(auditPeriodDateRange(baseSummary({ mode: "ALL_HISTORY" }), tz, now)).toEqual({ from: "2025-10-09", to: "2026-10-09" });
  });
});

describe("validación de las respuestas del RPC", () => {
  const raw = {
    product: { id: "p", name: "Pata Muslo", sku: "PMU", unitType: "WEIGHT", active: true },
    branch: { id: "b", name: "Avenida" },
    mode: "SINCE_LAST_INBOUND", timezone: "America/Argentina/Buenos_Aires",
    periodStart: "2026-10-02T13:00:00+00:00", periodEnd: null,
    anchor: { movementId: "m1", type: "TRANSFER_IN", occurredAt: "2026-10-02T13:00:00+00:00", quantity: 42_000 },
    openingQuantity: 0, windowQuantity: 16_600, closingQuantity: 16_600, afterPeriodQuantity: 0, currentQuantity: 16_600, movementCount: 5,
    byType: [{ type: "TRANSFER_IN", count: 1, quantity: 42_000 }, { type: "SALE", count: 4, quantity: -25_400 }],
    sales: {
      completedTickets: 4, completedQuantity: 25_400, completedRevenueCents: 250_000, ledgerQuantityForCompleted: 25_400, difference: 0,
      pendingPaymentTickets: 0, pendingPaymentQuantity: 0, mismatchedSales: 0, mismatches: [], orphanSaleMovements: { count: 0, quantity: 0 }
    },
    computedAt: "2026-10-09T15:00:00+00:00"
  };

  it("acepta la forma real", () => {
    const parsed = parseStockAuditSummary(raw);
    expect(parsed.currentQuantity).toBe(16_600);
    expect(parsed.anchor?.type).toBe("TRANSFER_IN");
    expect(parsed.sales?.completedTickets).toBe(4);
    expect(parsed.periodEnd).toBeNull();
  });

  it("sin sales.read el control llega nulo", () => {
    expect(parseStockAuditSummary({ ...raw, sales: null }).sales).toBeNull();
  });

  it("falla fuerte ante una forma inesperada", () => {
    expect(() => parseStockAuditSummary({ ...raw, mode: "OTHER" })).toThrow(/inesperada/);
    expect(() => parseStockAuditSummary({ ...raw, currentQuantity: "16600" })).toThrow(/inesperada/);
    expect(() => parseStockAuditSummary({ ...raw, product: { ...raw.product, unitType: "KG" } })).toThrow(/inesperada/);
    expect(() => parseStockAuditSummary(null)).toThrow(/inesperada/);
  });

  it("detalle paginado", () => {
    const page = parseAuditMovementsPage({
      total: 5, openingQuantity: 0, limit: 50, offset: 0, newestFirst: false,
      rows: [{
        id: "m1", occurredAt: "2026-10-02T13:00:00+00:00", type: "TRANSFER_IN", quantity: 42_000, balanceAfter: 42_000, reason: null, operatorName: "Ana",
        saleId: null, saleStatus: null, transferId: "t1", counterpartBranchName: "Central", stockOperationId: null, supplier: null, productionBatchId: null
      }]
    });
    expect(page.rows[0]?.balanceAfter).toBe(42_000);
    expect(() => parseAuditMovementsPage({ total: 1, openingQuantity: 0, limit: 50, offset: 0, rows: [{ id: "m" }] })).toThrow(/inesperada/);
  });
});
