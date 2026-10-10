import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MissingCostProduct, MissingCostsReport } from "../lib/missing-costs";
import { MissingCostsPanel, type MissingCostsPanelProps } from "./missing-costs-modal";

const BA = "America/Argentina/Buenos_Aires";
const pata: MissingCostProduct = {
  productId: "pata", productName: "Pata muslo", unitType: "WEIGHT", quantity: 12_500, lineCount: 4, revenueCents: 7_250_000,
  currentCostCents: 380_000, currentPriceCents: 633_350, marginBps: 4_000, repricesOnCostChange: true,
  lines: [
    { lineId: "l1", saleId: "abcdef12-0000-4000-8000-000000000001", soldAt: "2026-10-09T13:32:00Z", quantity: 2_500, revenueCents: 1_250_000 },
    { lineId: "l2", saleId: "abcdef12-0000-4000-8000-000000000002", soldAt: "2026-10-09T16:41:00Z", quantity: 3_100, revenueCents: 1_550_000 }
  ]
};
const coca: MissingCostProduct = {
  productId: "coca", productName: "Coca Cola", unitType: "UNIT", quantity: 8, lineCount: 5, revenueCents: 3_200_000,
  currentCostCents: null, currentPriceCents: 400_000, marginBps: null, repricesOnCostChange: false,
  lines: [{ lineId: "l3", saleId: "00000000-0000-4000-8000-000000000003", soldAt: "2026-10-09T17:00:00Z", quantity: 3, revenueCents: 1_200_000 }]
};
const report: MissingCostsReport = { canRepair: true, timezone: BA, totalLines: 9, totalRevenueCents: 10_450_000, truncated: false, products: [pata, coca] };
const noop = () => undefined;

function render(overrides: Partial<MissingCostsPanelProps> = {}) {
  return renderToStaticMarkup(<MissingCostsPanel alsoSet={{}} done={[]} expanded={new Set()} inputs={{}} onAlsoSet={noop} onInput={noop} onSave={noop} onToggleLines={noop} report={report} rowErrors={{}} savingProductId={null} timeZone={BA} {...overrides} />);
}

describe("MissingCostsPanel", () => {
  it("groups the missing lines by product with quantity, lines and revenue", () => {
    const html = render();
    expect(html).toContain("Pata muslo");
    expect(html).toContain("12,500 kg");
    expect(html).toContain("$ 72.500");
    expect(html).toContain("Coca Cola");
    expect(html).toContain("8 u");
    expect(html).toContain("$ 32.000");
    expect(html).toContain(">Facturación<");
  });

  it("asks for the cost in the right unit: $/kg for WEIGHT, $/u for UNIT", () => {
    const html = render();
    expect(html).toContain("Costo de Pata muslo por kg");
    expect(html).toContain("Costo de Coca Cola por unidad");
    expect(html).toContain(">/kg<");
    expect(html).toContain(">/u<");
  });

  it("offers the current cost only as a suggestion to confirm", () => {
    const html = render();
    expect(html).toContain("Costo actual:");
    expect(html).toContain("$ 3.800/kg");
    expect(html).toContain("Usar $ 3.800");
    expect(html).toContain("confirmá que era el costo de esas ventas");
    expect(html).not.toContain("Usar $ 2.000");
  });

  it("does not tick «also save as current cost» for a product whose sale price would change, and explains why", () => {
    const html = render();
    expect(html).toContain("No viene tildado porque cambiaría el precio de venta");
    expect(html).toContain("hoy $ 6.333,50/kg");
    expect(html).toContain("Completar costo histórico");
  });

  it("warns, with the margin and today's price, when the user ticks it for a product that reprices", () => {
    const html = render({ alsoSet: { pata: true } });
    expect(html).toContain("Esto también recalcula el precio de venta (margen 40 %)");
    expect(html).toContain("Completar y actualizar costo y precio");
    expect(html).toContain('role="alert"');
  });

  it("ticks it by default when nothing about the price can change", () => {
    const html = render({ report: { ...report, products: [coca] } });
    expect(html).toContain("Completar y guardar costo actual");
    expect(html).not.toContain("recalcula el precio de venta");
  });

  it("shows the exact cost of the lines for the typed cost (per line, integer arithmetic)", () => {
    const html = render({ inputs: { pata: "3800" } });
    // 2,500 kg x 3.800 = 9.500 and 3,100 kg x 3.800 = 11.780 -> 21.280
    expect(html).toContain("Costo de estas líneas:");
    expect(html).toContain("$ 21.280");
  });

  it("flags an invalid cost and keeps the save button disabled", () => {
    const html = render({ inputs: { pata: "3.800,5" } });
    expect(html).toContain("Escribí un importe");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Completar costo histórico<\/button>/);
  });

  it("collapses the affected lines by default and lists each one when expanded", () => {
    expect(render()).not.toContain("Venta #abcdef12");
    expect(render()).toContain("Ver líneas");
    const html = render({ expanded: new Set(["pata"]) });
    expect(html).toContain("Ocultar líneas");
    expect(html).toContain("09/10/2026 10:32");
    expect(html).toContain("2,500 kg");
    expect(html).toContain("Venta #abcdef12");
    expect(html).toContain("Importe: <strong>$ 12.500</strong>");
    expect(html).toContain("09/10/2026 13:41");
  });

  it("confirms what was completed and shows the empty state when nothing is left", () => {
    const html = render({ done: ["Pata muslo: 4 líneas completadas con $ 3.800/kg"], report: { ...report, totalLines: 0, totalRevenueCents: 0, products: [] } });
    expect(html).toContain("✓ Pata muslo: 4 líneas completadas con $ 3.800/kg");
    expect(html).toContain("No quedan líneas sin costo en este período.");
  });

  it("is read-only for a user who cannot edit costs", () => {
    const html = render({ report: { ...report, canRepair: false, products: [{ ...pata, currentCostCents: null, currentPriceCents: null, marginBps: null, repricesOnCostChange: false }] } });
    expect(html).toContain("requiere permiso para editar precios y costos");
    expect(html).toContain("Ver líneas");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Completar costo histórico");
  });

  it("tells when the list is truncated", () => {
    expect(render({ report: { ...report, totalLines: 7_000, truncated: true } })).toContain("Hay 7000 líneas sin costo");
  });

  it("shows the error of a failed save on its row and disables the other rows while saving", () => {
    const html = render({ rowErrors: { pata: "Branch is not authorized for this user" }, savingProductId: "coca", inputs: { pata: "3800" } });
    expect(html).toContain("Branch is not authorized for this user");
    expect(html).toContain("Guardando…");
  });
});
