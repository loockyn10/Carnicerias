import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OfferArtworkModel } from "../../lib/artwork";
import { ARTWORK_COLORS, ARTWORK_FORMATS, PRICE_BADGE_YELLOW } from "../../lib/artwork-tokens";
import { MILANESA_SET, POLLO_SET } from "../../lib/test-support/artwork-fixtures";
import { brandingFor, brandingWithContact, collageModel } from "../../lib/test-support/artwork-models";
import { ArtworkPreview } from "./artwork-preview";
import { FeedCollageOffer, StoryCollageOffer } from "./collage-offer";
import { OfferArtwork } from "./offer-artwork";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const count = (html: string, needle: string) => html.split(needle).length - 1;

const renderers = [["feed", FeedCollageOffer], ["story", StoryCollageOffer]] as const;

describe.each(renderers)("collage %s", (format, Renderer) => {
  it("el lienzo tiene el tamaño del formato y la franja verde lleva el logo", () => {
    const html = render(<Renderer model={collageModel(POLLO_SET)} />);
    const spec = ARTWORK_FORMATS[format];
    expect(html).toContain(`data-artwork-format="${format}"`);
    expect(html).toContain(`width:${String(spec.width)}px;height:${String(spec.height)}px`);
    expect(html.toLowerCase()).toContain(ARTWORK_COLORS.BRAND_GREEN.toLowerCase());
    expect(html).toContain('data-testid="artwork-logo"');
  });

  it.each([2, 3, 4, 5])("%s productos: cada uno con su nombre, foto y precio, y el titular en rojo", (n) => {
    const keys = POLLO_SET.slice(0, n);
    const html = render(<Renderer model={collageModel(keys, { headline: "OFERTAS DE POLLO" })} />);
    const text = textOf(html);
    expect(text).toContain("OFERTAS DE POLLO");
    expect(html.toLowerCase()).toContain(ARTWORK_COLORS.ACCENT_RED.toLowerCase());
    // Una foto por producto (+ el logo) y una pastilla de precio amarilla por producto.
    expect(count(html, "data:image/png;base64,BBBB")).toBe(n);
    expect(count(html, 'data-testid="artwork-price"')).toBe(n);
    expect(count(html.toLowerCase(), `background:${PRICE_BADGE_YELLOW.toLowerCase()}`)).toBe(n);
    for (const price of ["11.999", "17.999", "17.999", "5.499", "19.999"].slice(0, n)) expect(text).toContain(price);
  });

  it("el orden de los productos es el de la lista", () => {
    const html = render(<Renderer model={collageModel(["alitas", "pataMuslo", "filet"])} />);
    const text = textOf(html);
    const positions = ["ALITAS", "PATA MUSLO", "FILET"].map((name) => text.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("máximo 5: con 6 productos no se dibuja una pieza ilegible, se rechaza", () => {
    const model = collageModel(POLLO_SET);
    const sixth = model.items[0];
    if (!sixth) throw new Error("sin ítem");
    const six: OfferArtworkModel = { ...model, items: [...model.items, sixth] };
    expect(() => render(<Renderer model={six} />)).toThrow(RangeError);
    expect(() => render(<Renderer model={{ ...model, items: model.items.slice(0, 1) }} />)).toThrow(RangeError);
  });

  it("promoción «llevando N»: precio promocional + condición dentro de la pastilla; sin promoción, ninguna condición", () => {
    const html = render(<Renderer model={collageModel(MILANESA_SET, { headline: "X MAYOR" })} />);
    const text = textOf(html);
    expect(text).toContain("X MAYOR");
    expect(text).toContain("28.349");
    expect(text).toContain("LLEVANDO 3 UNIDADES");
    // Sólo la tercera caja tiene promoción.
    expect(count(text, "LLEVANDO")).toBe(1);
    expect(text).toContain("31.499");
    expect(text).toContain("53.999");
    expect(text).not.toMatch(/%|DESDE/);
  });

  it("producto por peso: /KG junto al precio; por unidad, sin sufijo", () => {
    const html = render(<Renderer model={collageModel(["nalga", "milaCerdo"])} />);
    const text = textOf(html);
    expect(text).toContain("17.900");
    expect(count(text, "/KG")).toBe(1);
  });

  it("producto sin foto: panel de reemplazo digno (sin error ni hueco) y el resto sigue con su foto", () => {
    const html = render(<Renderer model={collageModel(POLLO_SET.slice(0, 3), { noPhoto: ["filet"] })} />);
    expect(count(html, "data:image/png;base64,BBBB")).toBe(2);
    expect(html).toContain("<svg");
    expect(textOf(html)).toContain("FILET DE PECHUGA");
    expect(textOf(html)).not.toMatch(/error|undefined|null/i);
  });

  it("nombres largos se achican, no desbordan ni cortan un nombre razonable", () => {
    const html = render(<Renderer model={collageModel(["pataMuslo", "alitas", "polloEntero", "milaVacuna"], { overrides: { alitas: { name: "Alitas de pollo premium bandeja familiar x 2 kg" } } })} />);
    const text = textOf(html);
    expect(text).toContain("BANDEJA FAMILIAR");
    expect(text).not.toContain("...");
  });

  it("contacto de la sucursal elegida abajo a la izquierda", () => {
    const html = render(<Renderer model={collageModel(POLLO_SET)} />);
    const text = textOf(html);
    expect(text).toContain("3496-448808");
    expect(text).toContain("GÜEMES 2180");
    expect(text).toContain("ESPERANZA, SANTA FE");
    expect(count(html, "artwork-contact-row")).toBe(3);
  });

  it("otra sucursal imprime lo suyo y nada de Central; sin datos, sin bloque", () => {
    const avenida = textOf(render(<Renderer model={collageModel(POLLO_SET, { branding: brandingFor("avenida") })} />));
    expect(avenida).toContain("0342 455-5555");
    expect(avenida).not.toMatch(/3496|GÜEMES|ESPERANZA/);
    expect(render(<Renderer model={collageModel(POLLO_SET, { branding: brandingFor(null) })} />)).not.toContain("artwork-contact-row");
    expect(render(<Renderer model={collageModel(POLLO_SET, { branding: brandingWithContact({ phone: null, address: null, city: null }) })} />)).not.toContain("artwork-contact-row");
  });

  it("sin logo: respaldo con el nombre de la organización (no se recrea un logo)", () => {
    const html = render(<Renderer model={collageModel(POLLO_SET, { branding: brandingFor("central", { logo: false }) })} />);
    expect(html).not.toContain('data-testid="artwork-logo"');
    expect(textOf(html)).toContain("AW ORG");
  });
});

describe("collage Feed y Story: la misma pieza con otra composición", () => {
  it("mismos textos, precios y contacto en ambos formatos", () => {
    const model = collageModel(MILANESA_SET, { headline: "X MAYOR" });
    // Los saltos de renglón cambian con el ancho de cada composición: se compara el texto corrido.
    const flat = (html: string) => textOf(html).replace(/\|/g, " ").replace(/\s+/g, " ");
    const feed = flat(render(<FeedCollageOffer model={model} />));
    const story = flat(render(<StoryCollageOffer model={model} />));
    for (const piece of ["X MAYOR", "MILANESAS DE CERDO", "MILANESAS VACUNAS", "MILANESAS DE POLLO", "31.499", "53.999", "28.349", "LLEVANDO 3 UNIDADES", "3496-448808"]) {
      expect(feed).toContain(piece);
      expect(story).toContain(piece);
    }
  });

  it("OfferArtwork elige el collage por el tipo del modelo y el preview dibuja exactamente lo mismo que el PNG", () => {
    const model = collageModel(POLLO_SET);
    expect(render(<OfferArtwork format="feed" model={model} />)).toContain('data-testid="artwork-collage-feed"');
    expect(render(<OfferArtwork format="story" model={model} />)).toContain('data-testid="artwork-collage-story"');
    for (const format of ["feed", "story"] as const) {
      const preview = render(<ArtworkPreview format={format} model={model} />);
      expect(preview).toContain(render(<OfferArtwork format={format} model={model} />));
      expect(preview).toContain("@font-face");
    }
  });

  it("sin sombras ni efectos: las pastillas son planas", () => {
    const html = render(<FeedCollageOffer model={collageModel(POLLO_SET)} />);
    expect(html).not.toMatch(/box-shadow|text-shadow|gradient/);
  });
});
