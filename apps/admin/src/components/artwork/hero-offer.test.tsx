import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildOfferArtworkModel, parseArtworkFacts, type OfferArtworkModel } from "../../lib/artwork";
import { ARTWORK_COLORS, ARTWORK_FORMATS, BRAND_NAME, STORY_SAFE } from "../../lib/artwork-tokens";
import { SAMPLE_FACTS } from "../../lib/test-support/artwork-fixtures";
import { ArtworkPreview } from "./artwork-preview";
import { FeedHeroOffer, HeroOffer, StoryHeroOffer, TvHeroOffer } from "./hero-offer";

function modelFor(key: keyof typeof SAMPLE_FACTS, extras: { headline?: string; imageUrl?: string | null; overrides?: Record<string, unknown> } = {}): OfferArtworkModel {
  const facts = parseArtworkFacts({ ...SAMPLE_FACTS[key], ...extras.overrides });
  if (!facts) throw new Error("hechos inválidos");
  const model = buildOfferArtworkModel(facts, { headline: extras.headline ?? "OFERTA", imageUrl: extras.imageUrl ?? null });
  if (!model) throw new Error("sin modelo");
  return model;
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

/** Sólo el texto visible (sin atributos ni estilos). */
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("los tres renderers leen el mismo modelo", () => {
  const mayo = modelFor("mayo", { headline: "X MAYOR" });
  const renderers = [["tv", TvHeroOffer], ["feed", FeedHeroOffer], ["story", StoryHeroOffer]] as const;

  it.each(renderers)("%s: marca, titular, producto, precio, condición y precio normal", (format, Renderer) => {
    const html = render(<Renderer model={mayo} />);
    const text = textOf(html);
    expect(html).toContain(`data-artwork-format="${format}"`);
    expect(text).toContain("SUPER OFERTAS");
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
    const withPhoto = render(<Renderer model={modelFor("nalga", { imageUrl: "data:image/png;base64,AAAA" })} />);
    expect(withPhoto).toContain("<img");
    expect(withPhoto).toContain("object-fit:contain");
    const without = render(<Renderer model={modelFor("nalga", { imageUrl: null })} />);
    expect(without).not.toContain("<img");
    expect(without).toContain("<svg");
    expect(textOf(without)).not.toMatch(/error|undefined|null/i);
  });

  it("la dirección de la sucursal sólo aparece en Feed y Story, y sólo si existe", () => {
    const withAddress = modelFor("nalga");
    expect(textOf(render(<FeedHeroOffer model={withAddress} />))).toContain("AV. SIEMPRE VIVA 742");
    expect(textOf(render(<StoryHeroOffer model={withAddress} />))).toContain("AV. SIEMPRE VIVA 742");
    expect(textOf(render(<TvHeroOffer model={withAddress} />))).not.toContain("SIEMPRE VIVA");
    const without = modelFor("nalga", { overrides: { branchAddress: null } });
    expect(textOf(render(<FeedHeroOffer model={without} />))).not.toContain("SIEMPRE VIVA");
    expect(textOf(render(<StoryHeroOffer model={without} />))).not.toContain("SIEMPRE VIVA");
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

describe("tokens compartidos", () => {
  it("la marca es SUPER OFERTAS y la paleta tiene los cinco tokens pedidos", () => {
    expect(BRAND_NAME).toBe("SUPER OFERTAS");
    for (const token of ["BRAND_GREEN", "PRICE_YELLOW", "ACCENT_RED", "BLACK", "WHITE"] as const) expect(ARTWORK_COLORS[token]).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("el precio va en negro sobre amarillo, el titular en rojo y la franja en verde (los tokens se usan)", () => {
    const html = render(<FeedHeroOffer model={modelFor("mayo")} />).toLowerCase();
    expect(html).toContain(ARTWORK_COLORS.PRICE_YELLOW.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.BRAND_GREEN.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.ACCENT_RED.toLowerCase());
    expect(html).toContain(ARTWORK_COLORS.BLACK.toLowerCase());
  });

  it("los componentes no tienen colores propios: todo sale de lib/artwork-tokens.ts", () => {
    const source = fs.readFileSync(path.join(__dirname, "hero-offer.tsx"), "utf8");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toMatch(/boxShadow|textShadow|linear-gradient|radial-gradient/);
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
    // La pieza interna es literalmente la salida de HeroOffer.
    expect(html).toContain(render(<HeroOffer format={format} model={modelFor("mayo")} />));
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
