import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchOperationsBoard } from "./branch-operations-board";
import { ProductInsightView } from "./product-insight-modal";
import { buildBranchBoard } from "../lib/branch-board";
import type { InsightRow } from "../lib/branch-insights";
import { buildProductInsight, type ProductModalData } from "../lib/product-insight";
import type { AuditSalesCheck, StockAuditSummary } from "../lib/stock-audit";

const NOW = new Date("2026-10-10T15:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const TZ = "America/Argentina/Buenos_Aires";

const row = (overrides: Partial<InsightRow>): InsightRow => ({
  productId: "p", productName: "Producto", unitType: "WEIGHT", current: 0, soldPeriod: 0, revenuePeriodCents: 0, soldPrevious: 0,
  sold7d: 0, sold14d: 0, lastSaleAt: null, lastInboundAt: null, mismatchTickets: 0, mismatchQuantity: 0, ...overrides
});

const rows: InsightRow[] = [
  row({ productId: "pm", productName: "Pata muslo", current: 3_000, soldPeriod: 13_795, revenuePeriodCents: 900_000, soldPrevious: 11_300, sold7d: 31_500, lastSaleAt: ago(0), lastInboundAt: ago(3) }),
  row({ productId: "ham", productName: "Hamburguesa", unitType: "UNIT", current: 94, soldPeriod: 42, revenuePeriodCents: 400_000, sold7d: 42, sold14d: 60, lastSaleAt: ago(1), lastInboundAt: ago(5) }),
  row({ productId: "pec", productName: "Peceto", current: 15_000, sold14d: 1_200, lastSaleAt: ago(8), lastInboundAt: ago(12) }),
  row({ productId: "tapa", productName: "Tapa de nalga", current: 7_400, lastInboundAt: ago(30) })
];

function renderBoard(overrides: { isProduction?: boolean; carry?: Parameters<typeof buildBranchBoard>[0]["carry"] } = {}) {
  const isProduction = overrides.isProduction ?? false;
  const board = buildBranchBoard({
    rows, configuredAlerts: [], isProductionBranch: isProduction, now: NOW, range: { preset: "7d", from: "2026-10-04", to: "2026-10-10" },
    carry: overrides.carry === undefined ? (isProduction ? null : { calculatedAt: NOW.toISOString(), windowStart: ago(6), windowDays: 7, rows: [
      { branchId: "av", branchName: "Avenida", productId: "pm", productName: "Pata muslo", unitType: "WEIGHT", soldQuantity: 31_400, currentQuantity: 3_000, suggestedQuantity: 28_400 },
      { branchId: "av", branchName: "Avenida", productId: "ham", productName: "Hamburguesa", unitType: "UNIT", soldQuantity: 42, currentQuantity: 10, suggestedQuantity: 32 }
    ] }) : overrides.carry,
    });
  return renderToStaticMarkup(<BranchOperationsBoard board={board} branchId="av" branchName="Avenida" isProduction={isProduction} stockCounts={{ out: 3, low: 5, normal: 120 }} timeZone={TZ} />);
}

describe("Qué está pasando", () => {
  it("muestra los cuatro bloques con el período que usa cada uno", () => {
    const html = renderBoard();
    for (const title of ["Más vendidos", "Qué llevar", "Baja rotación", "Requiere atención"]) expect(html).toContain(title);
    expect(html).toContain("Últimos 7 días");
    expect(html).toContain("Últimos 14 días");
  });

  it("más vendidos: cantidad en su unidad, importe y tendencia", () => {
    const html = renderBoard();
    expect(html).toContain("Pata muslo");
    expect(html).toContain("13,795 kg");
    expect(html).toContain("42 u");
    expect(html).toContain("↑ 22% vs período anterior");
  });

  it("qué llevar: productos sugeridos en kg y unidades, y un botón que abre el modal (no un link)", () => {
    const html = renderBoard();
    expect(html).toContain("28,400 kg");
    expect(html).toContain("32 u");
    expect(html).toContain("Ver carga");
    expect(html).not.toMatch(/<a[^>]*>[^<]*Ver carga/);
  });

  it("baja rotación: Peceto y Tapa de nalga con su stock y última venta", () => {
    const html = renderBoard();
    expect(html).toContain("1,200 kg vendidos en 14 días");
    expect(html).toContain("Sin ventas en 14 días");
    expect(html).toContain("Stock alto para su venta");
    expect(html).toContain("Última venta: hace 8 días");
    expect(html).toContain("Sin ventas en los últimos 90 días");
    expect(html).toContain("Stock: 7,400 kg");
    expect(html).not.toMatch(/no mandar/i);
  });

  it("requiere atención: la alerta de cobertura baja de Pata muslo y el resumen de stock en una línea", () => {
    const html = renderBoard();
    expect(html).toContain("Queda poco stock");
    expect(html).toContain("≈ 0,7 días");
    expect(html).toContain("Agotados 3 · Bajo mínimo 5 · Normal 120");
  });

  it("no crea links ni rutas nuevas: los detalles se abren en modales dentro del Resumen", () => {
    const html = renderBoard();
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toMatch(/operations|branch-insights|intelligence/i);
  });

  it("sucursal productiva: sin baja rotación y «qué llevar» explica que es el origen", () => {
    const html = renderBoard({ isProduction: true });
    expect(html).not.toContain("Baja rotación");
    expect(html).toContain("sucursal productiva");
  });

  it("si el plan de carga falla muestra el motivo dentro del bloque", () => {
    const html = renderBoard({ carry: "Configurá la sucursal productiva antes de calcular qué llevar" });
    expect(html).toContain("Configurá la sucursal productiva");
  });

  it("sin resumen operativo avisa y no rompe el resto del Resumen", () => {
    const html = renderToStaticMarkup(<BranchOperationsBoard board={null} branchId="av" branchName="Avenida" isProduction={false} stockCounts={{ out: 0, low: 0, normal: 0 }} timeZone={TZ} unavailable="Branch is not authorized" />);
    expect(html).toContain("No se pudo calcular el resumen operativo");
    expect(html).toContain("Branch is not authorized");
  });
});

describe("el Resumen no agrega pantallas", () => {
  it("el detalle de sucursal sigue teniendo sólo las rutas que ya tenía (nada de /operations, /intelligence, /rotation…)", () => {
    const root = join(__dirname, "..", "app", "admin");
    const forbidden = ["operations", "operacion", "branch-insights", "intelligence", "inteligencia", "rotation", "reposicion-sucursal", "insights"];
    const walk = (dir: string, depth = 0): string[] => depth > 3 ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? [entry.name, ...walk(join(dir, entry.name), depth + 1)] : []);
    const names = walk(root);
    for (const name of forbidden) expect(names, name).not.toContain(name);
  });
});

