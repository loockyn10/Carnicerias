import { describe, expect, it } from "vitest";

import {
  artworkFilename, buildOfferArtworkModel, formatPriceText, hasPromotion, heroPrice, normalizeHeadline, parseArtworkFacts, priceToCents
} from "./artwork";
import { buildOfferSlide, splitPrice } from "./signage";
import { SAMPLE_FACTS } from "./test-support/artwork-fixtures";

const model = (key: keyof typeof SAMPLE_FACTS, overrides: Record<string, unknown> = {}) => {
  const facts = parseArtworkFacts({ ...SAMPLE_FACTS[key], ...overrides });
  if (!facts) throw new Error("hechos inválidos");
  const built = buildOfferArtworkModel(facts, { headline: "OFERTA", imageUrl: null });
  if (!built) throw new Error("sin modelo");
  return built;
};

describe("OfferArtworkModel — UNIT con promoción «llevando N»", () => {
  const mayo = model("mayo");

  it("el precio promocional sale del motor existente (buildOfferSlide), no de un cálculo propio", () => {
    const engine = buildOfferSlide({ key: "x", name: "Mayonesa", unitType: "UNIT", listPriceCents: 205_000n, bulkMinimumUnits: 3, bulkDiscountBps: 1_500, weightTiers: [] });
    expect(engine?.promo).toBe(true);
    expect(mayo.promotionalPrice).toEqual(engine?.price);
    expect(mayo.promotionCondition).toBe(engine?.condition);
    expect(formatPriceText(mayo.promotionalPrice ?? splitPrice(0n))).toBe("$ 1.742,50");
  });

  it("muestra precio promocional + condición + precio normal, y el precio grande es el promocional", () => {
    expect(hasPromotion(mayo)).toBe(true);
    expect(mayo.promotionCondition).toBe("LLEVANDO 3 UNIDADES");
    expect(formatPriceText(mayo.regularPrice)).toBe("$ 2.050");
    expect(heroPrice(mayo)).toEqual(mayo.promotionalPrice);
    expect(mayo.priceSuffix).toBeNull();
    expect(mayo.unitLabel).toBeNull();
  });
});

describe("OfferArtworkModel — UNIT sin promoción", () => {
  const aceite = model("sinFoto");

  it("muestra sólo el precio vigente: sin «llevando», sin precio normal duplicado, sin descuento inventado", () => {
    expect(hasPromotion(aceite)).toBe(false);
    expect(aceite.promotionalPrice).toBeNull();
    expect(aceite.promotionCondition).toBeNull();
    expect(formatPriceText(heroPrice(aceite))).toBe("$ 2.450");
    expect(heroPrice(aceite)).toEqual(aceite.regularPrice);
  });

  it("una regla de promoción incompleta no inventa nada", () => {
    const sin = model("sinFoto", { bulkMinimumUnits: 3, bulkDiscountBps: null });
    expect(hasPromotion(sin)).toBe(false);
    expect(sin.promotionCondition).toBeNull();
  });
});

