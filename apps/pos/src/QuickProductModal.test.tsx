import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuickProductModal } from "./QuickProductModal";

const props = { sessionOffline: false, onSubmit: () => Promise.resolve(null), onCancel: () => undefined };

describe("QuickProductModal", () => {
  it("unknown barcode scan: shows the scanned code as information and never asks for it", () => {
    const html = renderToStaticMarkup(<QuickProductModal {...props} code="7790272001029" />);
    expect(html).toContain("Producto no encontrado");
    expect(html).toContain('data-testid="quick-product-code"');
    expect(html).toContain("7790272001029");
    expect(html).not.toContain("quick-product-code-input");
    expect(html).toContain("Nuevo producto");
    expect(html).toContain("Crear y agregar");
  });

  it("opened by hand from «+» (empty code): same form, plus an editable barcode field, no 'not found' headline", () => {
    const html = renderToStaticMarkup(<QuickProductModal {...props} code="" />);
    expect(html).toContain("Nuevo producto");
    expect(html).toContain('data-testid="quick-product-code-input"');
    expect(html).toContain("Código de barras");
    expect(html).not.toContain('data-testid="quick-product-code"');
    expect(html).not.toContain("Producto no encontrado");
    for (const label of ["Nombre", "Costo", "Precio de venta", "Crear y agregar"]) expect(html).toContain(label);
  });
});
