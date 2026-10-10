import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileQuickStock } from "./mobile-quick-stock";

vi.mock("../../app/admin/actions", () => ({ applyQuickStockAction: () => Promise.resolve({ ok: false, error: "x" }), searchQuickStockAction: () => Promise.resolve({ rows: [], total: 0 }) }));

const central = { id: "c", name: "Central" };
const avenida = { id: "a", name: "Avenida" };
const janssen = { id: "j", name: "Janssen" };

describe("Stock rápido del celular", () => {
  it("primero pregunta dónde, con los nombres REALES de las sucursales y el depósito primero", () => {
    const html = renderToStaticMarkup(<MobileQuickStock branches={[avenida, janssen, central]} productionBranchId="c" userId="u-1" />);
    expect(html).toContain("¿Dónde querés cargar stock?");
    expect(html.indexOf("Central")).toBeLessThan(html.indexOf("Avenida"));
    expect(html.indexOf("Avenida")).toBeLessThan(html.indexOf("Janssen"));
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  it("con una sola sucursal va directo al buscador", () => {
    const html = renderToStaticMarkup(<MobileQuickStock branches={[avenida]} productionBranchId={null} userId="u-1" />);
    expect(html).toContain('type="search"');
    expect(html).toContain("Buscar producto");
    expect(html).not.toContain("¿Dónde querés cargar stock?");
  });

  it("es una pantalla del celular: se oculta en escritorio y usa campos de 16 px", () => {
    const html = renderToStaticMarkup(<MobileQuickStock branches={[avenida, janssen]} productionBranchId={null} userId="u-1" />);
    expect(html).toContain("lg:hidden");
    expect(html).toContain("mobile-screen");
  });
});
