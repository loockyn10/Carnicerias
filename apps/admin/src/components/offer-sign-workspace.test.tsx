import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { LabelModeTabs } from "./label-mode-tabs";
import { OfferSignPagePreview } from "./offer-sign-preview";
import { OfferSignWorkspace, type OfferSignListing } from "./offer-sign-workspace";
import { parseOfferSignCatalog } from "../lib/offer-sign";
import { buildSignPage } from "../lib/offer-sign-layout";
import { BRANCH, catalog, choricito, hamburguesas, pataMuslo } from "../lib/test-support/offer-sign-fixtures";

const signs = parseOfferSignCatalog(catalog(choricito(), pataMuslo(), hamburguesas()));
const listing: OfferSignListing = { branchId: BRANCH, branchName: "Central", businessName: "SUPER OFERTAS", signs, logoVariant: "GENERAL", logos: { GENERAL: null, BUTCHER: null } };

describe("pantalla de carteles de ofertas", () => {
  it("lista las promociones con su condición y deja generar sólo con selección", () => {
    const html = renderToStaticMarkup(<OfferSignWorkspace branches={[{ id: BRANCH, name: "Central" }]} error={null} listing={listing} />);
    expect(html).toContain("CHORICITO DE CERDO");
    expect(html).toContain("Desde 2 kg · $6.500/kg");
    expect(html).toContain("Tira · 3 ofertas por hoja");
    expect(html).toContain("Cartel grande · 1 oferta por hoja");
    expect(html).toMatch(/data-testid="offer-sign-generate"[^>]*disabled/);
    expect(html).not.toMatch(/PACK_FIXED_TOTAL|THRESHOLD/);
  });

  it("sucursal sin promociones explica dónde se cargan", () => {
    const html = renderToStaticMarkup(<OfferSignWorkspace branches={[{ id: BRANCH, name: "Central" }]} error={null} listing={{ ...listing, signs: [] }} />);
    expect(html).toContain("Productos → Promociones");
  });

  it("el preview dibuja la hoja con las mismas primitivas (textos, logo y borde)", () => {
    const page = buildSignPage(signs.slice(0, 3), "STRIP", { hasLogo: true, name: "SUPER OFERTAS" });
    const html = renderToStaticMarkup(<OfferSignPagePreview label="Hoja 1 de 1" logoDataUrl="data:image/png;base64,AAAA" page={page} />);
    expect(html).toContain('viewBox="0 0 297 210"');
    expect(html).toContain("OFERTA");
    expect(html).toContain("6.500");
    expect(html.match(/<image/g)).toHaveLength(3);
  });

  it("muestra los tres formatos (mediano elegido) y el selector de logo con las dos opciones", () => {
    const html = renderToStaticMarkup(<OfferSignWorkspace branches={[{ id: BRANCH, name: "Central" }]} error={null} listing={listing} />);
    expect(html.indexOf("Cartel grande")).toBeLessThan(html.indexOf("Cartel mediano"));
    expect(html.indexOf("Cartel mediano")).toBeLessThan(html.indexOf("Tira · 3 ofertas"));
    expect(html).toMatch(/value="MEDIUM" checked|checked=""[^>]*value="MEDIUM"/);
    expect(html).toContain("Super Ofertas / Despensa");
    expect(html).toContain("Carnicería (sin cargar)");
    expect(html).toContain("Subir logo de la carnicería");
  });

  it("con logo de carnicería cargado queda elegible y el logo guardado es el que se dibuja", () => {
    const withButcher: OfferSignListing = { ...listing, logoVariant: "BUTCHER", logos: { GENERAL: "data:image/png;base64,GENERALX", BUTCHER: "data:image/png;base64,CARNICERIAX" } };
    const html = renderToStaticMarkup(<OfferSignWorkspace branches={[{ id: BRANCH, name: "Central" }]} error={null} listing={withButcher} />);
    expect(html).not.toContain("(sin cargar)");
    expect(html).toContain("Cambiar logo de la carnicería");
    expect(html).toContain('<option value="BUTCHER" selected=""');
  });

  it("las dos solapas conviven y marcan la activa", () => {
    const html = renderToStaticMarkup(<LabelModeTabs active="offers" />);
    expect(html).toContain("Etiquetas de góndola");
    expect(html).toContain("Carteles de ofertas");
    expect(html).toMatch(/aria-current="page"[^>]*>Carteles de ofertas|Carteles de ofertas<\/a>/);
  });
});
