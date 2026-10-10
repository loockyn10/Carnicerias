import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveSalesRange } from "../lib/date-range";
import { toOperatingResult, type OperatingResultRow } from "../lib/operating-costs";
import { HomeOperatingResults } from "./home-operating-results";

const result = (id: string, name: string, cents: number, overrides: Partial<OperatingResultRow> = {}) => toOperatingResult({
  branch_id: id, branch_name: name, revenue_cents: 50_000_000, gross_profit_cents: cents, recurring_cost_cents: 0, expense_cents: 0, operating_cost_cents: 0,
  operating_result_cents: cents, operating_margin_bps: 2_000, is_partial: false, missing_cost_items: 0, missing_cost_sales: 0, missing_cost_revenue_cents: 0, ...overrides
});

const range = resolveSalesRange({ preset: "7d" }, "America/Argentina/Buenos_Aires", new Date("2026-10-10T15:00:00Z"));

function render(results: ReturnType<typeof result>[], productionBranchId: string | null = null) {
  return renderToStaticMarkup(<HomeOperatingResults periodName="7 días" productionBranchId={productionBranchId} range={range} results={results} />);
}

describe("Inicio: resultado operativo de las sucursales", () => {
  it("shows one compact card per branch and the total of the visible ones", () => {
    const html = render([result("a", "AVENIDA", 116_500_000), result("j", "JANSSEN", 84_000_000)]);
    expect(html).toContain("AVENIDA");
    expect(html).toContain("$ 1.165.000");
    expect(html).toContain("JANSSEN");
    expect(html).toContain("$ 840.000");
    expect(html).toContain("Resultado operativo total");
    expect(html).toContain("$ 2.005.000");
    expect(html.match(/data-testid="home-operating-branch"/g)).toHaveLength(2);
  });

  it("offers the same period selector as the rest of the app and keeps the chosen one active", () => {
    const html = render([result("a", "AVENIDA", 1_000)]);
    for (const label of ["Hoy", "Ayer", "7 días", "30 días"]) expect(html).toContain(label);
    expect(html).toContain('href="/admin?preset=30d"');
    expect(html).toMatch(/aria-current="true"[^>]*href="\/admin\?preset=7d"|href="\/admin\?preset=7d"[^>]*aria-current="true"/);
    expect(html).toContain("Resultado operativo · 7 días");
  });

  it("links each card to the branch detail for the same period", () => {
    expect(render([result("branch-1", "AVENIDA", 1_000)])).toContain(`href="/admin/branches/branch-1?from=${range.from}&amp;to=${range.to}"`);
  });

  it("does not show a total for a single branch and marks the Central", () => {
    const html = render([result("c", "CENTRAL", 5_000_000)], "c");
    expect(html).not.toContain("Resultado operativo total");
    expect(html).toContain("Central</span>");
  });

  it("shows losses in red and flags partial results on the card and on the total", () => {
    const html = render([result("a", "AVENIDA", -2_000_000, { is_partial: true }), result("j", "JANSSEN", 1_000_000)]);
    expect(html).toContain("-$ 20.000");
    expect(html).toContain("text-red-700");
    expect(html.match(/Parcial: existen ventas sin costo/g)?.length).toBe(2);
  });

  it("says so when there is no active branch", () => {
    expect(render([])).toContain("No hay sucursales activas");
  });
});
