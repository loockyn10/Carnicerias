import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PricingConfigForm } from "./pricing-config-form";
import { PricingConfigModal } from "./pricing-config-modal";

vi.mock("../app/admin/actions", () => ({ savePricingConfigAction: () => Promise.resolve({}), closeBranchPriceOverridesAction: () => Promise.resolve({}) }));

const props = {
  values: { marginBps: 3_000, unitBulkDiscountBps: 1_500, packDiscountBps: 2_000, cardSurchargeBps: 1_000 },
  categories: [{ id: "c1", name: "Vaca" }], excludedCategoryIds: ["c1"], branchOverrides: 2
};

describe("PricingConfigModal", () => {
  it("cerrado: sólo el botón; nada de la configuración a la vista", () => {
    const html = renderToStaticMarkup(<PricingConfigModal {...props} />);
    expect(html).toContain("Configuración de precios");
    for (const hidden of ["Margen de ganancia", "Dto llevando 3u", "Dto por pack", "Recargo por tarjeta", "Categorías excluidas", "por sucursal vigente", "Guardar configuración"]) expect(html).not.toContain(hidden);
  });

  it("el botón abre un diálogo que reutiliza EL formulario existente (sin segunda implementación) y se cierra con X, Escape o clic afuera", () => {
    const source = readFileSync(new URL("./pricing-config-modal.tsx", import.meta.url), "utf8");
    expect(source).toContain("<PricingConfigForm {...props} />");
    expect(source).toContain('role="dialog"');
    expect(source).toContain("max-h-[90vh]");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain('aria-label="Cerrar"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("event.target === event.currentTarget");
    expect(source).toContain("onClick={() => setOpen(true)}");
  });

  it("el formulario que contiene el modal sigue trayendo todos los campos y el guardado actual", () => {
    const html = renderToStaticMarkup(<PricingConfigForm {...props} />);
    for (const shown of ["Margen de ganancia", "Dto llevando 3u", "Dto por pack", "Recargo por tarjeta", "Categorías excluidas del margen automático", "2 precio(s) por sucursal vigente(s)", "Guardar configuración"]) expect(html).toContain(shown);
  });
});
