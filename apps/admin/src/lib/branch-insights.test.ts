import { describe, expect, it } from "vitest";

import {
  INSIGHT_RULES, coverageDays, coverageText, formatCoverageDays, formatDailyAverage, formatRelativeTime, lowRotation, stockAttention, toInsightRows, topSellers, trendPercent,
  type ConfiguredStockAlert, type InsightRow, type InsightRpcRow
} from "./branch-insights";

const NOW = new Date("2026-10-10T15:00:00Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - (days * 24 + hours) * 3_600_000).toISOString();

const row = (overrides: Partial<InsightRow>): InsightRow => ({
  productId: "p", productName: "Producto", unitType: "WEIGHT", current: 0, soldPeriod: 0, revenuePeriodCents: 0, soldPrevious: 0,
  sold7d: 0, sold14d: 0, lastSaleAt: null, lastInboundAt: null, mismatchTickets: 0, mismatchQuantity: 0, ...overrides
});

describe("cobertura", () => {
  it("stock / promedio diario de 7 días: 6 kg con 31,5 kg vendidos en la semana (4,5 kg/día) ≈ 1,3 días", () => {
    const days = coverageDays(6_000, 31_500);
    expect(days).toBeCloseTo(1.333, 2);
    expect(formatCoverageDays(days ?? 0)).toBe("≈ 1,3 días");
  });

  it("no divide por cero: sin ventas en 7 días no hay cobertura y el texto lo dice", () => {
    expect(coverageDays(10_000, 0)).toBeNull();
    expect(coverageText(10_000, 0)).toBe("Sin ventas últimos 7 días");
  });

  it("un stock negativo cuenta como 0 días (igual que en «qué llevar»)", () => {
    expect(coverageDays(-2_000, 7_000)).toBe(0);
  });

  it("formatea 1 día en singular y las coberturas largas sin decimales", () => {
    expect(formatCoverageDays(1)).toBe("≈ 1 día");
    expect(formatCoverageDays(12.4)).toBe("≈ 12 días");
  });

  it("promedio diario en kg (3 decimales) o unidades (1 decimal)", () => {
    expect(formatDailyAverage(13_795, "WEIGHT")).toBe("1,971 kg/día");
    expect(formatDailyAverage(24, "UNIT")).toBe("3,4 u/día");
  });
});

describe("tiempo relativo", () => {
  it("minutos, horas y días con su plural", () => {
    expect(formatRelativeTime(ago(0, 3), NOW)).toBe("hace 3 horas");
    expect(formatRelativeTime(ago(0, 1), NOW)).toBe("hace 1 hora");
    expect(formatRelativeTime(ago(8), NOW)).toBe("hace 8 días");
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe("hace 5 minutos");
    expect(formatRelativeTime(new Date(NOW.getTime() - 10_000).toISOString(), NOW)).toBe("hace instantes");
  });

  it("sin dato no inventa nada", () => {
    expect(formatRelativeTime(null, NOW)).toBeNull();
  });
});

describe("más vendidos", () => {
  const rows = [
    row({ productId: "a", productName: "Pata muslo", soldPeriod: 13_795, revenuePeriodCents: 900_000, soldPrevious: 11_300 }),
    row({ productId: "b", productName: "Matambre de cerdo", soldPeriod: 3_345, revenuePeriodCents: 500_000, soldPrevious: 3_636 }),
    row({ productId: "c", productName: "Hamburguesa", unitType: "UNIT", soldPeriod: 42, revenuePeriodCents: 700_000, soldPrevious: 0 }),
    row({ productId: "d", productName: "Molida", soldPeriod: 0, revenuePeriodCents: 0, current: 5_000 })
  ];

  it("ordena por facturación (la semántica del bloque original), muestra la cantidad en su unidad y excluye lo que no vendió", () => {
    const top = topSellers(rows);
    expect(top.map((item) => item.productName)).toEqual(["Pata muslo", "Hamburguesa", "Matambre de cerdo"]);
    expect(top[1]).toMatchObject({ unitType: "UNIT", quantity: 42 });
  });

  it("la tendencia compara cantidades con el período anterior (↑22 %, ↓8 %) y se omite sin base de comparación", () => {
    const top = topSellers(rows);
    expect(top.find((item) => item.productId === "a")?.trendPercent).toBe(22);
    expect(top.find((item) => item.productId === "b")?.trendPercent).toBe(-8);
    expect(top.find((item) => item.productId === "c")?.trendPercent).toBeNull();
    expect(trendPercent(10, 0)).toBeNull();
  });

  it("puede ocultar la tendencia (ej. «hoy», un día incompleto) y limita la cantidad", () => {
    expect(topSellers(rows, { showTrend: false }).every((item) => item.trendPercent === null)).toBe(true);
    expect(topSellers(rows, { limit: 2 })).toHaveLength(2);
  });
});

describe("baja rotación", () => {
  const settled = ago(20);

  it("TAPA DE NALGA: 7,4 kg de stock sin una venta en 14 días aparece como «Baja rotación»", () => {
    const items = lowRotation([row({ productId: "t", productName: "Tapa de nalga", current: 7_400, lastInboundAt: settled })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: "NO_SALES", label: "Baja rotación", current: 7_400, sold14d: 0, daysSinceLastSale: null });
  });

  it("PECETO: 1,2 kg vendidos en 14 días con 15 kg de stock (≈ 175 días) es «Stock alto para su venta» y recuerda la última venta", () => {
    const items = lowRotation([row({ productId: "p", productName: "Peceto", current: 15_000, sold14d: 1_200, lastSaleAt: ago(8), lastInboundAt: settled })], NOW);
    expect(items[0]).toMatchObject({ reason: "HIGH_COVERAGE", label: "Stock alto para su venta", daysSinceLastSale: 8 });
    expect(items[0]?.coverageDays).toBeCloseTo(175, 0);
  });

  it("no incluye productos irrelevantes: sin stock, stock negativo, un resto mínimo, o que acaban de ingresar", () => {
    const items = lowRotation([
      row({ productId: "cero", current: 0, lastInboundAt: settled }),
      row({ productId: "negativo", current: -3_000, lastInboundAt: settled }),
      row({ productId: "resto", current: 300, lastInboundAt: settled }),
      row({ productId: "unidad", unitType: "UNIT", current: 1, lastInboundAt: settled }),
      row({ productId: "reciente", current: 8_000, lastInboundAt: ago(2) })
    ], NOW);
    expect(items).toEqual([]);
  });

  it("no incluye lo que rota bien: vende y su stock alcanza para pocos días", () => {
    const items = lowRotation([row({ productId: "ok", current: 8_000, sold14d: 28_000, lastSaleAt: ago(0, 2), lastInboundAt: settled })], NOW);
    expect(items).toEqual([]);
  });

  it("un stock sin ingreso registrado (ajuste) igual se evalúa, y UNIT usa sus unidades", () => {
    const items = lowRotation([row({ productId: "u", unitType: "UNIT", current: 24, lastInboundAt: null })], NOW);
    expect(items[0]?.reason).toBe("NO_SALES");
  });

  it("ordena primero los que no venden (el que hace más que no vende, primero; sin venta en 90 días al tope) y después los de mayor cobertura", () => {
    const items = lowRotation([
      row({ productId: "alto", productName: "Alto", current: 20_000, sold14d: 2_000, lastSaleAt: ago(3), lastInboundAt: settled }),
      row({ productId: "hace10", productName: "Hace diez", current: 5_000, lastSaleAt: ago(15), lastInboundAt: settled }),
      row({ productId: "nunca", productName: "Nunca", current: 2_000, lastSaleAt: null, lastInboundAt: settled }),
      row({ productId: "hace20", productName: "Hace veinte", current: 3_000, lastSaleAt: ago(40), lastInboundAt: settled })
    ], NOW);
    expect(items.map((item) => item.productId)).toEqual(["nunca", "hace20", "hace10", "alto"]);
  });

  it("puede excluir lo que ya figura en otro bloque (no repetir datos)", () => {
    const items = lowRotation([row({ productId: "x", current: 5_000, lastInboundAt: settled })], NOW, { exclude: new Set(["x"]) });
    expect(items).toEqual([]);
  });

  it("nunca emite una orden categórica: la etiqueta es sólo informativa", () => {
    const items = lowRotation([row({ current: 5_000, lastInboundAt: settled }), row({ productId: "q", current: 15_000, sold14d: 1_200, lastInboundAt: settled })], NOW);
    for (const item of items) expect(item.label).not.toMatch(/no mandar/i);
  });
});

describe("requiere atención", () => {
  const configured = (overrides: Partial<ConfiguredStockAlert>): ConfiguredStockAlert => ({ productId: "c", productName: "Configurado", unitType: "WEIGHT", current: 0, suggested: 5_000, rank: 0, ...overrides });

  it("A: un producto que vende bien y está sin stock genera la alerta más urgente", () => {
    const items = stockAttention([row({ productId: "pm", productName: "Pata muslo", current: 0, sold7d: 31_500 })], [], { isProductionBranch: false });
    expect(items[0]).toMatchObject({ productId: "pm", kind: "NO_STOCK_SELLING", severity: "critical", priority: 0 });
  });

  it("A: con menos de 1 día de cobertura es crítico y con 1–2 días advierte; con cobertura suficiente no genera alerta", () => {
    const base = { productName: "X", sold7d: 31_500 };
    const low = stockAttention([row({ ...base, productId: "a", current: 3_000 })], [], { isProductionBranch: false });
    const mid = stockAttention([row({ ...base, productId: "b", current: 6_000 })], [], { isProductionBranch: false });
    const fine = stockAttention([row({ ...base, productId: "c", current: 20_000 })], [], { isProductionBranch: false });
    expect(low[0]).toMatchObject({ kind: "LOW_COVERAGE", severity: "critical", priority: 1 });
    expect(mid[0]).toMatchObject({ kind: "LOW_COVERAGE", severity: "warning", priority: 3 });
    expect(mid[0]?.detail).toContain("≈ 1,3 días");
    expect(fine).toEqual([]);
  });

  it("un producto que casi no vende y está sin stock NO es una alerta de venta (sólo la del mínimo configurado, si existe)", () => {
    const items = stockAttention([row({ productId: "poco", current: 0, sold7d: 500 })], [], { isProductionBranch: false });
    expect(items).toEqual([]);
  });

  it("B: stock negativo, más urgente si además vende bien", () => {
    const items = stockAttention([row({ productId: "neg", current: -2_000, sold7d: 0 }), row({ productId: "negventa", current: -2_000, sold7d: 10_000 })], [], { isProductionBranch: false });
    expect(items.find((item) => item.productId === "negventa")).toMatchObject({ kind: "NEGATIVE", priority: 0 });
    expect(items.find((item) => item.productId === "neg")).toMatchObject({ kind: "NEGATIVE", priority: 2 });
  });

  it("C: inconsistencia entre ventas y ledger, con la cantidad que el sistema muestra de más", () => {
    const items = stockAttention([row({ productId: "pm", current: 16_500, sold7d: 9_000, mismatchTickets: 1, mismatchQuantity: 3_000 })], [], { isProductionBranch: false });
    expect(items[0]).toMatchObject({ kind: "INCONSISTENT", severity: "warning" });
    expect(items[0]?.detail).toContain("1 ticket");
    expect(items[0]?.detail).toContain("3,000 kg de más");
  });

  it("combina las alertas configuradas (mínimo/agotado) sin repetir productos y las deja después de las de venta", () => {
    const items = stockAttention(
      [row({ productId: "pm", productName: "Pata muslo", current: 0, sold7d: 31_500 })],
      [configured({ productId: "pm", productName: "Pata muslo" }), configured({ productId: "min", productName: "Bajo mínimo", current: 2_000, rank: 1 }), configured({ productId: "out", productName: "Agotado", rank: 0 })],
      { isProductionBranch: false }
    );
    expect(items.map((item) => item.productId)).toEqual(["pm", "out", "min"]);
    expect(items.map((item) => item.kind)).toEqual(["NO_STOCK_SELLING", "OUT_OF_STOCK", "LOW_STOCK"]);
  });

  it("Central (sucursal productiva) sólo conserva las alertas configuradas: la cobertura y la inconsistencia no la contaminan", () => {
    const items = stockAttention(
      [row({ productId: "pm", current: 0, sold7d: 31_500, mismatchTickets: 2, mismatchQuantity: 5_000 }), row({ productId: "neg", current: -1_000 })],
      [configured({ productId: "min", rank: 1, current: 1_000 })],
      { isProductionBranch: true }
    );
    expect(items.map((item) => item.productId)).toEqual(["min"]);
  });

  it("«producto con stock pero sin rotación» no se repite acá: vive en «Baja rotación»", () => {
    const items = stockAttention([row({ productId: "tapa", current: 7_400, sold7d: 0, sold14d: 0, lastInboundAt: ago(30) })], [], { isProductionBranch: false });
    expect(items).toEqual([]);
  });

  it("dentro de la misma prioridad, el que más vende primero; los umbrales son los documentados", () => {
    const items = stockAttention([
      row({ productId: "poco", productName: "Poco", current: 0, sold7d: 4_000 }),
      row({ productId: "mucho", productName: "Mucho", current: 0, sold7d: 40_000 })
    ], [], { isProductionBranch: false });
    expect(items.map((item) => item.productId)).toEqual(["mucho", "poco"]);
    expect(INSIGHT_RULES.sellsWell7d.WEIGHT).toBe(3_000);
  });

  it("UNIT: «vende bien» se mide en unidades (5 u en 7 días), no en gramos", () => {
    const items = stockAttention([row({ productId: "u", unitType: "UNIT", current: 0, sold7d: 6 }), row({ productId: "u2", unitType: "UNIT", current: 0, sold7d: 3 })], [], { isProductionBranch: false });
    expect(items.map((item) => item.productId)).toEqual(["u"]);
    expect(items[0]?.detail).toContain("u/día");
  });
});

describe("toInsightRows", () => {
  it("convierte las columnas de la RPC", () => {
    const rpc: InsightRpcRow = {
      product_id: "p1", product_name: "Pata muslo", unit_type: "WEIGHT", current_quantity: 1, sold_period: 2, revenue_period_cents: 3, sold_previous: 4,
      sold_7d: 5, sold_14d: 6, last_sale_at: "2026-10-10T10:00:00Z", last_inbound_at: null, ledger_mismatch_tickets: 7, ledger_mismatch_quantity: 8
    };
    expect(toInsightRows([rpc])[0]).toEqual({
      productId: "p1", productName: "Pata muslo", unitType: "WEIGHT", current: 1, soldPeriod: 2, revenuePeriodCents: 3, soldPrevious: 4,
      sold7d: 5, sold14d: 6, lastSaleAt: "2026-10-10T10:00:00Z", lastInboundAt: null, mismatchTickets: 7, mismatchQuantity: 8
    });
  });
});
