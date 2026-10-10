import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { EditorDisplay, EditorEntry } from "../lib/signage";
import { addEntry } from "../lib/signage-entries";
import { SignageCreateForm, SignageEditor } from "./signage-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../app/admin/products/signage/actions", () => ({
  createSignageDisplayAction: () => Promise.resolve({}), saveSignageDisplayAction: () => Promise.resolve({}), regenerateSignageTokenAction: () => Promise.resolve({}),
  loadPromotionCatalogAction: () => Promise.resolve({ ok: true, catalog: { promotions: [], groups: [] } }), saveSignageGroupAction: () => Promise.resolve({}), deleteSignageGroupAction: () => Promise.resolve({})
}));
vi.mock("../app/admin/actions", () => ({ searchProductsAction: () => Promise.resolve([]) }));

const slide = (id: string, name: string, extra: Partial<EditorEntry> = {}): EditorEntry => ({
  kind: "PRODUCT", id, name, sku: null, unitType: "UNIT", summary: "$ 1.729,75 · llevando 3 unidades", unavailable: null, hasPhoto: true, children: [], ...extra
});
const display: EditorDisplay = {
  id: "11111111-1111-4111-8111-111111111111", name: "TV Despensa Central", enabled: true, branchId: "b1", slideDurationSeconds: 8,
  tokenRotatedAt: "2026-10-07T12:00:00.000Z",
  entries: [slide("p1", "Mayonesa Hellmann's 250gr"), slide("p2", "Yerba Aguantadora 1kg", { summary: "$ 3.100" }), slide("p3", "Producto viejo", { summary: null, unavailable: "NO_PRICE" })]
};
const branches = [{ id: "b1", name: "Central", active: true }, { id: "b2", name: "Avenida", active: false }];

describe("SignageEditor", () => {
  const html = renderToStaticMarkup(<SignageEditor branches={branches} display={display} />);

  it("muestra la pantalla, la sucursal elegida y la duración", () => {
    expect(html).toContain("Pantalla: TV Despensa Central");
    expect(html).toMatch(/<option[^>]*value="b1"[^>]*selected|<option[^>]*selected[^>]*value="b1"/);
    expect(html).toContain('value="8"');
    expect(html).toContain("Entre 3 y 60");
  });

  it("lista las ofertas en orden con el precio que verá el TV (tomado del sistema, no tipeado)", () => {
    expect(html.indexOf("Mayonesa")).toBeLessThan(html.indexOf("Yerba"));
    expect(html).toContain("$ 1.729,75 · llevando 3 unidades");
    expect(html).toContain("Ofertas publicadas (3)");
    // no hay ningún campo para escribir precios
    expect(html).not.toMatch(/name="price|placeholder="Precio/i);
  });

  it("reordena con ↑ ↓ (los extremos deshabilitados) y permite quitar", () => {
    expect(html).toContain('aria-label="Subir Mayonesa Hellmann&#x27;s 250gr"');
    expect(html).toMatch(/aria-label="Subir Mayonesa[^>]*disabled/);
    expect(html).toMatch(/aria-label="Bajar Producto viejo"[^>]*disabled/);
    expect(html).toContain('aria-label="Quitar Yerba Aguantadora 1kg"');
  });

  it("avisa cuando una oferta no se puede mostrar y por qué", () => {
    expect(html).toContain("Sin precio vigente: no se muestra en el TV");
    expect(html).toContain("1 oferta no se muestra");
  });

  it("buscador de productos (nombre, SKU o código de barras) y botón de publicar", () => {
    expect(html).toContain("Agregar producto: nombre, SKU o código de barras");
    expect(html).toContain("Guardar y publicar");
  });

  it("ofrece abrir la vista TV (pestaña nueva) y regenerar el enlace", () => {
    expect(html).toContain('href="/tv-preview/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Regenerar enlace");
  });

  it("nunca muestra el token: el enlace está enmascarado y se avisa por qué", () => {
    expect(html).toContain("/tv/••••••••");
    expect(html).toContain("por seguridad sólo se muestra completo al crearlo o regenerarlo");
    expect(html).not.toMatch(/[0-9a-f]{64}/);
    expect(html).not.toContain("signage-link-panel");
  });

  it("sin ofertas: explica qué verá el televisor", () => {
    const empty = renderToStaticMarkup(<SignageEditor branches={branches} display={{ ...display, entries: [] }} />);
    expect(empty).toContain("Próximamente nuevas ofertas");
    expect(empty).toContain("Ofertas publicadas (0)");
  });

  it("una sucursal inactiva se rotula como tal", () => {
    expect(html).toContain("Avenida (inactiva)");
    expect(html).toContain("Sin sucursal (precio global)");
  });
});

describe("agregar productos a la presentación", () => {
  it("agrega al final y evita duplicados", () => {
    const first = addEntry([], slide("p1", "A"));
    expect(first.error).toBeNull();
    expect(first.entries.map((item) => item.id)).toEqual(["p1"]);
    const again = addEntry(first.entries, slide("p1", "A"));
    expect(again.error).toBe("Ese producto ya está en la presentación");
    expect(again.entries).toHaveLength(1);
    expect(addEntry(first.entries, slide("p2", "B")).entries.map((item) => item.id)).toEqual(["p1", "p2"]);
  });

  it("tope de 50 ofertas", () => {
    const full = Array.from({ length: 50 }, (_, index) => slide(`p${String(index)}`, `P${String(index)}`));
    const outcome = addEntry(full, slide("extra", "Extra"));
    expect(outcome.error).toContain("hasta 50");
    expect(outcome.entries).toHaveLength(50);
  });
});

describe("SignageCreateForm", () => {
  it("primera pantalla: invita a crearla, sin hardcodear sucursales", () => {
    const html = renderToStaticMarkup(<SignageCreateForm branches={branches} firstScreen />);
    expect(html).toContain("Crear la primera pantalla");
    expect(html).toContain("Central");
    expect(html).toContain("Avenida");
    expect(html).not.toContain("signage-link-panel");
  });

  it("pantallas adicionales", () => {
    expect(renderToStaticMarkup(<SignageCreateForm branches={branches} firstScreen={false} />)).toContain("Nueva pantalla");
  });
});
