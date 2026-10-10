import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchSummary, type BranchProfitability } from "./branch-summary";

const metrics = { grossCents: 10_000_000, kilograms: 10, units: 0, salesCount: 4, averageTicketCents: 2_500_000 };
const full: BranchProfitability = { grossProfitCents: 4_000_000, grossMarginBps: 4000, missingCostItems: 0, missingCostSales: 0, missingCostRevenueCents: 0 };

function render(profit: BranchProfitability | null, overrides: Partial<typeof metrics> = {}) {
  return renderToStaticMarkup(<BranchSummary board={null} branchId="b1" branchName="Avenida" change={null} comparisonLabel="ayer" isProduction={false} metrics={{ ...metrics, ...overrides }} periodLabel="hoy" profit={profit} range={{ from: "2026-10-09", to: "2026-10-09" }} stockCounts={{ out: 0, low: 0, normal: 0 }} timeZone="America/Argentina/Buenos_Aires" />);
}

describe("BranchSummary profitability cards", () => {
  it("shows gross profit and gross margin, labelled as before operating expenses", () => {
    const html = render(full);
    expect(html).toContain("Ganancia bruta");
    expect(html).toContain("Margen bruto");
    expect(html).toContain("40 %");
    expect(html).toContain("Antes de gastos operativos");
    expect(html).not.toContain("sin costo conocido");
  });

  it("formats a fractional margin with a decimal comma", () => {
    expect(render({ ...full, grossMarginBps: 3393 })).toContain("33,93 %");
  });

  it("shows a dash instead of NaN when there is no margin (no sales or no costed lines)", () => {
    const html = render({ ...full, grossProfitCents: 0, grossMarginBps: null }, { grossCents: 0, salesCount: 0, averageTicketCents: 0 });
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
  });

  it("warns about lines without a known cost and the amount left out of the profit", () => {
    const html = render({ ...full, missingCostItems: 3, missingCostSales: 2, missingCostRevenueCents: 800_000 });
    expect(html).toContain("3 líneas");
    expect(html).toContain("sin costo conocido");
    expect(html).toContain("vendidos fuera de la ganancia");
  });

  it("turns the warning into a button that opens the repair modal (and says how)", () => {
    const html = render({ ...full, missingCostItems: 11, missingCostSales: 8, missingCostRevenueCents: 21_851_000 });
    expect(html).toContain("<button");
    expect(html).toContain("11 líneas sin costo conocido");
    expect(html).toContain("$ 218.510");
    expect(html).toContain("Completar costos");
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("shows no warning (and no button) when every line has a cost", () => {
    const html = render(full);
    expect(html).not.toContain("Completar costos");
  });

  it("omits the profitability cards when the data is not available", () => {
    const html = render(null);
    expect(html).not.toContain("Ganancia bruta");
    expect(html).not.toContain("Margen bruto");
  });

  it("keeps units sold alongside the profitability row", () => {
    const html = render(full, { units: 12 });
    expect(html).toContain("Unidades vendidas");
    expect(html).toContain("Ganancia bruta");
  });
});
