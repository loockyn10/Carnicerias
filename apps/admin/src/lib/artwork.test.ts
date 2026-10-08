import { describe, expect, it } from "vitest";

import {
  artworkFilename, buildCollageArtworkModel, buildOfferArtworkModel, countMissingPhotos, formatPriceText, hasPromotion, heroPrice, normalizeHeadline,
  parseArtworkFacts, priceToCents
} from "./artwork";
import { buildOfferSlide, splitPrice } from "./signage";
import { COLLAGE_FACTS, COLLAGE_IDS, POLLO_SET, SAMPLE_FACTS } from "./test-support/artwork-fixtures";

const hero = (key: keyof typeof SAMPLE_FACTS, overrides: Record<string, unknown> = {}) => {
  const facts = parseArtworkFacts({ ...SAMPLE_FACTS[key], ...overrides });
  if (!facts) throw new Error("hechos inválidos");
  const built = buildOfferArtworkModel(facts, { headline: "OFERTA", imageUrl: null });
  if (!built) throw new Error("sin modelo");
  return built;
};
/** El único ítem del protagonista. */
const model = (key: keyof typeof SAMPLE_FACTS, overrides: Record<string, unknown> = {}) => {
  const item = hero(key, overrides).items[0];
  if (!item) throw new Error("sin ítem");
  return item;
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

  it("la sucursal viaja en el modelo (el contacto sale de la identidad, no de los hechos del producto)", () => {
    expect(hero("mayo").branch).toEqual({ name: "Central" });
    expect(hero("mayo", { branchName: null, branchId: null }).branch).toBeNull();
  });

  it("el nombre sale en mayúsculas sin caracteres que la fuente no tenga", () => {
    expect(model("sinFoto", { name: "Aceite ‘Cañuelas’ 900ml 😀" }).productName).toBe("ACEITE CAÑUELAS 900ML");
  });

  it("el protagonista es type HERO con exactamente un ítem", () => {
    const built = hero("mayo");
    expect(built.type).toBe("HERO");
    expect(built.items).toHaveLength(1);
    expect(built.items[0]?.productId).toBe(SAMPLE_FACTS.mayo.productId);
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
    expect(normalizeHeadline("una oferta demasiado larga para el cartel").length).toBeLessThanOrEqual(20);
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
    expect(artworkFilename(hero("nalga"), "feed")).toBe("super-ofertas-feed-nalga-vacuna.png");
    expect(artworkFilename(hero("sinFoto"), "story")).toBe("super-ofertas-story-aceite-canuelas-900ml.png");
    expect(artworkFilename(hero("largo"), "feed").length).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Collage (D-075)
// ---------------------------------------------------------------------------------------------------------------------

describe("buildCollageArtworkModel", () => {
  const entry = (facts: Record<string, unknown>, imageUrl: string | null = "data:image/png;base64,AAAA") => {
    const parsed = parseArtworkFacts(facts);
    if (!parsed) throw new Error("hechos inválidos");
    return { facts: parsed, imageUrl };
  };
  const pollo = POLLO_SET.map((key) => entry(COLLAGE_FACTS[key]));

  it.each([2, 3, 4, 5])("%s productos: arma un COLLAGE con todos los ítems EN EL ORDEN dado", (count) => {
    const result = buildCollageArtworkModel(pollo.slice(0, count), { headline: "ofertas de pollo" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.type).toBe("COLLAGE");
    expect(result.model.headline).toBe("OFERTAS DE POLLO");
    expect(result.model.items.map((item) => item.productId)).toEqual(POLLO_SET.slice(0, count).map((key) => COLLAGE_IDS[key]));
  });

  it("el orden elegido se respeta (invertido)", () => {
    const result = buildCollageArtworkModel([...pollo.slice(0, 3)].reverse(), { headline: "OFERTAS" });
    if (!result.ok) throw new Error("debería armarse");
    expect(result.model.items.map((item) => item.productName)).toEqual(["FILET DE PECHUGA X 2 KG", "PECHUGA ENTERA X 3 KG", "PATA MUSLO DE POLLO PREMIUM X 3 KG"]);
  });

  it("máximo 5 y mínimo 2: fuera de rango no se arma nada", () => {
    for (const entries of [pollo.slice(0, 1), [], [...pollo, entry(COLLAGE_FACTS.milaCerdo)]]) {
      const result = buildCollageArtworkModel(entries, { headline: "OFERTAS" });
      expect(result).toMatchObject({ ok: false, error: "COUNT" });
    }
  });

  it("sin titular el collage dice OFERTAS (y el protagonista OFERTA)", () => {
    const result = buildCollageArtworkModel(pollo.slice(0, 2), { headline: "" });
    if (!result.ok) throw new Error("debería armarse");
    expect(result.model.headline).toBe("OFERTAS");
    expect(normalizeHeadline("")).toBe("OFERTA");
  });

  it("promo «llevando N» y WEIGHT salen del mismo motor que el protagonista, ítem por ítem", () => {
    const result = buildCollageArtworkModel([entry(COLLAGE_FACTS.milaPollo), entry(SAMPLE_FACTS.nalga), entry(COLLAGE_FACTS.milaCerdo)], { headline: "X MAYOR" });
    if (!result.ok) throw new Error("debería armarse");
    const [promo, weight, plain] = result.model.items;
    expect(promo && hasPromotion(promo)).toBe(true);
    expect(promo?.promotionCondition).toBe("LLEVANDO 3 UNIDADES");
    expect(promo && formatPriceText(heroPrice(promo))).toBe("$ 28.349,10");
    expect(promo && formatPriceText(promo.regularPrice)).toBe("$ 31.499");
    expect(weight?.unitType).toBe("WEIGHT");
    expect(weight?.priceSuffix).toBe("/ KG");
    expect(weight && formatPriceText(heroPrice(weight))).toBe("$ 17.900");
    expect(plain && hasPromotion(plain)).toBe(false);
    expect(plain?.promotionCondition).toBeNull();
    expect(plain?.unitLabel).toBeNull();
  });

  it("producto sin foto: se arma igual y se cuenta para avisar en Admin", () => {
    const result = buildCollageArtworkModel([entry(COLLAGE_FACTS.pataMuslo, null), entry(COLLAGE_FACTS.pechuga), entry(COLLAGE_FACTS.filet, null)], { headline: "OFERTAS" });
    if (!result.ok) throw new Error("debería armarse");
    expect(countMissingPhotos(result.model)).toBe(2);
  });

  it("un producto no disponible impide armar el collage y se nombra (nunca se omite en silencio ni sale a $0)", () => {
    const sinPrecio = entry({ ...COLLAGE_FACTS.filet, available: false, unavailableReason: "NO_PRICE" });
    const otraSucursal = entry({ ...COLLAGE_FACTS.alitas, available: false, unavailableReason: "NOT_IN_BRANCH" });
    const result = buildCollageArtworkModel([pollo[0] as never, sinPrecio, otraSucursal], { headline: "OFERTAS" });
    expect(result).toMatchObject({ ok: false, error: "UNAVAILABLE" });
    if (result.ok || result.error !== "UNAVAILABLE") return;
    expect(result.unavailable.map((item) => item.reason)).toEqual(["NO_PRICE", "NOT_IN_BRANCH"]);
    expect(result.message).toContain("«Filet de pechuga x 2 kg» no tiene precio vigente");
    expect(result.message).toContain("«Alitas de pollo premium x 2 kg» no se vende en esa sucursal");
  });

  it("nombre de archivo del collage", () => {
    const result = buildCollageArtworkModel(pollo.slice(0, 2), { headline: "ofertas de pollo" });
    if (!result.ok) throw new Error("debería armarse");
    expect(artworkFilename(result.model, "feed")).toBe("super-ofertas-collage-feed-ofertas-de-pollo.png");
  });
});
