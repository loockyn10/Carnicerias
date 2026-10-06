import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialCarryInputs, type CarryPlanReport, type CarryPlanRow } from "../lib/carry-plan";
import { CarryPlanReportView } from "./carry-plan-report";

const BA = "America/Argentina/Buenos_Aires";
const row = (overrides: Partial<CarryPlanRow>): CarryPlanRow => ({
  branchId: "av", branchName: "Avenida", productId: "p", productName: "Producto", unitType: "WEIGHT",
  soldQuantity: 0, currentQuantity: 0, suggestedQuantity: 0, ...overrides
});
const rows = [
  row({ productId: "molida", productName: "Molida", soldQuantity: 18_000, currentQuantity: 4_000, suggestedQuantity: 14_000 }),
  row({ productId: "vacio", productName: "Vacío", soldQuantity: 9_000, currentQuantity: 1_000, suggestedQuantity: 8_000 }),
  row({ productId: "matambre", productName: "Matambre", soldQuantity: 3_000, currentQuantity: 4_000, suggestedQuantity: 0 }),
  row({ productId: "ham", productName: "Hamburguesa", unitType: "UNIT", soldQuantity: 30, currentQuantity: 10, suggestedQuantity: 20 })
];
const report: CarryPlanReport = { calculatedAt: "2026-10-06T17:30:00Z", windowStart: "2026-09-30T03:00:00Z", windowDays: 7, rows };
const noop = () => undefined;

function render(overrides: Partial<Parameters<typeof CarryPlanReportView>[0]> = {}) {
  return renderToStaticMarkup(<CarryPlanReportView branchName="Avenida" inputs={initialCarryInputs(rows)} onInput={noop} onReset={noop} onShowAll={noop} report={report} showAll={false} single timeZone={BA} {...overrides} />);
}

describe("CarryPlanReportView", () => {
  const html = render();

  it("titles the report with the branch and the org-local calculation time", () => {
    expect(html).toContain("Qué llevar a Avenida");
    expect(html).toContain("Calculado: 06/10/2026 14:30");
    expect(html).toContain("desde el 30/09/2026");
  });

  it("shows sold / stock / suggested for each product in its own unit", () => {
    expect(html).toContain("18,000 kg");
    expect(html).toContain("4,000 kg");
    expect(html).toContain("14,000 kg");
    expect(html).toContain("8,000 kg");
    expect(html).toContain("30 u");
    expect(html).toContain("20 u");
  });

  it("starts 'A llevar ahora' equal to the suggestion (kg with comma, whole units)", () => {
    expect(html).toMatch(/aria-label="A llevar ahora de Molida en Avenida"[^>]*value="14"/);
    expect(html).toMatch(/aria-label="A llevar ahora de Hamburguesa en Avenida"[^>]*value="20"/);
  });

  it("hides products that need nothing and offers to show them with their count", () => {
    expect(html).not.toContain("Matambre");
    expect(html).toContain("Mostrar sin necesidad (1)");
    expect(render({ showAll: true })).toContain("Matambre");
  });

  it("totals what will be carried, kilograms and units apart", () => {
    expect(html).toContain("Total a llevar: <strong>22,000 kg + 20 u</strong>");
  });

  it("recomputes the total from the edited quantities and flags an invalid one", () => {
    const edited = render({ inputs: { ...initialCarryInputs(rows), "av:molida": "10", "av:vacio": "-3" } });
    expect(edited).toContain("<strong>10,000 kg + 20 u</strong>");
    expect(edited).toMatch(/aria-label="A llevar ahora de Vacío en Avenida"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*aria-label="A llevar ahora de Vacío en Avenida"/);
  });

  it("says plainly that it is a report only", () => {
    expect(html).toContain("no crea transferencias ni mueve stock");
  });

  it("negative ledger stock reads as 'Sin stock' with the shortfall", () => {
    const negative = renderToStaticMarkup(<CarryPlanReportView inputs={{ "ja:molida": "9" }} onInput={noop} onReset={noop} onShowAll={noop} report={{ ...report, rows: [row({ branchId: "ja", branchName: "Janssen", productId: "molida", productName: "Molida", soldQuantity: 9_000, currentQuantity: -2_000, suggestedQuantity: 9_000 })] }} showAll={false} single={false} timeZone={BA} />);
    expect(negative).toContain("Sin stock");
    expect(negative).toContain("Faltante -2,000 kg".replace("-", ""));
    expect(negative).toContain("Janssen");
  });

  it("an all-branches report keeps one section per destination", () => {
    const both = renderToStaticMarkup(<CarryPlanReportView inputs={initialCarryInputs([...rows, row({ branchId: "ja", branchName: "Janssen", productId: "molida", productName: "Molida", soldQuantity: 9_000, suggestedQuantity: 9_000 })])} onInput={noop} onReset={noop} onShowAll={noop} report={{ ...report, rows: [...rows, row({ branchId: "ja", branchName: "Janssen", productId: "molida", productName: "Molida", soldQuantity: 9_000, suggestedQuantity: 9_000 })] }} showAll={false} single={false} timeZone={BA} />);
    expect(both).toContain(">Avenida</h3>");
    expect(both).toContain(">Janssen</h3>");
    expect(both).not.toContain("Qué llevar a");
  });

  it("explains an empty result instead of rendering an empty table", () => {
    const nothing = render({ report: { ...report, rows: [row({ productId: "matambre", productName: "Matambre", soldQuantity: 3_000, currentQuantity: 4_000, suggestedQuantity: 0 })] } });
    expect(nothing).toContain("No hace falta llevar nada");
    expect(nothing).not.toContain("<table");
  });
});
