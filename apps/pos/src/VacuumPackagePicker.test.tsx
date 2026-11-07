import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VacuumPackagePicker } from "./VacuumPackagePicker";
import type { VacuumCandidate } from "./lib/vacuum-scan";

const candidate = (packageId: string, weightGrams: number, lot: string, packedOn: string): VacuumCandidate => ({
  packageId, productId: "vacio", productName: "Vacío", ean13: "2000120112506", weightGrams, chargeCents: 1_125_000n, lot, packedOn, expiresOn: "2026-11-30"
});

describe("selector de paquetes de Envasados", () => {
  const html = renderToStaticMarkup(
    <VacuumPackagePicker
      candidates={[candidate("a", 748, "CEN-261101-0001", "2026-11-01"), candidate("b", 750, "CEN-261102-0004", "2026-11-02")]}
      onCancel={() => undefined}
      onPick={() => undefined}
    />
  );

  it("muestra peso, lote y fecha de cada paquete, el más antiguo primero", () => {
    expect(html).toContain("0,748 kg");
    expect(html).toContain("Lote CEN-261101-0001 · elaborado 01/11/2026");
    expect(html).toContain("0,750 kg");
    expect(html).toContain("Lote CEN-261102-0004 · elaborado 02/11/2026");
    expect(html.indexOf("0,748 kg")).toBeLessThan(html.indexOf("0,750 kg"));
  });

  it("muestra el importe del paquete y es un diálogo accesible", () => {
    expect(html).toContain("$ 11.250");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect((html.match(/data-testid="vacuum-package-option"/g) ?? []).length).toBe(2);
  });
});
