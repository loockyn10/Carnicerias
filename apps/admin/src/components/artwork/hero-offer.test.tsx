import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OfferArtworkModel } from "../../lib/artwork";
import { buildArtworkBranding, parseArtworkBrandingFacts, type ArtworkBranding } from "../../lib/artwork-branding";
import { ARTWORK_COLORS, ARTWORK_FORMATS, PRICE_BADGE_YELLOW, STORY_SAFE } from "../../lib/artwork-tokens";
import { brandingPayload, type SAMPLE_FACTS } from "../../lib/test-support/artwork-fixtures";
import { LOGO_URL, brandingFor, brandingWithContact as parseBranch, heroModel } from "../../lib/test-support/artwork-models";
import { ArtworkPreview } from "./artwork-preview";
import { FeedHeroOffer, HeroOffer, StoryHeroOffer } from "./hero-offer";
import { TvOfferSlide as TvHeroOffer } from "./tv-offer";
import { OfferArtwork } from "./offer-artwork";

function modelFor(
  key: keyof typeof SAMPLE_FACTS,
  extras: { headline?: string; imageUrl?: string | null; overrides?: Record<string, unknown>; branding?: ArtworkBranding } = {}
): OfferArtworkModel {
  return heroModel(key, extras);
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

/** Sólo el texto visible (sin atributos ni estilos). */
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("los tres renderers leen el mismo modelo", () => {
  const mayo = modelFor("mayo", { headline: "X MAYOR" });
  const renderers = [["tv", TvHeroOffer], ["feed", FeedHeroOffer], ["story", StoryHeroOffer]] as const;

  it.each(renderers)("%s: logo, titular, producto, precio, condición y precio normal", (format, Renderer) => {
    const html = render(<Renderer model={mayo} />);
    const text = textOf(html);
    expect(html).toContain(`data-artwork-format="${format}"`);
    expect(html).toContain('data-testid="artwork-logo"');
    expect(text).toContain("X MAYOR");
    expect(text).toContain("MAYONESA");
    expect(text).toContain("1.742");
    expect(text).toContain("50");
    expect(text).toContain("LLEVANDO 3 UNIDADES");
    expect(text).toContain("PRECIO NORMAL $ 2.050");
  });

  it.each(renderers)("%s: el tamaño de diseño es el del formato", (format, Renderer) => {
    const html = render(<Renderer model={mayo} />);
    const spec = ARTWORK_FORMATS[format];
    expect(html).toContain(`width:${String(spec.width)}px;height:${String(spec.height)}px`);
  });

  it("HeroOffer elige la composición por formato (misma pieza, tres formatos)", () => {
    for (const format of ["tv", "feed", "story"] as const) {
      expect(render(<HeroOffer format={format} model={mayo} />)).toContain(`data-artwork-format="${format}"`);
    }
  });

  it.each(renderers)("%s sin promoción: sólo el precio vigente, sin «llevando», sin precio normal duplicado ni descuento", (_format, Renderer) => {
    const text = textOf(render(<Renderer model={modelFor("sinFoto")} />));
    expect(text).toContain("2.450");
    expect(text).not.toMatch(/LLEVANDO/);
    expect(text).not.toMatch(/PRECIO NORMAL/);
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/DESDE/);
  });

  it.each(renderers)("%s por peso: /KG y «X KG» con el precio vigente", (_format, Renderer) => {
    const text = textOf(render(<Renderer model={modelFor("nalga")} />));
    expect(text).toContain("NALGA");
    expect(text).toContain("VACUNA");
    expect(text).toContain("17.900");
    expect(text).toContain("/KG");
    expect(text).toContain("X KG");
  });

  it.each(renderers)("%s: un titular distinto se refleja", (_format, Renderer) => {
    expect(textOf(render(<Renderer model={modelFor("nalga", { headline: "IMPERDIBLE" })} />))).toContain("IMPERDIBLE");
    expect(textOf(render(<Renderer model={modelFor("nalga")} />))).toContain("OFERTA");
  });

  it.each(renderers)("%s: con foto dibuja la imagen; sin foto, un panel de reemplazo (nunca un hueco ni un error)", (_format, Renderer) => {
    const withPhoto = render(<Renderer model={modelFor("nalga", { imageUrl: "data:image/png;base64,BBBB" })} />);
    expect(withPhoto).toContain("BBBB");
    expect(withPhoto).toContain("object-fit:contain");
    const without = render(<Renderer model={modelFor("nalga", { imageUrl: null })} />);
    expect(without).not.toContain("BBBB");
    expect(without).toContain("<svg");
    expect(textOf(without)).not.toMatch(/error|undefined|null/i);
  });

  it("nombre largo: se achica, no se recorta (ningún formato corta con «...»)", () => {
    const largo = modelFor("largo");
    for (const Renderer of [TvHeroOffer, FeedHeroOffer, StoryHeroOffer]) {
      const text = textOf(render(<Renderer model={largo} />));
      expect(text).toContain("CAJA 1,2 KG");
      expect(text).not.toContain("...");
    }
  });
});

