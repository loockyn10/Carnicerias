import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../app/admin/vacuum/actions", () => ({
  createVacuumPackageAction: vi.fn(), getVacuumStationSummaryAction: vi.fn(), listVacuumStationProductsAction: vi.fn(), recordVacuumPrintAction: vi.fn()
}));

import type { VacuumSettings } from "../lib/vacuum";
import { VacuumStation } from "./vacuum-station";

const settings: VacuumSettings = {
  businessName: "Carnicerías Fran", address: null, establishmentInfo: null, defaultConservationText: null, extraText: null, labelWidthMm: 58, infoHeightMm: 40, priceHeightMm: 40, defaultShelfLifeDays: 14,
  ean: { scheme: "PRICE_EMBEDDED", prefix: "20", pluDigits: 4, valueDigits: 6, valueStep: 100 }
};

const products = [
  { productId: "p1", name: "Vacío de cerdo", sku: "VCE", shelfLifeDays: 14, plu: "12", conservationText: null, pricePerKgCents: "1500000", categoryId: "c1", categoryName: "Cerdo", recentPackages: 8 },
  { productId: "p2", name: "Churrasco de cerdo", sku: "CHC", shelfLifeDays: null, plu: "13", conservationText: null, pricePerKgCents: "1000000", categoryId: "c1", categoryName: "Cerdo", recentPackages: 0 },
  { productId: "p3", name: "Peceto", sku: "PEC", shelfLifeDays: 10, plu: "14", conservationText: null, pricePerKgCents: null, categoryId: "c2", categoryName: "Vacuno", recentPackages: 0 }
];

function render(overrides: { settings?: VacuumSettings; simulatorAllowed?: boolean } = {}) {
  return renderToStaticMarkup(
    <VacuumStation
      branches={[{ id: "b1", name: "Central" }]} defaultBranchId="b1" initialProducts={products} initialSummary={{ packages: 12, grams: 9_350, lastProductName: "Vacío de cerdo", lastAt: "2026-11-07T15:00:00Z" }}
      settings={overrides.settings ?? settings} simulatorAllowed={overrides.simulatorAllowed ?? false} timezone="America/Argentina/Buenos_Aires" />
  );
}

describe("pantalla de la estación (primer render)", () => {
  const html = render();

  it("muestra el estado, el peso grande y los controles principales", () => {
    expect(html).toContain('data-testid="station-status"');
    expect(html).toContain("Balanza desconectada");
    expect(html).toContain('data-testid="weight-readout"');
    expect(html).toContain('data-testid="pause-toggle"');
    expect(html).toContain("Conectar balanza");
    expect(html).toContain("Imprimir prueba");
    expect(html).toContain("Reimprimir último");
    expect(html).toContain("Dispositivos");
  });

  it("ofrece un botón grande por cada corte habilitado, con su precio por kilogramo", () => {
    expect((html.match(/data-testid="cut-button"/g) ?? []).length).toBe(3);
    expect(html).toContain("Vacío de cerdo");
    expect(html).toContain("$15.000/kg");
  });

  it("ordena primero el corte más usado y avisa lo que le falta a cada uno", () => {
    expect(html.indexOf("Vacío de cerdo")).toBeLessThan(html.indexOf("Churrasco de cerdo"));
    expect(html).toContain("sin vida útil");
    expect(html).toContain("sin precio");
  });

  it("tiene buscador, favoritos y categorías", () => {
    expect(html).toContain('aria-label="Buscar corte"');
    expect(html).toContain("★ Favoritos");
    expect(html).toContain("Cerdo (2)");
    expect(html).toContain("Vacuno (1)");
  });

  it("muestra el resumen de producción de hoy", () => {
    expect(html).toContain('data-testid="summary-packages">12<');
    expect(html).toContain("9,350");
    expect(html).toContain("paquetes registrados");
  });

  it("al empezar no hay corte elegido ni paquete previo", () => {
    expect(html).toContain("Todavía no elegiste ningún corte.");
    expect(html).toContain("Todavía no se registró ningún paquete");
  });

  it("avisa que la impresión automática está apagada hasta pasar la prueba", () => {
    expect(html).toContain('data-testid="autoprint-off"');
    expect(html).toContain("Impresión manual");
  });

  it("muestra los indicadores de balanza y servidor", () => {
    expect(html).toContain('data-testid="station-indicators"');
    expect(html).toContain("Servidor conectado");
  });

  it("sin esquema EAN-13 configurado lo avisa", () => {
    expect(render({ settings: { ...settings, ean: null } })).toContain("Falta configurar el esquema EAN-13");
  });

  it("los botones de selección son accesibles (aria-pressed) y no hay ninguno seleccionado al empezar", () => {
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-selected="true"');
  });
});
