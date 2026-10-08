import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PRODUCTOS_TABS } from "../app/admin/products-tabs";
import { ArtworkWorkspace } from "./artwork-workspace";
import { ProductArtworkPhotoField } from "./product-artwork-photo-field";
import { SIGNAGE_SECTIONS, SignageSubnav } from "./signage-subnav";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as string}</a> }));
vi.mock("../app/admin/actions", () => ({ searchProductsAction: () => Promise.resolve([]) }));
vi.mock("../app/admin/products/artwork/actions", () => ({
  loadArtworkAction: () => Promise.resolve({ kind: "not_found" }),
  loadCollageAction: () => Promise.resolve({ kind: "error", message: "x" }),
  loadBrandingAction: () => new Promise(() => undefined),
  removeArtworkLogoAction: () => Promise.resolve({ kind: "error", message: "x" }),
  saveBranchContactAction: () => Promise.resolve({ kind: "error", message: "x" }),
  registerArtworkLogoAction: () => Promise.resolve({ kind: "error", message: "x" }),
  createArtworkLogoUploadPathAction: () => Promise.resolve({ path: "x" }),
  getArtworkPhotoAction: () => Promise.resolve({ url: null }),
  removeArtworkPhotoAction: () => Promise.resolve({ url: null }),
  registerArtworkPhotoAction: () => Promise.resolve({ url: null }),
  createArtworkUploadPathAction: () => Promise.resolve({ path: "x" })
}));
vi.mock("../lib/artwork-photo-client", () => ({
  uploadArtworkPhoto: () => Promise.resolve({ url: null }),
  uploadArtworkLogo: () => Promise.resolve({ kind: "error", message: "x" })
}));

const branches = [{ id: "b1", name: "Central", active: true }, { id: "b2", name: "Avenida", active: true }, { id: "b3", name: "Vieja", active: false }];

describe("ArtworkWorkspace (Cartelería → Piezas)", () => {
  const html = renderToStaticMarkup(<ArtworkWorkspace branches={branches} defaultBranchId="b1" />);

  it("selector de producto (buscador) y estado vacío", () => {
    expect(html).toContain('placeholder="Buscar producto…"');
    expect(html).toContain("Elegí un producto para ver su pieza.");
  });

  it("selector de sucursal con la sucursal por defecto elegida y la opción de precio general", () => {
    expect(html).toContain("Sucursal");
    expect(html).toMatch(/<option[^>]*value="b1"[^>]*selected|<option[^>]*selected[^>]*value="b1"/);
    expect(html).toContain("Precio general (sin sucursal)");
    expect(html).toContain("Vieja (inactiva)");
    expect(html).toContain("mismo precio y promoción que el POS");
  });

  it("titular con OFERTA por defecto y los presets pedidos", () => {
    expect(html).toContain('value="OFERTA"');
    for (const preset of ["OFERTA", "X MAYOR", "IMPERDIBLE", "ESPECIAL"]) expect(html).toContain(`>${preset}</button>`);
    expect(html).toContain('maxLength="20"');
  });

  it("selector de tipo de pieza: Producto protagonista (elegido) y Collage", () => {
    expect(html).toContain("Tipo de pieza");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="template-hero"|data-testid="template-hero"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="template-collage"|data-testid="template-collage"[^>]*aria-pressed="false"/);
    expect(html).toContain(">Producto protagonista<");
    expect(html).toContain(">Collage<");
    // Con «Producto protagonista» no se ve la lista de productos del collage.
    expect(html).not.toContain('data-testid="collage-products"');
  });

  it("botón compacto «Configurar identidad» (deshabilitado hasta que se lea la identidad); la identidad no ocupa la pantalla", () => {
    expect(html).toMatch(/data-testid="open-identity"[^>]*disabled|disabled[^>]*data-testid="open-identity"/);
    expect(html).toContain("Configurar identidad");
    expect(html).not.toMatch(/name="(phone|address|city)"/);
    expect(html).not.toContain('data-testid="identity-modal"');
  });

  it("NO hay ningún campo para escribir precios", () => {
    expect(html).not.toMatch(/name="[^"]*price/i);
    expect(html).not.toMatch(/placeholder="[^"]*precio/i);
    expect(html).toContain("El precio no se escribe a mano");
  });

  it("formatos TV / Feed / Story como UNA pieza que se adapta, y descargas sólo de Feed y Story (deshabilitadas sin producto)", () => {
    for (const label of ["TV", "Feed", "Story"]) expect(html).toContain(`>${label}`);
    expect(html).toContain("(vista previa)");
    expect(html).toContain("Descargar Feed PNG");
    expect(html).toContain("Descargar Story PNG");
    expect(html).not.toContain("Descargar TV");
    expect(html).toMatch(/data-testid="download-feed"[^>]*disabled|disabled[^>]*data-testid="download-feed"/);
    expect(html).toMatch(/data-testid="download-story"[^>]*disabled|disabled[^>]*data-testid="download-story"/);
    expect(html).toContain("1080 × 1350");
    expect(html).toContain("1080 × 1920");
  });
});

describe("Foto para cartelería en el editor de producto", () => {
  const html = renderToStaticMarkup(<ProductArtworkPhotoField productId="11111111-1111-4111-8111-111111111111" />);

  it("muestra la sección, el estado de carga y los límites", () => {
    expect(html).toContain("Foto para cartelería");
    expect(html).toContain("Cargando…");
    expect(html).toContain("JPG, PNG o WebP");
    expect(html).toContain("5,0 MB");
  });

  it("el input de archivo no pertenece al formulario del producto (sin name) y acepta sólo imágenes", () => {
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toMatch(/<input[^>]*type="file"/);
    expect(html).not.toMatch(/<input[^>]*type="file"[^>]*name=|<input[^>]*name=[^>]*type="file"/);
  });

  it("los botones son type=button (no envían el formulario del producto)", () => {
    for (const match of html.matchAll(/<button[^>]*>/g)) expect(match[0]).toContain('type="button"');
  });
});

describe("pestaña Cartelería", () => {
  it("las pestañas de Productos son Productos / Precios / Promociones / Etiquetas / Cartelería", () => {
    expect(PRODUCTOS_TABS.map((tab) => tab.label)).toEqual(["Productos", "Precios", "Promociones", "Etiquetas", "Cartelería"]);
    expect(PRODUCTOS_TABS.at(-1)?.href).toBe("/admin/products/artwork");
  });

  it("Cartelería tiene dos vistas: las piezas nuevas y las pantallas de TV existentes (D-072 no se pierde)", () => {
    expect(SIGNAGE_SECTIONS.map((section) => section.href)).toEqual(["/admin/products/artwork", "/admin/products/signage"]);
    const html = renderToStaticMarkup(<SignageSubnav active="screens" />);
    expect(html).toContain("Piezas");
    expect(html).toContain("Pantallas TV");
    expect(html).toMatch(/aria-current="page"[^>]*>Pantallas TV|Pantallas TV<\/a>/);
  });
});