const check = (overrides: Partial<AuditSalesCheck>): AuditSalesCheck => ({
  completedTickets: 4, completedQuantity: 9_000, completedRevenueCents: 90_000, ledgerQuantityForCompleted: 6_000, difference: 3_000, pendingPaymentTickets: 0,
  pendingPaymentQuantity: 0, mismatchedSales: 1,
  mismatches: [{ saleId: "abcdef12-0000-4000-8000-000000000000", status: "COMPLETED", completedAt: "2026-10-09T15:00:00Z", saleQuantity: 3_000, ledgerQuantity: 0, expectedQuantity: 3_000 }],
  orphanSaleMovements: { count: 0, quantity: 0 }, ...overrides
});

function modalData(sales: AuditSalesCheck | null): ProductModalData {
  const audit: StockAuditSummary = {
    product: { id: "pm", name: "Pata muslo", sku: "PMU", unitType: "WEIGHT", active: true }, branch: { id: "av", name: "Avenida" }, mode: "SINCE_LAST_INBOUND", timezone: TZ,
    periodStart: "2026-10-07T12:32:00Z", periodEnd: null, anchor: { movementId: "m1", type: "PURCHASE", occurredAt: "2026-10-07T12:32:00Z", quantity: 15_000 },
    openingQuantity: 0, windowQuantity: 16_500, closingQuantity: 16_500, afterPeriodQuantity: 0, currentQuantity: 16_500, movementCount: 4,
    byType: [{ type: "PURCHASE", count: 2, quantity: 22_500 }, { type: "SALE", count: 3, quantity: -6_000 }], sales, computedAt: NOW.toISOString()
  };
  return { audit, activity: [
    { branchId: "ce", branchName: "Central", isProduction: true, unitType: "WEIGHT", current: 100_000, sold7d: 1_000, lastSaleAt: null },
    { branchId: "av", branchName: "Avenida", isProduction: false, unitType: "WEIGHT", current: 16_500, sold7d: 31_400, lastSaleAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() },
    { branchId: "ja", branchName: "Janssen", isProduction: false, unitType: "WEIGHT", current: 4_000, sold7d: 17_200, lastSaleAt: ago(1) }
  ] };
}

