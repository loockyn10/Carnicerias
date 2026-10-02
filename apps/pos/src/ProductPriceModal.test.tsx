import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductPriceModal } from "./ProductPriceModal";

function render(options: { online: boolean; sessionOffline?: boolean }) {
  vi.stubGlobal("navigator", { onLine: options.online });
  return renderToStaticMarkup(
    <ProductPriceModal productName="GALLETITAS X" sessionOffline={options.sessionOffline ?? false} onSubmit={() => Promise.resolve(null)} onCancel={() => undefined} />
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("ProductPriceModal", () => {
  it("online: shows the agreed dialog (product, price field, Cancelar, Guardar precio y agregar)", () => {
    const html = render({ online: true });
    expect(html).toContain("Producto sin precio");
    expect(html).toContain("GALLETITAS X");
    expect(html).toContain("Precio de venta");
    expect(html).toContain("Cancelar");
    expect(html).toContain("Guardar precio y agregar");
    expect(html).not.toContain("Necesitás conexión");
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("without Internet it only warns: the price cannot be set and the save button is disabled", () => {
    const html = render({ online: false });
    expect(html).toContain("Este producto no tiene precio.");
    expect(html).toContain("Necesitás conexión para establecerlo.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it("a cached offline Supabase session (Internet but no online session) is also offline for this purpose", () => {
    const html = render({ online: true, sessionOffline: true });
    expect(html).toContain("Necesitás conexión para establecerlo.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});
