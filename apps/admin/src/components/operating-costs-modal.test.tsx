import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }) }));
vi.mock("../app/admin/actions", () => ({
  loadOperatingCostsAction: vi.fn(), saveRecurringCostAction: vi.fn(), endRecurringCostAction: vi.fn(), recordExpenseAction: vi.fn(), voidExpenseAction: vi.fn()
}));

import { OperatingCostsModal } from "./operating-costs-modal";
import { OperatingResultCard } from "./operating-result-card";
import { toOperatingResult } from "../lib/operating-costs";

describe("OperatingCostsModal", () => {
  it("opens as a dialog titled with the branch and shows a loading state before the server answers", () => {
    const html = renderToStaticMarkup(<OperatingCostsModal branchId="b1" branchName="Avenida" from="2026-10-01" onClose={() => undefined} to="2026-10-10" />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Costos operativos — AVENIDA");
    expect(html).toContain("Cargando");
  });
});

describe("OperatingResultCard", () => {
  const result = toOperatingResult({
    branch_id: "b1", branch_name: "Avenida", revenue_cents: 10_000_000, gross_profit_cents: 4_000_000, recurring_cost_cents: 0, expense_cents: 0, operating_cost_cents: 0,
    operating_result_cents: 4_000_000, operating_margin_bps: null, is_partial: false, missing_cost_items: 0, missing_cost_sales: 0, missing_cost_revenue_cents: 0
  });

  it("keeps the modal closed until «Configurar costos» is pressed", () => {
    const html = renderToStaticMarkup(<OperatingResultCard branchId="b1" branchName="Avenida" from="2026-10-01" result={result} to="2026-10-10" />);
    expect(html).toContain("Configurar costos");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("NaN");
  });
});
