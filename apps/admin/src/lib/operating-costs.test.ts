import { describe, expect, it } from "vitest";

import {
  describeRecurring, describeVersion, firstDayOfMonth, formatResult, formatShortDate, monthlyLabel, parseEndForm, parseExpenseForm, parseMonthlyForm,
  parseOperatingCosts, sumOperatingResults, toOperatingResult, visibleHistory, type OperatingResultRow
} from "./operating-costs";

const row = (overrides: Partial<OperatingResultRow> = {}): OperatingResultRow => ({
  branch_id: "b1", branch_name: "Avenida", revenue_cents: 250_000_000, gross_profit_cents: 100_000_000, recurring_cost_cents: 3_000_000, expense_cents: 5_000_000,
  operating_cost_cents: 8_000_000, operating_result_cents: 92_000_000, operating_margin_bps: 3_680, is_partial: false, missing_cost_items: 0,
  missing_cost_sales: 0, missing_cost_revenue_cents: 0, ...overrides
});

const raw = {
  canWrite: true, timezone: "America/Argentina/Buenos_Aires", today: "2026-10-10", period: { from: "2026-10-01", to: "2026-10-10" },
  recurring: [
    { id: "c1", name: "Alquiler", imputedCents: 4_500_000, history: [
      { id: "v1", amountCents: 45_000_000, from: "2026-01-01", to: "2026-10-01" },
      { id: "v2", amountCents: 50_000_000, from: "2026-10-01", to: null }
    ] },
    { id: "c2", name: "Internet", imputedCents: 0, history: [{ id: "v3", amountCents: 3_500_000, from: "2026-01-01", to: "2026-06-01" }] },
    { id: "c3", name: "Seguro", imputedCents: 0, history: [{ id: "v4", amountCents: 1_000_000, from: "2026-11-01", to: null }] }
  ],
  expenses: [{ id: "e1", date: "2026-10-10", concept: "Reparación heladera", amountCents: 7_000_000, inPeriod: true }, { id: "e2", date: "2026-08-10", concept: "Factura de luz", amountCents: 18_000_000, inPeriod: false }],
  recurringCents: 4_500_000, expenseCents: 7_000_000, operatingCostCents: 11_500_000
};

describe("operating result", () => {
  it("maps the server row without recomputing anything", () => {
    const result = toOperatingResult(row());
    expect(result).toMatchObject({ branchName: "Avenida", grossProfitCents: 100_000_000, operatingCostCents: 8_000_000, resultCents: 92_000_000, marginBps: 3_680, partial: false });
  });

  it("keeps the partial flag and a null margin when there were no sales", () => {
    const result = toOperatingResult(row({ is_partial: true, operating_margin_bps: null, missing_cost_items: 2 }));
    expect(result.partial).toBe(true);
    expect(result.marginBps).toBeNull();
    expect(result.missingCostItems).toBe(2);
  });

  it("formats a loss with the minus sign in front of the $", () => {
    expect(formatResult(116_500_000)).toBe("$ 1.165.000");
    expect(formatResult(-12_000_000)).toBe("-$ 120.000");
  });

  it("totals the visible branches and is partial when any branch is", () => {
    const total = sumOperatingResults([toOperatingResult(row({ operating_result_cents: 116_500_000 })), toOperatingResult(row({ branch_id: "b2", operating_result_cents: 84_000_000, is_partial: true }))]);
    expect(total).toEqual({ resultCents: 200_500_000, partial: true, branches: 2 });
    expect(sumOperatingResults([])).toEqual({ resultCents: 0, partial: false, branches: 0 });
  });
});

