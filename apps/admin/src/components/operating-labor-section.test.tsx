import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }) }));
// El auto-refresco no dibuja nada: se lo reemplaza por una marca para comprobar CUÁNDO se monta.
vi.mock("./auto-refresh", () => ({ AutoRefresh: ({ intervalMs }: { intervalMs: number }) => <i data-auto-refresh={intervalMs} /> }));
vi.mock("../app/admin/actions", () => ({
  loadOperatingCostsAction: vi.fn(), saveRecurringCostAction: vi.fn(), endRecurringCostAction: vi.fn(), recordExpenseAction: vi.fn(), voidExpenseAction: vi.fn()
}));

import { resolveSalesRange } from "../lib/date-range";
import { toOperatingResult, type LaborReport, type OperatingResultRow } from "../lib/operating-costs";
import { HomeOperatingResults } from "./home-operating-results";
import { LaborSection } from "./operating-labor-section";
import { OperatingResultCard } from "./operating-result-card";

const employee = (overrides: Partial<LaborReport["employees"][number]> = {}): LaborReport["employees"][number] => ({
  employeeId: "e1", name: "Lucía", workedSeconds: 36_000, costCents: 4_000_000, minRateCents: 400_000, maxRateCents: 400_000, rateMissing: false, openShifts: 0, reviewShifts: 0, ...overrides
});
const labor = (overrides: Partial<LaborReport> = {}): LaborReport => ({
  costCents: 6_850_000, workedSeconds: 63_000, openShifts: 0, reviewShifts: 0, rateMissing: false, canSeeDetail: true,
  employees: [employee(), employee({ employeeId: "e2", name: "Mica", workedSeconds: 27_000, costCents: 2_850_000, minRateCents: 380_000, maxRateCents: 380_000 })], ...overrides
});
const today = { from: "2026-10-10", to: "2026-10-10" };

describe("«PERSONAL — automático» in Configurar costos", () => {
  it("lists each person with rate, hours and cost, and the total for today", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor()} period={today} today="2026-10-10" />);
    expect(html).toContain("PERSONAL — automático");
    expect(html).toContain("Lucía");
    expect(html).toContain("$ 4.000 / hora");
    expect(html).toContain("Hoy: 10 h");
    expect(html).toContain("Costo hoy: <strong");
    expect(html).toContain("$ 40.000");
    expect(html).toContain("Mica");
    expect(html).toContain("$ 3.800 / hora");
    expect(html).toContain("Hoy: 7 h 30 min");
    expect(html).toContain("$ 28.500");
    expect(html).toContain("TOTAL PERSONAL HOY");
    expect(html).toContain("$ 68.500");
    expect(html.match(/data-testid="labor-employee"/g)).toHaveLength(2);
  });

  it("makes clear it is automatic and that salaries are not loaded as monthly costs", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor()} period={today} today="2026-10-10" />);
    expect(html).toContain("Se calcula solo con las horas fichadas");
    expect(html).toContain("no cargues sueldos de empleadas como costo mensual");
  });

  it("is read-only: no field, no form, no button to load anything", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor()} period={today} today="2026-10-10" />);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("names a period other than today and says it is the period's cost", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor()} period={{ from: "2026-10-04", to: "2026-10-10" }} today="2026-10-10" />);
    expect(html).toContain("En el período: 10 h");
    expect(html).toContain("Costo del período");
    expect(html).toContain("TOTAL PERSONAL DEL 04/10/2026 AL 10/10/2026");
  });

  it("flags who is working now, a rate that changed inside the period, and a missing rate", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor({ employees: [
      employee({ openShifts: 1 }),
      employee({ employeeId: "e2", name: "Mica", minRateCents: 350_000, maxRateCents: 400_000 }),
      employee({ employeeId: "e3", name: "Sin", minRateCents: null, maxRateCents: null, rateMissing: true, costCents: 0, reviewShifts: 2 })
    ] })} period={today} today="2026-10-10" />);
    expect(html).toContain("Trabajando ahora");
    expect(html).toContain("$ 3.500 – $ 4.000 / hora");
    expect(html).toContain("Sin valor hora");
    expect(html).toContain("no tiene valor hora cargado");
    expect(html).toContain("2 fichadas a revisar");
  });

  it("with no hours in the period says so and totals $ 0", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor({ costCents: 0, workedSeconds: 0, employees: [] })} period={today} today="2026-10-10" />);
    expect(html).toContain("No hay horas fichadas en esta sucursal hoy.");
    expect(html).toContain("$ 0");
  });

  it("without the timekeeping permission shows only the total, never a rate", () => {
    const html = renderToStaticMarkup(<LaborSection labor={labor({ canSeeDetail: false, employees: [] })} period={today} today="2026-10-10" />);
    expect(html).toContain("requiere el permiso de control horario");
    expect(html).toContain("TOTAL PERSONAL HOY");
    expect(html).toContain("$ 68.500");
    expect(html).not.toContain("/ hora");
  });
});

