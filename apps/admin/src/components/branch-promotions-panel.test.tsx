import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BranchPromotionsPanel } from "./branch-promotions-panel";

describe("BranchPromotionsPanel: promoción llevando 3u vigente por sucursal (sólo lectura, D-068)", () => {
  const html = renderToStaticMarkup(<BranchPromotionsPanel rows={[
    { branchId: "c", branchName: "Central", promotion: { minimumUnits: 3, discountBps: 1_500 } },
    { branchId: "a", branchName: "Avenida", promotion: null }
  ]} />);

  it("muestra la regla vigente de cada sucursal como «desde N», y las que no tienen", () => {
    expect(html).toContain("Central");
    expect(html).toContain("15% OFF desde 3 unidades");
    expect(html).toContain("Avenida");
    expect(html).toContain("Sin promoción llevando 3u");
    expect(html).not.toMatch(/cada \d/i);
  });

  it("no hay editor por sucursal (sin formularios ni botones) y apunta a la configuración global", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).toContain('href="/admin/products?tab=pricing"');
    expect(html).toContain("Configuración de precios");
  });

  it("recuerda que manda un solo descuento por línea (no se acumula con pack, promoción propia ni precio manual)", () => {
    expect(html).toContain("No se acumula con un Pack");
  });
});
