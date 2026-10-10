import { describe, expect, it } from "vitest";

import { alertsText, buildBranchCards } from "./mobile-branches";

const CENTRAL = { id: "central", name: "Central" };
const AVENIDA = { id: "avenida", name: "Avenida" };
const JANSSEN = { id: "janssen", name: "Janssen" };

const sale = (branch: { id: string; name: string }, over: Record<string, number> = {}) => ({
  branch_id: branch.id, branch_name: branch.name, total_cents: 0, previous_total_cents: 0, sales_count: 0, weight_grams: 0, units: 0, ...over
});
const profit = (branch: { id: string; name: string }, over: Record<string, number> = {}) => ({
  branch_id: branch.id, branch_name: branch.name, revenue_cents: 0, costed_revenue_cents: 0, cost_cents: 0, gross_profit_cents: 0, gross_margin_bps: 0, missing_cost_items: 0, missing_cost_revenue_cents: 0, missing_cost_sales: 0, ...over
});
const stock = (branch: { id: string; name: string }, out: number, low: number) => ({ branch_id: branch.id, branch_name: branch.name, product_count: 20, out_of_stock_count: out, low_stock_count: low });

describe("tarjetas de «Ver sucursales»", () => {
  const input = {
    branches: [JANSSEN, CENTRAL, AVENIDA], productionBranchId: CENTRAL.id,
    sales: [
      sale(AVENIDA, { total_cents: 32_540_000, weight_grams: 42_500, sales_count: 31 }),
      sale(JANSSEN, { total_cents: 18_000_000, weight_grams: 20_000, units: 12, sales_count: 14 })
    ],
    profit: [
      profit(AVENIDA, { revenue_cents: 32_540_000, costed_revenue_cents: 32_540_000, gross_profit_cents: 8_730_000, gross_margin_bps: 2_683 }),
      profit(JANSSEN, { revenue_cents: 18_000_000, costed_revenue_cents: 15_000_000, gross_profit_cents: 4_000_000, gross_margin_bps: 2_667, missing_cost_items: 2 })
    ],
    stock: [stock(AVENIDA, 1, 1), stock(JANSSEN, 0, 0), stock(CENTRAL, 0, 3)]
  };

  it("junta ventas, ganancia y alertas de la MISMA sucursal (sin mezclar)", () => {
    const [avenida] = buildBranchCards(input);
    expect(avenida).toMatchObject({
      id: "avenida", revenueCents: 32_540_000, grams: 42_500, tickets: 31, profitCents: 8_730_000, marginBps: 2_683, alerts: 2, outOfStock: 1, missingCostItems: 0, isProduction: false
    });
  });

  it("las sucursales para vender van primero (por nombre) y la productiva —el depósito— al final", () => {
    expect(buildBranchCards(input).map((card) => card.name)).toEqual(["Avenida", "Janssen", "Central"]);
    expect(buildBranchCards(input).map((card) => card.isProduction)).toEqual([false, false, true]);
  });

  it("una sucursal sin ventas ni filas muestra ceros (nunca datos de otra) y la ganancia 0", () => {
    const central = buildBranchCards(input).find((card) => card.id === "central");
    expect(central).toMatchObject({ revenueCents: 0, grams: 0, tickets: 0, units: 0, profitCents: 0, marginBps: null, alerts: 3 });
  });

  it("aislamiento: ignora filas de sucursales que no están en la lista", () => {
    const foreign = { id: "otra-org", name: "Otra" };
    const cards = buildBranchCards({ ...input, sales: [...input.sales, sale(foreign, { total_cents: 99_999_999 })], profit: [...input.profit, profit(foreign, { gross_profit_cents: 99_999_999 })], stock: [...input.stock, stock(foreign, 9, 9)] });
    expect(cards.map((card) => card.id)).toEqual(["avenida", "janssen", "central"]);
    expect(cards.reduce((sum, card) => sum + card.revenueCents, 0)).toBe(50_540_000);
  });

  it("si la ganancia no se pudo calcular muestra «—» (null), no un 0 inventado", () => {
    const [avenida] = buildBranchCards({ ...input, profit: null });
    expect(avenida).toMatchObject({ profitCents: null, marginBps: null });
  });

  it("avisa cuando hay ventas sin costo (la ganancia puede estar incompleta)", () => {
    expect(buildBranchCards(input).find((card) => card.id === "janssen")?.missingCostItems).toBe(2);
  });

  it("el margen sólo se muestra si hubo ventas con costo conocido", () => {
    const [avenida] = buildBranchCards({ ...input, profit: [profit(AVENIDA, { revenue_cents: 5_000, costed_revenue_cents: 0, gross_profit_cents: 0, gross_margin_bps: 0, missing_cost_items: 3 })] });
    expect(avenida?.marginBps).toBeNull();
  });

  it("textos de alertas", () => {
    expect(alertsText(0)).toBe("Sin alertas");
    expect(alertsText(1)).toBe("1 alerta");
    expect(alertsText(2)).toBe("2 alertas");
  });
});