describe("franja verde con el LOGO REAL (no texto)", () => {
  it.each([["tv", TvHeroOffer], ["feed", FeedHeroOffer], ["story", StoryHeroOffer]] as const)("%s: la franja verde lleva la imagen del logo y no hay bandera con texto", (_format, Renderer) => {
    const html = render(<Renderer model={modelFor("nalga")} />);
    expect(html.toLowerCase()).toContain(ARTWORK_COLORS.BRAND_GREEN.toLowerCase());
    expect(html).toContain(`src="${LOGO_URL}"`);
    // El nombre de la organización sólo aparece como respaldo cuando NO hay logo.
    expect(textOf(html)).not.toContain("AW ORG");
    expect(textOf(html)).not.toContain("SUPER OFERTAS");
  });

  it("un logo apaisado se gira -90° dentro de la franja; uno vertical no", () => {
    const apaisado = render(<FeedHeroOffer model={modelFor("nalga")} />);
    expect(apaisado).toContain("rotate(-90deg)");
    const vertical = parseArtworkBrandingFacts({ ...brandingPayload("central"), logo: { ...brandingPayload("central").logo as Record<string, unknown>, width: 120, height: 480 } });
    if (!vertical) throw new Error("identidad inválida");
    expect(render(<FeedHeroOffer model={modelFor("nalga", { branding: buildArtworkBranding(vertical, LOGO_URL) })} />)).not.toContain("rotate(-90deg)");
  });

  it("sin logo cargado: respaldo digno con el nombre de la organización en vertical (no se recrea un logo)", () => {
    const html = render(<FeedHeroOffer model={modelFor("nalga", { branding: brandingFor("central", { logo: false }) })} />);
    expect(html).not.toContain('data-testid="artwork-logo"');
    expect(textOf(html)).toContain("AW ORG");
    expect(html).toContain("rotate(-90deg)");
  });
});

describe("contacto de la sucursal (abajo a la izquierda)", () => {
  it("Feed y Story muestran teléfono, dirección y ciudad de la sucursal elegida", () => {
    for (const Renderer of [FeedHeroOffer, StoryHeroOffer]) {
      const text = textOf(render(<Renderer model={modelFor("nalga")} />));
      expect(text).toContain("3496-448808");
      expect(text).toContain("GÜEMES 2180");
      expect(text).toContain("ESPERANZA, SANTA FE");
    }
  });

  it("TV no lleva contacto (prioridad: producto, imagen, precio, condición y marca)", () => {
    const text = textOf(render(<TvHeroOffer model={modelFor("nalga")} />));
    expect(text).not.toContain("3496-448808");
    expect(text).not.toContain("GÜEMES");
    expect(text).not.toContain("ESPERANZA");
  });

  it("cada sucursal imprime lo suyo: Avenida no hereda nada de Central", () => {
    const html = render(<FeedHeroOffer model={modelFor("nalga", { branding: brandingFor("avenida") })} />);
    const text = textOf(html);
    expect(text).toContain("0342 455-5555");
    expect(text).toContain("AV. LIBERTAD 100");
    expect(text).toContain("SANTA FE, SANTA FE");
    expect(text).not.toMatch(/3496|GÜEMES|ESPERANZA/);
  });

  it("sin sucursal (precio general) o sin datos cargados no se dibuja el bloque", () => {
    for (const branding of [brandingFor(null), parseBranch({ phone: null, address: null, city: null })]) {
      for (const Renderer of [FeedHeroOffer, StoryHeroOffer]) {
        expect(render(<Renderer model={modelFor("nalga", { branding })} />)).not.toContain("artwork-contact-row");
      }
    }
  });

  it("datos parciales: sólo lo que existe (sin renglones vacíos ni «null»)", () => {
    const html = render(<FeedHeroOffer model={modelFor("nalga", { branding: parseBranch({ phone: "3496-1", address: null, city: "Esperanza" }) })} />);
    expect(html.match(/artwork-contact-row/g)).toHaveLength(2);
    expect(textOf(html)).toContain("ESPERANZA");
    expect(textOf(html)).not.toMatch(/null|undefined/i);
  });

  it("Story: el contacto queda dentro de la zona segura inferior", () => {
    const html = render(<StoryHeroOffer model={modelFor("nalga")} />);
    // El bloque de contacto (fondo suave) termina antes de la zona que tapan las apps.
    const contact = /top:(\d+)px;width:\d+px;height:(\d+)px;display:flex;flex-direction:column;justify-content:center;background:#EEF4EC/i.exec(html);
    expect(contact).not.toBeNull();
    expect(Number(contact?.[1]) + Number(contact?.[2])).toBeLessThanOrEqual(ARTWORK_FORMATS.story.height - STORY_SAFE.bottom);
  });
});

