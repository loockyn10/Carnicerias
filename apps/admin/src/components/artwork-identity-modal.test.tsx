import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ArtworkBrandingFacts } from "../lib/artwork-branding";
import { ArtworkIdentityModal } from "./artwork-identity-modal";

vi.mock("../app/admin/products/artwork/actions", () => ({
  removeArtworkLogoAction: () => Promise.resolve({ kind: "error", message: "x" }),
  saveBranchContactAction: () => Promise.resolve({ kind: "error", message: "x" }),
  saveArtworkLogoScaleAction: () => Promise.resolve({ kind: "error", message: "x" })
}));
vi.mock("../lib/artwork-photo-client", () => ({ uploadArtworkLogo: () => Promise.resolve({ kind: "error", message: "x" }) }));

const central = { id: "b1", name: "Central", phone: "3496-448808", address: "Güemes 2180", city: "Esperanza, Santa Fe" };
const logo = { storagePath: "o/branding/l.png", contentType: "image/png" as const, width: 480, height: 120 };

function modal(facts: Partial<ArtworkBrandingFacts>, props: { branchId?: string | null; branchName?: string | null; logoUrl?: string | null } = {}) {
  const branchId = props.branchId === undefined ? "b1" : props.branchId;
  return renderToStaticMarkup(<ArtworkIdentityModal
    branchId={branchId}
    branchName={props.branchName === undefined ? "Central" : props.branchName}
    branding={{ kind: "ok", facts: { organizationName: "AW Org", logo: null, branch: null, ...facts }, logoUrl: props.logoUrl ?? null }}
    onChanged={() => undefined}
    onClose={() => undefined}
  />);
}

describe("Configurar identidad", () => {
  it("con logo: lo muestra y ofrece cambiarlo o quitarlo; pide PNG transparente, hasta 5 MB", () => {
    const html = modal({ logo, branch: central }, { logoUrl: "https://example.test/logo.png" });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Logo de cartelería");
    expect(html).toContain('src="https://example.test/logo.png"');
    expect(html).toContain("Cambiar logo");
    expect(html).toContain(">Eliminar<");
    expect(html).toContain("PNG con fondo transparente");
    expect(html).toContain("5,0 MB");
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
  });

  it("sin logo: ofrece subirlo y no ofrece eliminar", () => {
    const html = modal({ logo: null, branch: central });
    expect(html).toContain("Subir logo");
    expect(html).toContain("Sin logo");
    expect(html).not.toContain(">Eliminar<");
  });

  it("contacto de la sucursal elegida: teléfono, dirección y ciudad con los valores guardados", () => {
    const html = modal({ logo, branch: central });
    expect(html).toContain("Contacto de la sucursal");
    expect(html).toContain("Central");
    expect(html).toContain('value="3496-448808"');
    expect(html).toContain('value="Güemes 2180"');
    expect(html).toContain('value="Esperanza, Santa Fe"');
    expect(html).toContain("Guardar contacto");
    expect(html).toContain("no se mezcla con el de otras");
  });

  it("sucursal sin datos: campos vacíos (no se copian los de otra sucursal)", () => {
    const html = modal({ logo, branch: { id: "b2", name: "Avenida", phone: null, address: null, city: null } }, { branchId: "b2", branchName: "Avenida" });
    expect(html).toContain("Avenida");
    expect(html).not.toMatch(/value="[^"]*(3496|Güemes|Esperanza)/);
    expect(html.match(/value=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("sin sucursal (precio general): no hay formulario de contacto y se explica por qué", () => {
    const html = modal({ logo, branch: null }, { branchId: null, branchName: null });
    expect(html).not.toContain("Guardar contacto");
    expect(html).not.toMatch(/name="(phone|address|city)"/);
    expect(html).toContain("Elegí una sucursal");
  });

  it("los botones no envían ningún formulario (type=button)", () => {
    for (const match of modal({ logo, branch: central }).matchAll(/<button[^>]*>/g)) expect(match[0]).toContain('type="button"');
  });
});

describe("Tamaño del logo", () => {
  it("con logo: control - / + con el porcentaje actual (100 % por defecto), rango 70-160 y vista previa en la franja", () => {
    const html = modal({ logo, branch: central }, { logoUrl: "https://example.test/logo.png" });
    expect(html).toContain("Tamaño del logo");
    expect(html).toMatch(/identity-logo-scale-value[^>]*>100%</);
    expect(html).toContain('min="70"');
    expect(html).toContain('max="160"');
    expect(html).toContain('aria-label="Agrandar el logo"');
    expect(html).toContain('data-testid="identity-logo-band-feed"');
    expect(html).toContain('data-testid="identity-logo-band-tv"');
  });

  it("muestra el porcentaje guardado", () => {
    const html = modal({ logo: { ...logo, scalePercent: 135 }, branch: central }, { logoUrl: "https://example.test/logo.png" });
    expect(html).toMatch(/identity-logo-scale-value[^>]*>135%</);
  });

  it("sin logo (nombre de la organización): el control no se muestra y se explica por qué", () => {
    const html = modal({ logo: null, branch: central });
    expect(html).not.toContain('data-testid="identity-logo-scale-value"');
    expect(html).toContain('data-testid="identity-logo-size-disabled"');
  });
});