const operatingRow = (overrides: Partial<OperatingResultRow> = {}) => toOperatingResult({
  branch_id: "b1", branch_name: "Avenida", revenue_cents: 20_500_000, gross_profit_cents: 10_000_000, recurring_cost_cents: 0, expense_cents: 0, operating_cost_cents: 6_600_000,
  operating_result_cents: 3_400_000, operating_margin_bps: 1_659, is_partial: false, missing_cost_items: 0, missing_cost_sales: 0, missing_cost_revenue_cents: 0,
  labor_cost_cents: 6_600_000, labor_worked_seconds: 59_400, labor_open_shifts: 0, labor_review_shifts: 0, labor_rate_missing: false, ...overrides
});

describe("Resumen de sucursal: sigue siendo UNA tarjeta, el personal ya está dentro", () => {
  const card = (overrides: Partial<OperatingResultRow> = {}) =>
    renderToStaticMarkup(<OperatingResultCard branchId="b1" branchName="Avenida" from="2026-10-10" result={operatingRow(overrides)} to="2026-10-10" />);

  it("shows the operating result with the labor already discounted and no extra «Costo personal» card", () => {
    const html = card();
    expect(html).toContain("Resultado operativo");
    expect(html).toContain("$ 34.000");
    expect(html).toContain("Ganancia bruta − $ 66.000 de costos operativos");
    expect(html).not.toContain("Costo personal");
    expect(html).not.toContain("Costo de personal");
    expect(html.match(/data-testid="operating-result-card"/g)).toHaveLength(1);
  });

  it("keeps the partial-gross-profit warning even though the labor is exact", () => {
    expect(card({ is_partial: true, missing_cost_items: 1 })).toContain("Parcial: existen ventas sin costo");
  });

  it("warns when some hours have no hourly rate", () => {
    expect(card({ labor_rate_missing: true })).toContain("Hay horas de personal sin valor hora cargado");
    expect(card()).not.toContain("sin valor hora");
  });

  it("refreshes itself (every 2 minutes) only while an open shift keeps the cost running", () => {
    expect(card({ labor_open_shifts: 1 })).toContain('data-auto-refresh="120000"');
    expect(card({ labor_open_shifts: 0 })).not.toContain("data-auto-refresh");
  });
});

describe("Inicio: el mismo resultado operativo, con el personal ya incluido", () => {
  const range = resolveSalesRange({ preset: "today" }, "America/Argentina/Buenos_Aires", new Date("2026-10-10T15:00:00Z"));
  const render = (results: ReturnType<typeof operatingRow>[]) =>
    renderToStaticMarkup(<HomeOperatingResults periodName="Hoy" productionBranchId={null} range={range} results={results} />);

  it("shows each branch's result (labor inside) and the total, with no separate labor card", () => {
    const html = render([operatingRow(), operatingRow({ branch_id: "b2", branch_name: "Janssen", operating_result_cents: -1_600_000, labor_cost_cents: 1_600_000 })]);
    expect(html).toContain("Avenida");
    expect(html).toContain("$ 34.000");
    expect(html).toContain("Janssen");
    expect(html).toContain("-$ 16.000");
    expect(html).toContain("$ 18.000");
    expect(html).not.toContain("Costo personal");
  });

  it("refreshes itself while any branch has an open shift, and not otherwise", () => {
    expect(render([operatingRow(), operatingRow({ branch_id: "b2", branch_name: "Janssen", labor_open_shifts: 1 })])).toContain('data-auto-refresh="120000"');
    expect(render([operatingRow()])).not.toContain("data-auto-refresh");
  });
});
