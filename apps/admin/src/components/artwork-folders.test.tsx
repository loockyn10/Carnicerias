import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("../app/admin/products/artwork/folder-actions", () => ({
  deleteFolderAction: () => Promise.resolve({}), ensurePhotoAlphaAction: () => Promise.resolve({ result: {} }), loadFolderFactsAction: () => new Promise(() => undefined),
  saveFolderAction: () => Promise.resolve({})
}));
vi.mock("../app/admin/products/signage/actions", () => ({ loadPromotionCatalogAction: () => new Promise(() => undefined) }));
vi.mock("../app/admin/products/artwork/actions", () => ({
  loadArtworkAction: () => new Promise(() => undefined), loadBrandingAction: () => new Promise(() => undefined), loadCollageAction: () => new Promise(() => undefined)
}));
vi.mock("../app/admin/actions", () => ({ searchProductsAction: () => Promise.resolve([]) }));

import { parseFolders, type FolderSummary } from "../lib/artwork-folders";
import { ArtworkFolderEditor } from "./artwork-folder-editor";
import { ArtworkFolderPanel } from "./artwork-folder-panel";
import { ArtworkHome } from "./artwork-folders";
import { must } from "../lib/test-support/must";

const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

const branches = [{ id: "b1", name: "Central", active: true }, { id: "b2", name: "Avenida", active: true }];
const folders: FolderSummary[] = parseFolders([
  {
    id: "f1", name: "Ofertas finde", generateFeed: true, generateStory: true, usedByDisplays: 1,
    items: Array.from({ length: 8 }, (_, i) => ({ itemId: `i${String(i)}`, kind: "PROMOTION", id: `p${String(i)}`, name: `Producto ${String(i)}`, sku: null, unitType: "WEIGHT" }))
  },
  { id: "f2", name: "Carnicería", generateFeed: true, generateStory: false, usedByDisplays: 0, items: [{ itemId: "x", kind: "PRODUCT", id: "q1", name: "Nalga", sku: null, unitType: "WEIGHT" }] }
]);

describe("Cartelería → Gráficas: carpetas", () => {
  it("lista las carpetas con su cantidad, formatos y el botón Abrir; arriba «+ Nueva carpeta»", () => {
    const html = renderToStaticMarkup(<ArtworkHome branches={branches} defaultBranchId="b1" folders={folders} />);
    const text = textOf(html);
    expect(text).toContain("Carpetas");
    expect(text).toContain("Ofertas finde");
    expect(text).toContain("8 elementos");
    expect(text).toContain("Feed + Story");
    expect(text).toContain("Carnicería");
    expect(text).toContain("1 elemento");
    expect(html.match(/data-testid="folder-card"/g)).toHaveLength(2);
    expect(html.match(/>Abrir</g)).toHaveLength(2);
    expect(html).toContain('data-testid="new-folder"');
    expect(text).toContain("+ Nueva carpeta");
    expect(text).toContain("En 1 pantalla de TV");
  });

  it("la pieza individual sigue disponible pero queda en segundo plano (la acción importante es la carpeta)", () => {
    const html = renderToStaticMarkup(<ArtworkHome branches={branches} defaultBranchId="b1" folders={folders} />);
    expect(html).toContain('data-testid="single-piece"');
    expect(textOf(html)).toContain("Crear una pieza individual");
    expect(html.indexOf('data-testid="folders"')).toBeLessThan(html.indexOf('data-testid="single-piece"'));
    expect(html).toContain('data-testid="artwork-workspace"');
  });

  it("sin carpetas explica cómo empezar", () => {
    const html = renderToStaticMarkup(<ArtworkHome branches={branches} defaultBranchId="b1" folders={[]} />);
    expect(html).toContain('data-testid="folders-empty"');
    expect(textOf(html)).toContain("Todavía no hay carpetas");
  });

  it("una carpeta abierta (?folder=) muestra el panel con «Generar todo actualizado» y revisa lo de hoy", () => {
    const html = renderToStaticMarkup(<ArtworkHome branches={branches} defaultBranchId="b1" folders={folders} initialFolderId="f1" />);
    expect(html).toContain('data-testid="folder-panel"');
    expect(html).not.toContain('data-testid="folders"');
    expect(textOf(html)).toContain("Generar todo actualizado");
    expect(textOf(html)).toContain("Revisando precios, promociones y fotos de hoy");
    expect(html).toContain('data-testid="generate-all"');
    expect(textOf(html)).toContain("← Carpetas");
  });

  it("no hay ruta ni ítem de menú nuevo: todo vive dentro de la pestaña existente", () => {
    const html = renderToStaticMarkup(<ArtworkHome branches={branches} defaultBranchId="b1" folders={folders} />);
    expect(html).not.toMatch(/href="\/admin\/folders|href="\/admin\/carpetas/);
  });
});

