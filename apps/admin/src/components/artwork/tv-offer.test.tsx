import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { slideToArtworkModel } from "../../lib/artwork";
import { TV_LAYOUTS } from "../../lib/artwork-tv-layouts";
import { ARTWORK_COLORS, ARTWORK_FORMATS, PRICE_BADGE_YELLOW } from "../../lib/artwork-tokens";
import { buildSignageView } from "../../lib/signage";
import { signageMediaUrls } from "../../lib/signage-media";
import { LOGO_URL, PHOTO_URL, brandingFor, heroModel } from "../../lib/test-support/artwork-models";
import { slideOffer } from "../../lib/test-support/signage-fixtures";
import { ArtworkPreview } from "./artwork-preview";
import { OfferArtwork } from "./offer-artwork";
import { TvOfferSlide } from "./tv-offer";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
/** Texto corrido: los renglones del nombre cambian con el ancho de cada disposición. */
const flat = (html: string) => textOf(html).replace(/\|/g, " ").replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;

const withPhoto = (key: Parameters<typeof heroModel>[0], extras: Parameters<typeof heroModel>[1] = {}) => heroModel(key, { imageUrl: PHOTO_URL, ...extras });

describe("TvOfferSlide — la identidad de Super Ofertas en 16:9", () => {
  it("lienzo de 1920 × 1080 blanco con la franja verde y el LOGO real; titular rojo, nombre negro, foto comercial y pastilla amarilla", () => {
    const html = render(<TvOfferSlide model={withPhoto("nalga", { headline: "IMPERDIBLE" })} />);
    const spec = ARTWORK_FORMATS.tv;
    expect(html).toContain('data-testid="artwork-tv"');
    expect(html).toContain(`width:${String(spec.width)}px;height:${String(spec.height)}px`);
    expect(html.toLowerCase()).toContain(`background:${ARTWORK_COLORS.WHITE.toLowerCase()}`);
    expect(html.toLowerCase()).toContain(ARTWORK_COLORS.BRAND_GREEN.toLowerCase());
    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(html.toLowerCase()).toContain(ARTWORK_COLORS.ACCENT_RED.toLowerCase());
    expect(textOf(html)).toContain("IMPERDIBLE");
    expect(flat(html)).toContain("NALGA VACUNA");
    expect(count(html, PHOTO_URL)).toBe(1);
    expect(count(html.toLowerCase(), `background:${PRICE_BADGE_YELLOW.toLowerCase()}`)).toBe(1);
    expect(html).toContain('data-testid="artwork-price"');
  });

  it("no queda nada del diseño bordó viejo (ni el nombre interno de la organización, ni gradientes ni «PRECIO POR KILO»)", () => {
    const html = render(<TvOfferSlide model={withPhoto("nalga")} />);
    expect(html).not.toMatch(/gradient|#9f1239|#6b0b26|text-shadow|offer-slide|offer-brand/i);
    expect(textOf(html)).not.toMatch(/CARNICER|PRECIO POR KILO|AW ORG/);
  });

  it("producto por peso: precio con /KG y «X KG»; por unidad: sin sufijo", () => {
    const weight = textOf(render(<TvOfferSlide model={withPhoto("nalga")} />));
    expect(weight).toContain("17.900");
    expect(weight).toContain("/KG");
    expect(weight).toContain("X KG");
    const unit = textOf(render(<TvOfferSlide model={withPhoto("sinFoto")} />));
    expect(unit).toContain("2.450");
    expect(unit).not.toContain("/KG");
  });

  it("promoción real: precio promocional + «LLEVANDO 3 UNIDADES» + «PRECIO NORMAL» (los del motor, sin recalcular)", () => {
    const text = textOf(render(<TvOfferSlide model={withPhoto("mayo", { headline: "X MAYOR" })} />));
    expect(text).toContain("X MAYOR");
    expect(text).toContain("1.742");
    expect(text).toContain("LLEVANDO 3 UNIDADES");
    expect(text).toContain("PRECIO NORMAL $ 2.050");
  });

  it("sin promoción: no inventa condición, precio normal ni descuento", () => {
    const text = textOf(render(<TvOfferSlide model={withPhoto("sinFoto")} />));
    expect(text).not.toMatch(/LLEVANDO|PRECIO NORMAL|DESDE|%/);
  });

  it("sin foto: panel de reemplazo limpio que conserva nombre, precio y marca (nunca un error ni un hueco)", () => {
    const html = render(<TvOfferSlide model={heroModel("sinFoto")} />);
    expect(html).toContain("<svg");
    expect(html).not.toContain(PHOTO_URL);
    expect(flat(html)).toContain("ACEITE CAÑUELAS 900ML");
    expect(textOf(html)).toContain("2.450");
    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(textOf(html)).not.toMatch(/error|undefined|null/i);
  });

  it("sin logo: el respaldo de marca existente (el nombre en la franja), no un logo inventado", () => {
    const html = render(<TvOfferSlide model={withPhoto("nalga", { branding: brandingFor("central", { logo: false }) })} />);
    expect(html).not.toContain('data-testid="artwork-logo"');
    expect(textOf(html)).toContain("AW ORG");
  });

  it("el nombre largo se achica sin cortarse", () => {
    const text = textOf(render(<TvOfferSlide model={withPhoto("largo")} />));
    expect(text).toContain("CAJA 1,2 KG");
    expect(text).not.toContain("...");
  });

  it("TV no muestra contacto aunque la sucursal lo tenga (prioridad: marca, foto, precio)", () => {
    const text = textOf(render(<TvOfferSlide model={withPhoto("nalga")} />));
    expect(text).not.toMatch(/3496|GÜEMES|ESPERANZA/);
    expect(render(<TvOfferSlide model={withPhoto("nalga")} />)).not.toContain("artwork-contact-row");
  });
});

describe("las cuatro variantes alternan según la posición de la diapositiva", () => {
  const model = withPhoto("nalga");
  const variantOf = (index: number) => /data-artwork-variant="([A-Z_]+)"/.exec(render(<TvOfferSlide model={model} slideIndex={index} />))?.[1];

  it("0 → A, 1 → B, 2 → C, 3 → D, 4 → A", () => {
    expect([0, 1, 2, 3, 4].map(variantOf)).toEqual(["PHOTO_LEFT", "PHOTO_RIGHT", "PHOTO_CENTER", "DIAGONAL", "PHOTO_LEFT"]);
    expect(TV_LAYOUTS).toHaveLength(4);
  });

  it("cada variante pone la foto en otro lugar: el HTML es distinto pero los textos son los mismos", () => {
    const htmls = [0, 1, 2, 3].map((index) => render(<TvOfferSlide model={model} slideIndex={index} />));
    expect(new Set(htmls).size).toBe(4);
    for (const html of htmls) {
      expect(flat(html)).toContain("NALGA VACUNA");
      expect(textOf(html)).toContain("17.900");
      expect(count(html, PHOTO_URL)).toBe(1);
    }
  });

  it("la foto de cada variante es grande (al menos 40 % del área útil) y está declarada en el HTML", () => {
    for (const layout of TV_LAYOUTS) {
      const html = render(<TvOfferSlide model={model} slideIndex={TV_LAYOUTS.indexOf(layout)} />);
      expect(html).toContain(`left:${String(layout.photo.x)}px;top:${String(layout.photo.y)}px;width:${String(layout.photo.w)}px;height:${String(layout.photo.h)}px`);
      expect(html).toContain("object-fit:contain");
    }
  });
});

describe("la diapositiva del televisor y la pieza de Piezas son el mismo renderer y el mismo modelo", () => {
  it("OfferArtwork en TV dibuja exactamente TvOfferSlide, y el preview del Admin contiene esa misma salida", () => {
    const model = withPhoto("mayo");
    for (const index of [0, 1, 2, 3]) {
      expect(render(<OfferArtwork format="tv" model={model} slideIndex={index} />)).toBe(render(<TvOfferSlide model={model} slideIndex={index} />));
      const preview = render(<ArtworkPreview format="tv" model={model} slideIndex={index} />);
      expect(preview).toContain(render(<TvOfferSlide model={model} slideIndex={index} />));
      expect(preview).toContain("@font-face");
    }
  });

  it("una oferta de la presentación (precio/promoción del motor + foto + logo de la base) se convierte al mismo modelo de pieza", () => {
    const view = buildSignageView({
      status: "ACTIVE", slideDurationSeconds: 8, organizationName: "AW Org",
      logo: { storagePath: "o/branding/aaaa.png", contentType: "image/png", width: 480, height: 120 },
      slides: [{
        slideId: "0b1d6c1e-0000-4000-8000-000000000001", name: "Mayonesa", unitType: "UNIT", listPriceCents: "205000", bulkMinimumUnits: 3, bulkDiscountBps: 1500, weightTiers: [],
        photo: { storagePath: "o/p/bbbb.png", contentType: "image/png" }
      }]
    }, signageMediaUrls("/api/tv/tok"));
    const slide = view?.slides[0];
    if (!view || !slide) throw new Error("sin vista");
    const model = slideToArtworkModel(view, slide);
    expect(model.type).toBe("HERO");
    expect(model.items[0]).toMatchObject({ unitType: "UNIT", promotionCondition: "LLEVANDO 3 UNIDADES", productName: "MAYONESA" });
    expect(model.items[0]?.promotionalPrice).toEqual({ whole: "1.742", cents: "50" });
    expect(model.items[0]?.regularPrice).toEqual({ whole: "2.050", cents: null });
    expect(model.items[0]?.imageUrl).toBe(`/api/tv/tok/media/0b1d6c1e-0000-4000-8000-000000000001?v=bbbb`);
    expect(model.branding.logo?.imageUrl).toBe("/api/tv/tok/media/logo?v=aaaa");
    const html = render(<OfferArtwork format="tv" model={model} slideIndex={1} />);
    expect(html).toContain('src="/api/tv/tok/media/logo?v=aaaa"');
    expect(html).toContain('src="/api/tv/tok/media/0b1d6c1e-0000-4000-8000-000000000001?v=bbbb"');
  });

  it("una oferta sin foto ni promoción conserva el precio vigente y no inventa nada", () => {
    const view = { branding: brandingFor("central") };
    const model = slideToArtworkModel(view, slideOffer("k", "Aceite", "2.450"));
    expect(model.items[0]).toMatchObject({ promotionalPrice: null, promotionCondition: null, imageUrl: null, regularPrice: { whole: "2.450", cents: null } });
    expect(model.branding.contact).toBeNull();
  });
});
