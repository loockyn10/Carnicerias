import { describe, expect, it } from "vitest";

import {
  buildArtworkBranding, buildArtworkContact, emptyArtworkBranding, parseArtworkBrandingFacts, placeLogo, BRAND_COLORS
} from "./artwork-branding";
import { ARTWORK_COLORS, BRAND_NAME } from "./artwork-tokens";
import { brandingPayload } from "./test-support/artwork-fixtures";

function facts(branch: "central" | "avenida" | null, options: { logo?: boolean } = {}) {
  const parsed = parseArtworkBrandingFacts(brandingPayload(branch, options));
  if (!parsed) throw new Error("hechos inválidos");
  return parsed;
}

describe("parseArtworkBrandingFacts", () => {
  it("entiende logo + contacto de la sucursal", () => {
    const central = facts("central");
    expect(central.logo).toMatchObject({ contentType: "image/png", width: 480, height: 120 });
    expect(central.branch).toMatchObject({ name: "Central", phone: "3496-448808", address: "Güemes 2180", city: "Esperanza, Santa Fe" });
    expect(central.organizationName).toBe("AW Org");
  });

  it("sin sucursal no hay contacto; sin logo no hay logo", () => {
    expect(facts(null).branch).toBeNull();
    expect(facts("central", { logo: false }).logo).toBeNull();
  });

  it("respuestas raras no se entienden o se descartan (nunca inventan)", () => {
    expect(parseArtworkBrandingFacts(null)).toBeNull();
    expect(parseArtworkBrandingFacts("x")).toBeNull();
    const logoRaro = parseArtworkBrandingFacts({ ...brandingPayload("central"), logo: { storagePath: "a/b.webp", contentType: "image/webp", width: 10, height: 10 } });
    expect(logoRaro?.logo).toBeNull();
    const sinMedidas = parseArtworkBrandingFacts({ ...brandingPayload("central"), logo: { storagePath: "a/b.png", contentType: "image/png", width: 0, height: 10 } });
    expect(sinMedidas?.logo).toBeNull();
    const sucursalSinNombre = parseArtworkBrandingFacts({ ...brandingPayload("central"), branch: { id: "x", name: "", phone: "1" } });
    expect(sucursalSinNombre?.branch).toBeNull();
  });
});

describe("contacto por sucursal (no se cruza)", () => {
  it("Central imprime SUS datos, en mayúsculas", () => {
    expect(buildArtworkContact(facts("central").branch)).toEqual({ phone: "3496-448808", address: "GÜEMES 2180", city: "ESPERANZA, SANTA FE" });
  });

  it("Avenida imprime los suyos y nada de Central", () => {
    const contact = buildArtworkContact(facts("avenida").branch);
    expect(contact).toEqual({ phone: "0342 455-5555", address: "AV. LIBERTAD 100", city: "SANTA FE, SANTA FE" });
    expect(JSON.stringify(contact)).not.toMatch(/3496|GÜEMES|ESPERANZA/);
  });

  it("una sucursal sin datos no hereda los de otra: no hay bloque de contacto", () => {
    const vacia = parseArtworkBrandingFacts({ ...brandingPayload("central"), branch: { id: "b", name: "Nueva", phone: null, address: null, city: null } });
    expect(buildArtworkContact(vacia?.branch ?? null)).toBeNull();
    expect(buildArtworkContact(null)).toBeNull();
  });

  it("datos parciales: sólo se imprime lo que existe", () => {
    const parcial = parseArtworkBrandingFacts({ ...brandingPayload("central"), branch: { id: "b", name: "Nueva", phone: "3496-1", address: null, city: "Esperanza" } });
    expect(buildArtworkContact(parcial?.branch ?? null)).toEqual({ phone: "3496-1", address: null, city: "ESPERANZA" });
  });

  it("los caracteres que la fuente no tiene no llegan al renderer", () => {
    const raro = parseArtworkBrandingFacts({ ...brandingPayload("central"), branch: { id: "b", name: "N", phone: null, address: "Güemes 2180 😀", city: null } });
    expect(buildArtworkContact(raro?.branch ?? null)?.address).toBe("GÜEMES 2180");
  });
});

describe("buildArtworkBranding", () => {
  it("con logo: lo toma de la URL ya resuelta (firmada o data-URL), con las medidas registradas", () => {
    const branding = buildArtworkBranding(facts("central"), "data:image/png;base64,AAAA");
    expect(branding.logo).toEqual({ imageUrl: "data:image/png;base64,AAAA", width: 480, height: 120 });
    expect(branding.contact?.phone).toBe("3496-448808");
  });

  it("sin logo (o sin URL): no se dibuja ni se recrea un logo; el nombre de la organización queda como respaldo", () => {
    expect(buildArtworkBranding(facts("central", { logo: false }), null).logo).toBeNull();
    expect(buildArtworkBranding(facts("central"), null).logo).toBeNull();
    expect(buildArtworkBranding(facts("central", { logo: false }), null).businessName).toBe("AW ORG");
    expect(emptyArtworkBranding().businessName).toBe(BRAND_NAME);
  });

  it("los colores de marca salen de los tokens compartidos (verde, amarillo, rojo)", () => {
    expect(buildArtworkBranding(facts(null), null).colors).toEqual({ green: ARTWORK_COLORS.BRAND_GREEN, yellow: ARTWORK_COLORS.PRICE_YELLOW, red: ARTWORK_COLORS.ACCENT_RED });
    expect(BRAND_COLORS.yellow).toBe(ARTWORK_COLORS.PRICE_YELLOW);
  });
});

describe("placeLogo — el logo entra entero y centrado en la franja", () => {
  const area = { x: 16, y: 100, w: 118, h: 1000 };

  it("apaisado: se gira -90° y ocupa el alto de la franja (se lee de abajo hacia arriba)", () => {
    const place = placeLogo({ width: 1200, height: 300 }, area);
    expect(place.rotate).toBe(-90);
    // Después de girar ocupa (alto × ancho): entra en la franja.
    const shownW = place.height;
    const shownH = place.width;
    expect(shownW).toBeLessThanOrEqual(area.w);
    expect(shownH).toBeLessThanOrEqual(area.h);
    expect(place.width / place.height).toBeCloseTo(4, 1);
    // Centrado en el área.
    expect(place.left + place.width / 2).toBeCloseTo(area.x + area.w / 2, 0);
    expect(place.top + place.height / 2).toBeCloseTo(area.y + area.h / 2, 0);
  });

  it("vertical: no se gira y entra entero", () => {
    const place = placeLogo({ width: 300, height: 1200 }, area);
    expect(place.rotate).toBe(0);
    expect(place.width).toBeLessThanOrEqual(area.w);
    expect(place.height).toBeLessThanOrEqual(area.h);
  });

  it("un logo larguísimo se achica por el alto de la franja, no se corta", () => {
    const place = placeLogo({ width: 6000, height: 300 }, area);
    expect(place.width).toBeLessThanOrEqual(area.h);
  });

  it("cuadrado: no se gira", () => {
    expect(placeLogo({ width: 500, height: 500 }, area).rotate).toBe(0);
  });
});
