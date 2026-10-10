import { describe, expect, it } from "vitest";

import {
  formatHourlyRate, formatWorked, hasOpenLaborShifts, laborPeriodName, looksLikePersonnelCost, parseOperatingCosts, sumOperatingResults, toOperatingResult,
  type OperatingResultRow
} from "./operating-costs";

const row = (overrides: Partial<OperatingResultRow> = {}): OperatingResultRow => ({
  branch_id: "b1", branch_name: "Avenida", revenue_cents: 20_500_000, gross_profit_cents: 10_000_000, recurring_cost_cents: 0, expense_cents: 0,
  operating_cost_cents: 6_600_000, operating_result_cents: 3_400_000, operating_margin_bps: 1_659, is_partial: false, missing_cost_items: 0,
  missing_cost_sales: 0, missing_cost_revenue_cents: 0, labor_cost_cents: 6_600_000, labor_worked_seconds: 59_400, labor_open_shifts: 0,
  labor_review_shifts: 0, labor_rate_missing: false, ...overrides
});

const rawBase = {
  canWrite: true, today: "2026-10-10", period: { from: "2026-10-10", to: "2026-10-10" }, recurring: [], expenses: [],
  recurringCents: 0, expenseCents: 0, laborCents: 6_800_000, operatingCostCents: 6_800_000
};

describe("labor in the operating result row", () => {
  it("maps the labor columns without recomputing the result", () => {
    const result = toOperatingResult(row());
    expect(result).toMatchObject({ laborCostCents: 6_600_000, laborWorkedSeconds: 59_400, laborOpenShifts: 0, laborReviewShifts: 0, laborRateMissing: false, operatingCostCents: 6_600_000, resultCents: 3_400_000 });
  });

  it("a server without the labor migration (no labor columns) counts as no labor, not as an error", () => {
    const legacy: OperatingResultRow = { ...row() };
    delete legacy.labor_cost_cents; delete legacy.labor_worked_seconds; delete legacy.labor_open_shifts; delete legacy.labor_review_shifts; delete legacy.labor_rate_missing;
    expect(toOperatingResult(legacy)).toMatchObject({ laborCostCents: 0, laborWorkedSeconds: 0, laborOpenShifts: 0, laborReviewShifts: 0, laborRateMissing: false });
  });

  it("exact labor does not make a partial gross profit exact: partial stays as the server says", () => {
    expect(toOperatingResult(row({ is_partial: true, missing_cost_items: 1 }))).toMatchObject({ partial: true, laborCostCents: 6_600_000 });
    expect(sumOperatingResults([toOperatingResult(row({ is_partial: true })), toOperatingResult(row({ branch_id: "b2" }))]).partial).toBe(true);
  });

  it("the Home total is the plain sum of what the server computed for each branch (labor already inside)", () => {
    const total = sumOperatingResults([toOperatingResult(row({ operating_result_cents: 3_400_000 })), toOperatingResult(row({ branch_id: "b2", operating_result_cents: -1_600_000 }))]);
    expect(total.resultCents).toBe(1_800_000);
  });

  it("knows when some branch has an open shift (the screen refreshes itself) and when none does", () => {
    expect(hasOpenLaborShifts([toOperatingResult(row()), toOperatingResult(row({ branch_id: "b2", labor_open_shifts: 1 }))])).toBe(true);
    expect(hasOpenLaborShifts([toOperatingResult(row())])).toBe(false);
    expect(hasOpenLaborShifts([])).toBe(false);
  });
});

describe("parsing the «Personal» block of the cost modal", () => {
  const labor = {
    costCents: 6_800_000, workedSeconds: 63_000, openShifts: 1, reviewShifts: 0, rateMissing: false, canSeeDetail: true,
    employees: [
      { employeeId: "e1", name: "Lucía", workedSeconds: 36_000, costCents: 4_000_000, minRateCents: 400_000, maxRateCents: 400_000, rateMissing: false, openShifts: 0, reviewShifts: 0 },
      { employeeId: "e2", name: "Mica", workedSeconds: 27_000, costCents: 2_800_000, minRateCents: 380_000, maxRateCents: 400_000, rateMissing: false, openShifts: 1, reviewShifts: 0 },
      { employeeId: "bad", name: 7 }
    ]
  };

  it("reads the totals and the per-person detail, dropping malformed rows", () => {
    const report = parseOperatingCosts({ ...rawBase, labor });
    expect(report.labor).toMatchObject({ costCents: 6_800_000, workedSeconds: 63_000, openShifts: 1, canSeeDetail: true });
    expect(report.labor?.employees.map((employee) => employee.name)).toEqual(["Lucía", "Mica"]);
    expect(report.operatingCostCents).toBe(6_800_000);
  });

  it("without the labor block (older server) the modal simply has no Personal section", () => {
    expect(parseOperatingCosts(rawBase).labor).toBeNull();
    expect(parseOperatingCosts({ ...rawBase, labor: "x" }).labor).toBeNull();
    expect(parseOperatingCosts({ ...rawBase, labor: { costCents: "1" } }).labor).toBeNull();
  });

  it("without timekeeping permission the detail comes empty and says so", () => {
    const report = parseOperatingCosts({ ...rawBase, labor: { ...labor, canSeeDetail: false, employees: [] } });
    expect(report.labor).toMatchObject({ canSeeDetail: false, employees: [] });
  });
});

describe("how hours and rates are shown", () => {
  it("shows the exact minutes: 10 h, 6 h 30 min, 45 min — never rounded to whole hours", () => {
    expect(formatWorked(36_000)).toBe("10 h");
    expect(formatWorked(23_400)).toBe("6 h 30 min");
    expect(formatWorked(2_700)).toBe("45 min");
    expect(formatWorked(0)).toBe("0 min");
    expect(formatWorked(-5)).toBe("0 min");
  });

  it("shows one rate, a range if it changed inside the period, or that it is missing", () => {
    expect(formatHourlyRate({ minRateCents: 400_000, maxRateCents: 400_000 })).toBe("$ 4.000 / hora");
    expect(formatHourlyRate({ minRateCents: 350_000, maxRateCents: 400_000 })).toBe("$ 3.500 – $ 4.000 / hora");
    expect(formatHourlyRate({ minRateCents: null, maxRateCents: null })).toBe("Sin valor hora");
  });

  it("names the period for the total line", () => {
    expect(laborPeriodName({ from: "2026-10-10", to: "2026-10-10" }, "2026-10-10")).toBe("hoy");
    expect(laborPeriodName({ from: "2026-10-09", to: "2026-10-09" }, "2026-10-10")).toBe("el 09/10/2026");
    expect(laborPeriodName({ from: "2026-10-04", to: "2026-10-10" }, "2026-10-10")).toBe("del 04/10/2026 al 10/10/2026");
  });
});

describe("double counting guard", () => {
  it("flags monthly costs that look like an employee salary", () => {
    for (const name of ["Sueldo Lucía", "Empleada", "sueldos", "Personal", "Salario encargada", "Jornales", "Mano de obra", "Nómina"]) {
      expect(looksLikePersonnelCost(name), name).toBe(true);
    }
  });

  it("does not flag rent, internet or electricity", () => {
    for (const name of ["Alquiler", "Internet", "Luz", "Seguro", "Alarma", "Contador", "Impuestos municipales"]) {
      expect(looksLikePersonnelCost(name), name).toBe(false);
    }
  });
});