describe("OfferArtworkModel — WEIGHT", () => {
  it("nalga: precio por kilo vigente, sufijo /KG y «X KG»", () => {
    const nalga = model("nalga");
    expect(formatPriceText(heroPrice(nalga))).toBe("$ 17.900");
    expect(nalga.unitType).toBe("WEIGHT");
    expect(nalga.priceSuffix).toBe("/ KG");
    expect(nalga.unitLabel).toBe("X KG");
    expect(hasPromotion(nalga)).toBe(false);
  });

  it("con un tramo por cantidad real reutiliza applyWeightDiscount (desde N kg)", () => {
    const promo = model("nalga", { weightTiers: [{ id: "t1", minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000" }] });
    expect(hasPromotion(promo)).toBe(true);
    expect(promo.promotionCondition).toBe("DESDE 2 KG");
    expect(formatPriceText(heroPrice(promo))).toBe("$ 16.110");
    expect(formatPriceText(promo.regularPrice)).toBe("$ 17.900");
  });
});

describe("parseArtworkFacts", () => {
  it("producto no disponible: conserva el motivo y no arma pieza", () => {
    for (const reason of ["INACTIVE", "NOT_IN_BRANCH", "NO_PRICE"] as const) {
      const facts = parseArtworkFacts({ ...SAMPLE_FACTS.mayo, available: false, unavailableReason: reason });
      expect(facts?.available).toBe(false);
      expect(facts?.unavailableReason).toBe(reason);
      expect(facts && buildOfferArtworkModel(facts, { headline: "OFERTA", imageUrl: null })).toBeNull();
    }
  });

  it("precio 0 o respuesta rara: nunca se arma una pieza a $0", () => {
    const zero = parseArtworkFacts({ ...SAMPLE_FACTS.mayo, listPriceCents: "0" });
    expect(zero?.available).toBe(false);
    expect(parseArtworkFacts(null)).toBeNull();
    expect(parseArtworkFacts("x")).toBeNull();
    expect(parseArtworkFacts({})).toBeNull();
  });

  it("la foto sólo se acepta si es JPG o PNG con ruta", () => {
    expect(parseArtworkFacts({ ...SAMPLE_FACTS.mayo, photo: { storagePath: "a/b/c.webp", contentType: "image/webp" } })?.photo).toBeNull();
    expect(parseArtworkFacts({ ...SAMPLE_FACTS.mayo, photo: { storagePath: "", contentType: "image/png" } })?.photo).toBeNull();
    expect(parseArtworkFacts(SAMPLE_FACTS.mayo)?.photo?.contentType).toBe("image/png");
  });

  it("la sucursal y su dirección (si existe) viajan en el modelo; sin dirección no se inventa", () => {
    expect(model("mayo").branch).toEqual({ name: "Central", address: "Av. Siempre Viva 742" });
    expect(model("mayo", { branchAddress: null }).branch).toEqual({ name: "Central", address: null });
    expect(model("mayo", { branchName: null, branchId: null }).branch).toBeNull();
  });

  it("la marca es SUPER OFERTAS y el nombre sale en mayúsculas sin caracteres que la fuente no tenga", () => {
    const m = model("sinFoto", { name: "Aceite ‘Cañuelas’ 900ml 😀" });
    expect(m.businessName).toBe("SUPER OFERTAS");
    expect(m.productName).toBe("ACEITE CAÑUELAS 900ML");
  });
});

describe("normalizeHeadline", () => {
  it("por defecto OFERTA", () => {
    expect(normalizeHeadline(undefined)).toBe("OFERTA");
    expect(normalizeHeadline("")).toBe("OFERTA");
    expect(normalizeHeadline("   ")).toBe("OFERTA");
    expect(normalizeHeadline(42)).toBe("OFERTA");
  });

  it("mayúsculas, sin símbolos raros, corto", () => {
    expect(normalizeHeadline("x mayor")).toBe("X MAYOR");
    expect(normalizeHeadline("imperdible")).toBe("IMPERDIBLE");
    expect(normalizeHeadline("  especial  ")).toBe("ESPECIAL");
    expect(normalizeHeadline("<b>hola</b>")).toBe("BHOLAB");
    expect(normalizeHeadline("¡oferta!")).toBe("¡OFERTA!");
    expect(normalizeHeadline("una oferta demasiado larga para el cartel").length).toBeLessThanOrEqual(16);
  });

  it("un titular que queda vacío tras limpiar vuelve a OFERTA", () => {
    expect(normalizeHeadline("😀😀")).toBe("OFERTA");
  });
});

describe("helpers", () => {
  it("priceToCents invierte splitPrice", () => {
    for (const cents of [1n, 99n, 100n, 203_500n, 174_250n, 1_790_000n, 123_456_789n]) {
      expect(priceToCents(splitPrice(cents))).toBe(cents);
    }
  });

  it("nombre de archivo legible y seguro", () => {
    expect(artworkFilename(model("nalga"), "feed")).toBe("super-ofertas-feed-nalga-vacuna.png");
    expect(artworkFilename(model("sinFoto"), "story")).toBe("super-ofertas-story-aceite-canuelas-900ml.png");
    expect(artworkFilename(model("largo"), "feed").length).toBeLessThan(80);
  });
});
