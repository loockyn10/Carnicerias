import { describe, expect, it } from "vitest";

import { BOARD_LIMIT, buildBranchBoard, periodTag } from "./branch-board";
import type { InsightRow } from "./branch-insights";
import { buildCarryPlanReport, topCarryRows, type CarryPlanReport, type CarryPlanRow, type CarryPlanRpcRow } from "./carry-plan";
import type { SalesRange } from "./date-range";

const NOW = new Date("2026-10-10T15:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const range = (preset: SalesRange["preset"], from = "2026-10-04", to = "2026-10-10"): SalesRange => ({ preset, from, to });

const row = (overrides: Partial<InsightRow>): InsightRow => ({
  productId: "p", productName: "Producto", unitType: "WEIGHT", current: 0, soldPeriod: 0, revenuePeriodCents: 0, soldPrevious: 0,
  sold7d: 0, sold14d: 0, lastSaleAt: null, lastInboundAt: null, mismatchTickets: 0, mismatchQuantity: 0, ...overrides
});

const carryRow = (overrides: Partial<CarryPlanRow>): CarryPlanRow => ({
  branchId: "av", branchName: "Avenida", productId: "p", productName: "Producto", unitType: "WEIGHT", soldQuantity: 0, currentQuantity: 0, suggestedQuantity: 0, ...overrides
});
const report = (rows: CarryPlanRow[]): CarryPlanReport => ({ calculatedAt: NOW.toISOString(), windowStart: ago(6), windowDays: 7, rows });

function build(overrides: Partial<Parameters<typeof buildBranchBoard>[0]> = {}) {
  return buildBranchBoard({ rows: [], configuredAlerts: [], carry: report([]), isProductionBranch: false, range: range("7d"), now: NOW, ...overrides });
}

describe("periodTag", () => {
  it("nombra el período elegido", () => {
    expect(periodTag(range("today"))).toBe("Hoy");
    expect(periodTag(range("yesterday"))).toBe("Ayer");
    expect(periodTag(range("7d"))).toBe("Últimos 7 días");
    expect(periodTag(range("30d"))).toBe("Últimos 30 días");
    expect(periodTag(range("custom", "2026-10-01", "2026-10-07"))).toBe("01/10/2026 – 07/10/2026");
    expect(periodTag(range("custom", "2026-10-01", "2026-10-01"))).toBe("01/10/2026");
  });
});

describe("buildBranchBoard", () => {
  it("más vendidos: período elegido, 5 como máximo, y cuenta el total", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row({ productId: `p${String(index)}`, productName: `Producto ${String(index)}`, soldPeriod: 1_000 + index, revenuePeriodCents: 10_000 + index }));
    const board = build({ rows });
    expect(board.topSellers).toHaveLength(BOARD_LIMIT);
    expect(board.topSellersTotal).toBe(8);
    expect(board.topSellers[0]?.productId).toBe("p7");
    expect(board.periodTag).toBe("Últimos 7 días");
  });

  it("«hoy» no muestra tendencia (día incompleto); cualquier otro período sí", () => {
    const rows = [row({ productId: "a", soldPeriod: 1_200, revenuePeriodCents: 1, soldPrevious: 1_000 })];
    expect(build({ rows, range: range("today") }).topSellers[0]?.trendPercent).toBeNull();
    expect(build({ rows, range: range("7d") }).topSellers[0]?.trendPercent).toBe(20);
  });

  it("el filtro «Hoy» no rompe la reposición: «qué llevar» y la baja rotación salen de sus propias ventanas, no del período", () => {
    const rows = [row({ productId: "tapa", productName: "Tapa", current: 7_400, lastInboundAt: ago(30), soldPeriod: 0, sold14d: 0 })];
    const carry = report([carryRow({ productId: "m", productName: "Molida", suggestedQuantity: 14_000, soldQuantity: 18_000 })]);
    const today = build({ rows, carry, range: range("today", "2026-10-10", "2026-10-10") });
    const week = build({ rows, carry, range: range("30d", "2026-09-11", "2026-10-10") });
    expect(today.lowRotation?.items.map((item) => item.productId)).toEqual(["tapa"]);
    expect(today.lowRotation).toEqual(week.lowRotation);
    expect(today.carry).toEqual(week.carry);
  });

  it("qué llevar reutiliza el plan existente: sólo lo que necesita carga, en el orden del servidor, con un máximo y el total", () => {
    const rows = [
      carryRow({ productId: "a", productName: "Pata muslo", suggestedQuantity: 12_500 }),
      carryRow({ productId: "b", productName: "Molida", suggestedQuantity: 8_000 }),
      carryRow({ productId: "ok", productName: "Cubierto", suggestedQuantity: 0 }),
      ...Array.from({ length: 6 }, (_, index) => carryRow({ productId: `x${String(index)}`, productName: `X${String(index)}`, suggestedQuantity: 1_000 }))
    ];
    const board = build({ carry: report(rows) });
    expect(board.carry && "preview" in board.carry ? board.carry.preview.map((item) => item.productName).slice(0, 2) : null).toEqual(["Pata muslo", "Molida"]);
    expect(board.carry && "preview" in board.carry ? board.carry.preview : []).toHaveLength(BOARD_LIMIT);
    expect(board.carry && "preview" in board.carry ? board.carry.needing : 0).toBe(8);
  });

  it("qué llevar con UNIT y WEIGHT conserva cada unidad (el orden lo decide el servidor)", () => {
    const rows = [
      carryRow({ productId: "w", unitType: "WEIGHT", suggestedQuantity: 5_500 }),
      carryRow({ productId: "u", unitType: "UNIT", suggestedQuantity: 20 })
    ];
    expect(topCarryRows(rows).map((item) => [item.productId, item.unitType])).toEqual([["w", "WEIGHT"], ["u", "UNIT"]]);
  });

  it("si el plan no se pudo calcular (p. ej. falta la sucursal productiva) el bloque muestra el motivo en lugar de romper", () => {
    const board = build({ carry: "Configurá la sucursal productiva antes de calcular qué llevar" });
    expect(board.carry).toEqual({ error: "Configurá la sucursal productiva antes de calcular qué llevar" });
  });

  it("sucursal productiva (Central): sin «qué llevar» ni baja rotación y sin reglas de cobertura/inconsistencia", () => {
    const rows = [row({ productId: "pm", current: 0, sold7d: 30_000, mismatchTickets: 1, mismatchQuantity: 1_000 }), row({ productId: "t", current: 9_000, lastInboundAt: ago(30) })];
    const board = build({ rows, carry: null, isProductionBranch: true, configuredAlerts: [{ productId: "min", productName: "Min", unitType: "WEIGHT", current: 1_000, suggested: 4_000, rank: 1 }] });
    expect(board.carry).toBeNull();
    expect(board.lowRotation).toBeNull();
    expect(board.attention.all.map((item) => item.productId)).toEqual(["min"]);
  });

  it("no repite datos: un producto que ya está en «Requiere atención» no vuelve a aparecer en «Baja rotación»", () => {
    const rows = [row({ productId: "inc", productName: "Inconsistente", current: 9_000, lastInboundAt: ago(30), mismatchTickets: 1, mismatchQuantity: 2_000 }), row({ productId: "tapa", productName: "Tapa", current: 7_400, lastInboundAt: ago(30) })];
    const board = build({ rows });
    expect(board.attention.items.map((item) => item.productId)).toEqual(["inc"]);
    expect(board.lowRotation?.items.map((item) => item.productId)).toEqual(["tapa"]);
  });

  it("baja rotación: texto de última venta y de «sin ventas» listos para mostrar; «Ver todos» conserva la lista completa", () => {
    const rows = [
      row({ productId: "pec", productName: "Peceto", current: 15_000, sold14d: 1_200, lastSaleAt: ago(8), lastInboundAt: ago(12) }),
      row({ productId: "tapa", productName: "Tapa", current: 7_400, lastInboundAt: ago(30) }),
      ...Array.from({ length: 6 }, (_, index) => row({ productId: `s${String(index)}`, productName: `Sin venta ${String(index)}`, current: 5_000, lastInboundAt: ago(30) }))
    ];
    const board = build({ rows });
    expect(board.lowRotation?.items).toHaveLength(BOARD_LIMIT);
    expect(board.lowRotation?.all).toHaveLength(8);
    expect(board.lowRotation?.all.find((item) => item.productId === "pec")?.lastSaleText).toBe("Última venta: hace 8 días");
    expect(board.lowRotation?.all.find((item) => item.productId === "tapa")?.lastSaleText).toBe("Sin ventas en los últimos 90 días");
  });

  it("requiere atención: máximo 5 en el Resumen y la lista completa para el modal", () => {
    const rows = Array.from({ length: 7 }, (_, index) => row({ productId: `a${String(index)}`, productName: `A${String(index)}`, current: 0, sold7d: 10_000 + index }));
    const board = build({ rows });
    expect(board.attention.items).toHaveLength(BOARD_LIMIT);
    expect(board.attention.all).toHaveLength(7);
  });
});

describe("buildCarryPlanReport", () => {
  it("convierte las filas de get_branch_carry_plan (la misma conversión que «Recalcular»)", () => {
    const rpc: CarryPlanRpcRow = {
      branch_id: "av", branch_name: "Avenida", product_id: "p", product_name: "Molida", unit_type: "WEIGHT", sold_quantity: 18_000, current_quantity: 4_000,
      suggested_quantity: 14_000, window_days: 7, window_start: "2026-10-04T03:00:00Z", calculated_at: "2026-10-10T15:00:00Z"
    };
    expect(buildCarryPlanReport([rpc])).toEqual({
      calculatedAt: "2026-10-10T15:00:00Z", windowStart: "2026-10-04T03:00:00Z", windowDays: 7,
      rows: [{ branchId: "av", branchName: "Avenida", productId: "p", productName: "Molida", unitType: "WEIGHT", soldQuantity: 18_000, currentQuantity: 4_000, suggestedQuantity: 14_000 }]
    });
  });

  it("sin filas devuelve un informe vacío con la ventana de 7 días", () => {
    expect(buildCarryPlanReport([], NOW)).toEqual({ calculatedAt: NOW.toISOString(), windowStart: "", windowDays: 7, rows: [] });
  });
});