describe("ArtworkFolderPanel", () => {
  it("antes de leer lo de hoy el botón principal está deshabilitado (no se genera a ciegas)", () => {
    const html = renderToStaticMarkup(<ArtworkFolderPanel branches={branches} defaultBranchId="b1" folder={must(folders[0])} onBack={() => undefined} onDeleted={() => undefined} onEdit={() => undefined} />);
    expect(html).toMatch(/data-testid="generate-all"[^>]*disabled/);
    expect(textOf(html)).toContain("Feed 1080×1350");
    expect(textOf(html)).toContain("Story 1080×1920");
  });

  it("las sucursales se ofrecen para elegir con qué precios y promociones generar", () => {
    const html = renderToStaticMarkup(<ArtworkFolderPanel branches={branches} defaultBranchId="b2" folder={must(folders[0])} onBack={() => undefined} onDeleted={() => undefined} onEdit={() => undefined} />);
    expect(html).toContain("Avenida");
    expect(html).toMatch(/<option[^>]*value="b2"[^>]*selected|selected=""[^>]*value="b2"|value="b2"[^>]*selected/);
  });
});

describe("ArtworkFolderEditor", () => {
  it("nueva carpeta: nombre, formatos (Feed y Story marcados) y «Guardar carpeta» deshabilitado hasta tener contenido", () => {
    const html = renderToStaticMarkup(<ArtworkFolderEditor folder={null} onClose={() => undefined} onSaved={() => undefined} />);
    const text = textOf(html);
    expect(html).toContain('role="dialog"');
    expect(text).toContain("Nueva carpeta");
    expect(text).toContain("Formatos");
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
    expect(html).toMatch(/data-testid="folder-save"[^>]*disabled/);
    expect(text).toContain("Todavía no elegiste nada");
    expect(text).toContain("no sus precios");
  });

  it("editar: trae los elementos en orden con subir, bajar y quitar", () => {
    const html = renderToStaticMarkup(<ArtworkFolderEditor folder={must(folders[0])} onClose={() => undefined} onSaved={() => undefined} />);
    expect(html).toContain('value="Ofertas finde"');
    expect(html.match(/data-testid="folder-items"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Quitar Producto \d"/g)).toHaveLength(8);
    expect(html).toContain('aria-label="Subir Producto 1"');
    expect(html).toMatch(/aria-label="Subir Producto 0"[^>]*disabled/);
    expect(textOf(html)).toContain("8 elementos");
    // «Guardar carpeta» ya está habilitado: tiene nombre y contenido.
    expect(html).not.toMatch(/data-testid="folder-save"[^>]*disabled/);
  });

  it("un producto sin promoción dice que muestra el precio vigente; no se escribe ningún precio en la carpeta", () => {
    const html = renderToStaticMarkup(<ArtworkFolderEditor folder={must(folders[1])} onClose={() => undefined} onSaved={() => undefined} />);
    expect(textOf(html)).toContain("Sin promoción: la pieza muestra el precio vigente");
    expect(html).not.toMatch(/type="number"/);
  });
});