function renderModal(data: ProductModalData, isProduction = false) {
  return renderToStaticMarkup(<ProductInsightView branchId="av" data={data} insight={buildProductInsight(data, "av")} isProduction={isProduction} now={NOW} timeZone={TZ} />);
}

describe("modal de producto", () => {
  it("resume el producto en la sucursal: stock, vendido 7 días, promedio, última venta, último ingreso y cobertura", () => {
    const html = renderModal(modalData(check({})));
    expect(html).toContain("Stock sistema");
    expect(html).toContain("16,500 kg");
    expect(html).toContain("31,400 kg");
    expect(html).toContain("4,486 kg/día");
    expect(html).toContain("Última venta");
    expect(html).toContain("hace 3 horas");
    expect(html).toContain("15,000 kg · 07/10/2026 09:32");
    expect(html).toContain("Cobertura estimada");
    expect(html).toContain("≈ 3,7 días");
  });

  it("muestra la trazabilidad del ledger y la diferencia detectada (sin corregir nada)", () => {
    const html = renderModal(modalData(check({})));
    expect(html).toContain("Desde el último ingreso");
    expect(html).toContain("Debería quedar");
    expect(html).toContain("13,500 kg");
    expect(html).toContain("Stock ledger");
    expect(html).toContain("Diferencia detectada: 3,000 kg de más en el sistema");
    expect(html).toContain("no se corrigió nada");
    expect(html).toContain("Hay diferencias");
  });

  it("si las ventas coinciden con el ledger, no hay alarma", () => {
    const html = renderModal(modalData(check({ completedQuantity: 6_000, difference: 0, mismatchedSales: 0, mismatches: [] })));
    expect(html).toContain("Las ventas coinciden con lo que descontó el ledger");
    expect(html).not.toContain("Diferencia detectada");
  });

  it("incluye el conteo físico (sólo calcula la diferencia; el ajuste se confirma aparte) sin ajustar por escribir", () => {
    const html = renderModal(modalData(check({})));
    expect(html).toContain("Stock físico (kg)");
    expect(html).toContain("No se modifica nada");
    expect(html).not.toContain("Confirmar ajuste");
  });

  it("compara con otras sucursales, sin la actual ni la productiva", () => {
    const html = renderModal(modalData(check({})));
    expect(html).toContain("Este producto en otras sucursales");
    expect(html).toContain("Janssen");
    expect(html).toContain("17,200 kg");
    expect(html).not.toContain("Central");
  });

  it("en la sucursal productiva no muestra cobertura", () => {
    expect(renderModal(modalData(check({})), true)).not.toContain("Cobertura estimada");
  });

  it("sin permiso de ventas no inventa la conciliación pero mantiene stock y conteo", () => {
    const html = renderModal(modalData(null));
    expect(html).not.toContain("Debería quedar");
    expect(html).toContain("Stock físico (kg)");
  });

  it("enlaza al detalle completo de movimientos que ya existe (no a una pantalla nueva)", () => {
    expect(renderModal(modalData(check({})))).toContain("/admin/branch-stock/movements?branch=av&amp;product=pm");
  });
});