describe("parseOperatingCosts", () => {
  const report = parseOperatingCosts(raw);

  it("reads the totals, the permission and the period", () => {
    expect(report).toMatchObject({ canWrite: true, today: "2026-10-10", period: { from: "2026-10-01", to: "2026-10-10" }, recurringCents: 4_500_000, expenseCents: 7_000_000, operatingCostCents: 11_500_000 });
  });

  it("shows the amount in force today and keeps the history (the old amount is not rewritten)", () => {
    const rent = report.recurring.find((cost) => cost.name === "Alquiler");
    expect(rent).toMatchObject({ status: "ACTIVE", amountCents: 50_000_000, amountFrom: "2026-10-01", lastDay: null, imputedCents: 4_500_000 });
    expect(rent?.history.map((version) => version.amountCents)).toEqual([45_000_000, 50_000_000]);
  });

  it("tells a stopped cost from a scheduled one", () => {
    expect(report.recurring.find((cost) => cost.name === "Internet")).toMatchObject({ status: "ENDED", lastDay: "2026-05-31", amountCents: 3_500_000 });
    expect(report.recurring.find((cost) => cost.name === "Seguro")).toMatchObject({ status: "SCHEDULED", amountFrom: "2026-11-01" });
  });

  it("flags the expenses that fall inside the period", () => {
    expect(report.expenses.map((expense) => [expense.concept, expense.inPeriod])).toEqual([["Reparación heladera", true], ["Factura de luz", false]]);
  });

  it("drops malformed rows instead of breaking, and rejects a malformed response", () => {
    const partial = parseOperatingCosts({ ...raw, recurring: [{ id: "x" }, ...raw.recurring], expenses: [{ id: "bad", date: "ayer" }, ...raw.expenses] });
    expect(partial.recurring).toHaveLength(3);
    expect(partial.expenses).toHaveLength(2);
    expect(() => parseOperatingCosts({ ...raw, today: "hoy" })).toThrow();
    expect(() => parseOperatingCosts(null)).toThrow();
  });

  it("describes versions the way the owner reads them", () => {
    const [first, second] = report.recurring[0]?.history ?? [];
    expect(first && describeVersion(first, "2026-10-10")).toBe("01/01 → 30/09: $ 450.000 / mes");
    expect(second && describeVersion(second, "2026-10-10")).toBe("01/10 → vigente: $ 500.000 / mes");
    expect(monthlyLabel(90_000_000)).toBe("$ 900.000 / mes");
  });
});

describe("helpers", () => {
  it("describeRecurring covers active, scheduled, ended and empty histories", () => {
    expect(describeRecurring([], "2026-10-10")).toBeNull();
    expect(describeRecurring([{ id: "a", amountCents: 1, from: "2026-01-01", to: "2026-10-11" }], "2026-10-10")?.status).toBe("ACTIVE");
    expect(describeRecurring([{ id: "a", amountCents: 1, from: "2026-01-01", to: "2026-10-10" }], "2026-10-10")?.status).toBe("ENDED");
  });

  it("hides the emptied same-day correction versions from the history", () => {
    const cost = parseOperatingCosts(raw).recurring[0];
    expect(cost && visibleHistory({ ...cost, history: [{ id: "x", amountCents: 1, from: "2026-05-01", to: "2026-05-01" }, ...cost.history] })).toHaveLength(2);
  });

  it("formats short dates without the year inside the current year", () => {
    expect(formatShortDate("2026-10-08", "2026-10-10")).toBe("08/10");
    expect(formatShortDate("2025-12-31", "2026-10-10")).toBe("31/12/2025");
    expect(firstDayOfMonth("2026-10-10")).toBe("2026-10-01");
  });
});

describe("forms", () => {
  it("accepts a monthly cost and converts the amount to integer cents", () => {
    expect(parseMonthlyForm({ name: " Alquiler ", amount: "450000", from: "2026-10-01" })).toEqual({ ok: true, value: { name: "Alquiler", amountCents: 45_000_000, from: "2026-10-01" } });
    expect(parseMonthlyForm({ name: "Internet", amount: "35000,50", from: "2026-10-01" })).toMatchObject({ ok: true, value: { amountCents: 3_500_050 } });
  });

  it("rejects an empty name, a bad amount and a bad date", () => {
    expect(parseMonthlyForm({ name: " ", amount: "1", from: "2026-10-01" }).ok).toBe(false);
    expect(parseMonthlyForm({ name: "x", amount: "0", from: "2026-10-01" }).ok).toBe(false);
    expect(parseMonthlyForm({ name: "x", amount: "abc", from: "2026-10-01" }).ok).toBe(false);
    expect(parseMonthlyForm({ name: "x", amount: "10", from: "01/10/2026" }).ok).toBe(false);
  });

  it("validates an expense and refuses a future date", () => {
    expect(parseExpenseForm({ date: "2026-10-10", concept: "Reparación", amount: "70000" }, "2026-10-10")).toEqual({ ok: true, value: { date: "2026-10-10", concept: "Reparación", amountCents: 7_000_000 } });
    expect(parseExpenseForm({ date: "2026-10-11", concept: "Reparación", amount: "70000" }, "2026-10-10").ok).toBe(false);
    expect(parseExpenseForm({ date: "2026-10-10", concept: "", amount: "70000" }, "2026-10-10").ok).toBe(false);
    expect(parseExpenseForm({ date: "2026-10-10", concept: "x", amount: "-5" }, "2026-10-10").ok).toBe(false);
  });

  it("validates the stop date", () => {
    expect(parseEndForm({ date: "2026-11-01" })).toEqual({ ok: true, value: "2026-11-01" });
    expect(parseEndForm({ date: "" }).ok).toBe(false);
  });
});