describe("tokens compartidos", () => {
  it("la paleta tiene los tokens pedidos y el amarillo de la pastilla es un token compartido", () => {
    for (const token of ["BRAND_GREEN", "PRICE_YELLOW", "ACCENT_RED", "BLACK", "WHITE"] as const) expect(ARTWORK_COLORS[token]).toMatch(/^#[0-9A-F]{6}$/);
    expect(PRICE_BADGE_YELLOW).toBe(ARTWORK_COLORS.PRICE_YELLOW);
  });

  it("el precio va en negro sobre amarillo, el titular en rojo y la franja en verde (los tokens se usan)", () => {
    const html = render(<FeedHeroOffer model={modelFor("mayo")} />).toLowerCase();
    expect(html).toContain(ARTWORK_COLORS.PRICE_YELLOW.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.BRAND_GREEN.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.ACCENT_RED.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.BLACK.toLowerCase());
  });

  it("los componentes no tienen colores propios: todo sale de lib/artwork-tokens.ts", () => {
    for (const file of ["hero-offer.tsx", "collage-offer.tsx", "artwork-parts.tsx", "offer-artwork.tsx"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(source.match(/#[0-9a-fA-F]{3,8}\b/g), file).toBeNull();
      expect(source, file).not.toMatch(/rgba?\(/);
      expect(source, file).not.toMatch(/boxShadow|textShadow|linear-gradient|radial-gradient/);
    }
  });

  it("Story respeta las zonas seguras", () => {
    expect(STORY_SAFE.top).toBeGreaterThanOrEqual(250);
    expect(STORY_SAFE.bottom).toBeGreaterThanOrEqual(300);
  });
});

describe("el preview dibuja el MISMO renderer que el PNG", () => {
  it.each(["tv", "feed", "story"] as const)("%s: el preview contiene la pieza de ese formato, con la fuente embebida y sin scroll", (format) => {
    const html = render(<ArtworkPreview format={format} model={modelFor("mayo")} />);
    expect(html).toContain(`data-artwork-format="${format}"`);
    expect(html).toContain("@font-face");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain(`aspect-ratio:${String(ARTWORK_FORMATS[format].width)} / ${String(ARTWORK_FORMATS[format].height)}`);
    // La pieza interna es literalmente la salida de OfferArtwork (el mismo componente que usa el PNG).
    expect(html).toContain(render(<OfferArtwork format={format} model={modelFor("mayo")} />));
  });

  it("cambiar de formato no cambia el contenido de la pieza (mismos textos y precios)", () => {
    const model = modelFor("mayo", { headline: "ESPECIAL" });
    const texts = (["tv", "feed", "story"] as const).map((format) => {
      const text = textOf(render(<HeroOffer format={format} model={model} />));
      return ["ESPECIAL", "MAYONESA", "1.742", "LLEVANDO 3 UNIDADES", "PRECIO NORMAL $ 2.050"].every((piece) => text.includes(piece));
    });
    expect(texts).toEqual([true, true, true]);
  });
});
