import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { parseVacuumConfigPage, parseVacuumSettings, shelfLifeSummary } from "../lib/vacuum";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../app/admin/vacuum/actions", () => ({
  saveVacuumDefaultShelfLifeAction: vi.fn(), saveVacuumEanSchemeAction: vi.fn(), saveVacuumProductOverridesAction: vi.fn(),
  saveVacuumSettingsAction: vi.fn(), setVacuumProductEnabledAction: vi.fn()
}));

const { VacuumCutToggle, VacuumDefaultShelfLifeForm } = await import("./vacuum-settings-forms");

describe("configuración de Envasados: vencimiento general y corte en un clic", () => {
  it("el vencimiento general vale 14 días si el servidor todavía no lo informa", () => {
    expect(parseVacuumSettings({}).defaultShelfLifeDays).toBe(14);
    expect(parseVacuumSettings({ defaultShelfLifeDays: 12 }).defaultShelfLifeDays).toBe(12);
  });

  it("cada corte informa su vencimiento efectivo y si es general o personalizado (el propio gana)", () => {
    const page = parseVacuumConfigPage({
      total: 2, defaultShelfLifeDays: 12,
      rows: [
        { productId: "a", name: "Vacío de cerdo", enabled: true, shelfLifeDays: 12, customShelfLifeDays: null, plu: "1" },
        { productId: "b", name: "Carne picada", enabled: true, shelfLifeDays: 2, customShelfLifeDays: 2, plu: "2" }
      ]
    });
    expect(page.defaultShelfLifeDays).toBe(12);
    expect(shelfLifeSummary(page.rows[0] ?? { shelfLifeDays: null, customShelfLifeDays: null })).toEqual({ text: "12 días", custom: false });
    expect(shelfLifeSummary(page.rows[1] ?? { shelfLifeDays: null, customShelfLifeDays: null })).toEqual({ text: "2 días", custom: true });
    expect(page.rows[1]?.plu).toBe("2");
  });

  it("el botón verde habilita y el rojo deshabilita, sin formularios", () => {
    const off = renderToStaticMarkup(<VacuumCutToggle enabled={false} productId="a" />);
    expect(off).toContain("✓ Habilitar");
    expect(off).toContain("bg-emerald-700");
    expect(off).not.toContain("<form");
    const on = renderToStaticMarkup(<VacuumCutToggle enabled productId="a" />);
    expect(on).toContain("✕ Deshabilitar");
    expect(on).toContain("bg-red-700");
  });

  it("el formulario del vencimiento general muestra el valor actual", () => {
    expect(renderToStaticMarkup(<VacuumDefaultShelfLifeForm days={14} />)).toContain("14");
  });
});
