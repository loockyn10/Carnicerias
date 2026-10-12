import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../app/admin/products/signage/actions", () => ({
  createSignageDisplayAction: () => Promise.resolve({}), regenerateSignageTokenAction: () => Promise.resolve({}), saveSignageSourceAction: () => Promise.resolve({})
}));

import { parseFolders } from "../lib/artwork-folders";
import { parseDisplaysOverview } from "../lib/signage-overview";
import { SignageScreens } from "./signage-screens";

const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const branches = [{ id: "b1", name: "Central", active: true }, { id: "b2", name: "Avenida", active: true }];
const folders = parseFolders([{ id: "f1", name: "Ofertas finde", generateFeed: true, generateStory: true, usedByDisplays: 1, items: [] }]);
const displays = parseDisplaysOverview([
  { id: "d1", name: "TV Central", enabled: true, branchId: "b1", branchName: "Central", slideDurationSeconds: 8, contentSource: "ALL_PROMOTIONS", folderId: null, folderName: null, tokenRotatedAt: "2026-10-10T12:00:00Z", legacyEntries: 0, playable: 12, blocked: 0, withoutPhoto: 0 },
  { id: "d2", name: "TV Avenida", enabled: true, branchId: "b2", branchName: "Avenida", slideDurationSeconds: 8, contentSource: "FOLDER", folderId: "f1", folderName: "Ofertas finde", tokenRotatedAt: "2026-10-10T12:00:00Z", legacyEntries: 0, playable: 7, blocked: 1, withoutPhoto: 2 }
]);

describe("Cartelería → Pantallas TV: cada pantalla con su fuente (D-086)", () => {
  const html = renderToStaticMarkup(<SignageScreens branches={branches} displays={displays} folders={folders} />);
  const text = textOf(html);

  it("una tarjeta por pantalla con nombre, sucursal, promociones que se reproducen hoy y fuente", () => {
    expect(html.match(/data-testid="signage-card"/g)).toHaveLength(2);
    expect(text).toContain("TV Central");
    expect(text).toContain("12 promociones activas");
    expect(text).toContain("Fuente:");
    expect(text).toContain("Todas las promociones activas");
    expect(text).toContain("TV Avenida");
    expect(text).toContain("7 ofertas vigentes");
    expect(text).toContain("Carpeta · Ofertas finde");
  });

  it("cada tarjeta tiene Configurar y Abrir vista TV; los avisos dicen «Sin foto»", () => {
    expect(html.match(/data-testid="signage-configure-open"/g)).toHaveLength(2);
    expect(html.match(/data-testid="signage-open-preview"/g)).toHaveLength(2);
    expect(html).toContain('href="/tv-preview/d2"');
    expect(text).toContain("Sin foto: 2");
    expect(text).toContain("1 oferta no se reproduce hoy");
  });

  it("no hay lista de slides que armar ni selector de productos por pantalla", () => {
    expect(html).not.toContain("signage-slides");
    expect(text).not.toMatch(/Guardar y publicar|Agregar producto|Agregar grupo|Administrar grupos/);
  });

  it("sin pantallas ofrece crear la primera (por defecto reproduce todas las promociones activas)", () => {
    const empty = renderToStaticMarkup(<SignageScreens branches={branches} displays={[]} folders={[]} />);
    expect(empty).toContain('data-testid="signage-create"');
    expect(textOf(empty)).toContain("Crear la primera pantalla");
    expect(textOf(empty)).toContain("reproduce todas las promociones activas");
  });

  it("una pantalla con la lista anterior avisa cómo pasarla a la fuente nueva", () => {
    const legacy = parseDisplaysOverview([{ id: "d9", name: "TV vieja", enabled: true, branchId: null, branchName: null, slideDurationSeconds: 8, contentSource: "MANUAL", folderId: null, folderName: null, tokenRotatedAt: "", legacyEntries: 5, playable: 5, blocked: 0, withoutPhoto: 0 }]);
    const out = textOf(renderToStaticMarkup(<SignageScreens branches={branches} displays={legacy} folders={folders} />));
    expect(out).toContain("Lista anterior");
    expect(out).toContain("armada a mano (5)");
  });
});
