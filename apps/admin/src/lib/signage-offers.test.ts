import { describe, expect, it } from "vitest";

import { buildOfferSlide, parsePromotionFact, parseSlideFacts, type SlideFacts } from "./signage";
import { must } from "./test-support/must";

/** La mecánica promocional dicha como la dice el comercio (D-086): «LLEVANDO 3», «PACK 10 UNIDADES», «DESDE 2 KG» + precio por unidad y % real. */

const unit = (overrides: Partial<SlideFacts> = {}): SlideFacts => ({
  key: "u", name: "Hamburguesas", unitType: "UNIT", listPriceCents: 245_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], ...overrides
});
const offerOf = (facts: SlideFacts) => must(buildOfferSlide(facts));

describe("llevando N: precio por unidad del motor, mecánica y % real", () => {
  const offer = offerOf(unit({ bulkMinimumUnits: 3, bulkDiscountBps: 1_500, listPriceCents: 245_000n }));

  it("«LLEVANDO 3» + $2.082,50 C/U (15 % de $2.450), con el precio normal debajo", () => {
    expect(offer).toMatchObject({ variant: "BULK", mechanic: "LLEVANDO 3", savings: "15% OFF", priceSuffix: "C/U", condition: "LLEVANDO 3 UNIDADES", secondary: "Precio unitario $ 2.450" });
    expect(offer.price).toEqual({ whole: "2.082", cents: "50" });
    expect(offer.regularPrice).toEqual({ whole: "2.450", cents: null });
    expect(offer.promo).toBe(true);
  });

  it("sin descuento de cantidad no se inventa ninguna mecánica", () => {
    const plain = offerOf(unit());
    expect(plain).toMatchObject({ variant: "REGULAR", mechanic: null, savings: null, priceSuffix: null, promo: false });
  });
});

describe("pack del producto (D-064): «PACK 10 UNIDADES» + C/U + % OFF", () => {
  const pack = (list: bigint, bps: number, size = 10) => offerOf(unit({ listPriceCents: list, packSizeUnits: size, packDiscountBps: bps }));

  it("$1.650 con 25 % → $1.237,50 C/U (el motor del POS, no una cuenta nueva)", () => {
    const offer = pack(165_000n, 2_500);
    expect(offer).toMatchObject({ variant: "UNIT_PACK", mechanic: "PACK 10 UNIDADES", savings: "25% OFF", priceSuffix: "C/U", condition: "PACK 10 UNIDADES" });
    expect(offer.price).toEqual({ whole: "1.237", cents: "50" });
    expect(offer.regularPrice).toEqual({ whole: "1.650", cents: null });
  });

  it("un pack sin descuento (0 %) o con tamaño inválido no se anuncia como pack", () => {
    expect(pack(165_000n, 0).variant).toBe("REGULAR");
    expect(pack(165_000n, 2_500, 1).variant).toBe("REGULAR");
    expect(offerOf(unit({ packSizeUnits: null, packDiscountBps: 2_500 })).variant).toBe("REGULAR");
  });

  it("si el producto tiene «llevando N» y pack, se anuncia el que deja el menor precio por unidad; en empate, «llevando N»", () => {
    const base = { listPriceCents: 200_000n, bulkMinimumUnits: 3, packSizeUnits: 10 };
    expect(offerOf(unit({ ...base, bulkDiscountBps: 1_500, packDiscountBps: 2_500 })).variant).toBe("UNIT_PACK");
    expect(offerOf(unit({ ...base, bulkDiscountBps: 2_500, packDiscountBps: 1_500 })).variant).toBe("BULK");
    expect(offerOf(unit({ ...base, bulkDiscountBps: 2_000, packDiscountBps: 2_000 })).variant).toBe("BULK");
  });

  it("los hechos del pack viajan como enteros y se leen con defensa", () => {
    const facts = must(parseSlideFacts({ slideId: "u", name: "X", unitType: "UNIT", listPriceCents: "100000", packSizeUnits: 8, packDiscountBps: 2000, weightTiers: [] }));
    expect(facts).toMatchObject({ packSizeUnits: 8, packDiscountBps: 2_000 });
    const rare = must(parseSlideFacts({ slideId: "u", name: "X", unitType: "UNIT", listPriceCents: "100000", packSizeUnits: "ocho", weightTiers: [] }));
    expect(rare.packSizeUnits).toBeNull();
  });
});

describe("promociones por kilo y por pack a precio total", () => {
  const weight = (promotion: Record<string, unknown>) => offerOf({
    key: "w", name: "Pata muslo", unitType: "WEIGHT", listPriceCents: 1_000_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [],
    promotion: must(parsePromotionFact({ promotionId: "p", mode: "THRESHOLD", status: "ACTIVE", ...promotion }))
  });

  it("umbral por porcentaje: «DESDE 2 KG» y «10% OFF» (el porcentaje real de la regla)", () => {
    const offer = weight({ minimumGrams: 2_000, discountType: "PERCENTAGE", discountValue: "1000" });
    expect(offer).toMatchObject({ variant: "WEIGHT_PROMO", mechanic: "DESDE 2 KG", savings: "10% OFF" });
    expect(offer.price).toEqual({ whole: "9.000", cents: null });
  });

  it("precio fijo por kilo: «DESDE 1 KG» sin porcentaje inventado", () => {
    const offer = weight({ minimumGrams: 1_000, discountType: "FIXED_PRICE_PER_KG", discountValue: "900000" });
    expect(offer).toMatchObject({ mechanic: "DESDE 1 KG", savings: null });
    expect(offer.price).toEqual({ whole: "9.000", cents: null });
  });

  it("pack por kilo: «POR 2 KG» con el total fijo; pack por unidades: «PACK 6 UNIDADES»", () => {
    const kg = offerOf({
      key: "k", name: "Costilla", unitType: "WEIGHT", listPriceCents: 800_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [],
      promotion: must(parsePromotionFact({ promotionId: "p", mode: "PACK_FIXED_TOTAL", status: "ACTIVE", packQuantityGrams: 2_000, packPriceCents: "1400000" }))
    });
    expect(kg).toMatchObject({ variant: "PACK", mechanic: "POR 2 KG", savings: null, priceSuffix: null });
    expect(kg.price).toEqual({ whole: "14.000", cents: null });
    const units = offerOf({
      key: "c", name: "Chorizo", unitType: "UNIT", listPriceCents: 150_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [],
      promotion: must(parsePromotionFact({ promotionId: "p", mode: "PACK_FIXED_TOTAL", status: "ACTIVE", packQuantityUnits: 6, packPriceCents: "800000" }))
    });
    expect(units).toMatchObject({ mechanic: "PACK 6 UNIDADES" });
    expect(units.price).toEqual({ whole: "8.000", cents: null });
  });

  it("la vigencia de la promoción viaja con la oferta (para que el televisor la retire a tiempo aunque pierda conexión)", () => {
    expect(weight({ minimumGrams: 2_000, discountType: "PERCENTAGE", discountValue: "1000", validUntil: "2026-10-20T03:00:00Z" }).validUntil).toBe("2026-10-20T03:00:00Z");
    expect(weight({ minimumGrams: 2_000, discountType: "PERCENTAGE", discountValue: "1000" }).validUntil).toBeNull();
    const parsed = must(parsePromotionFact({ promotionId: "p", mode: "THRESHOLD", status: "ACTIVE", active: false, validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-10-05T00:00:00Z" }));
    expect(parsed).toMatchObject({ active: false, validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-10-05T00:00:00Z" });
  });
});

describe("el renderer no recalcula nada", () => {
  it("el precio de una oferta no depende del formato: sólo existe el que da el motor", () => {
    const offer = offerOf(unit({ bulkMinimumUnits: 3, bulkDiscountBps: 1_500 }));
    expect(`${offer.price.whole},${offer.price.cents ?? ""}`).toBe("2.082,50");
  });
});

describe("AZUCAR JL 1KG: 3u 15 % + 5u 20 % + Pack 10u 25 % → UNA oferta, la mejor", () => {
  const azucar = (overrides: Partial<SlideFacts> = {}) => offerOf(unit({ name: "AZUCAR JL 1KG", listPriceCents: 165_000n, ...overrides }));
  const tiers = [{ minimumUnits: 3, discountBps: 1_500 }, { minimumUnits: 5, discountBps: 2_000 }];

  it("3u → $1.402,50 C/U", () => {
    const offer = azucar({ bulkTiers: [tiers[0] ?? { minimumUnits: 3, discountBps: 1_500 }] });
    expect(offer).toMatchObject({ variant: "BULK", mechanic: "LLEVANDO 3", savings: "15% OFF" });
    expect(offer.price).toEqual({ whole: "1.402", cents: "50" });
  });

  it("3u + 5u → se anuncia el escalón de menor precio por unidad: 5u → $1.320 C/U", () => {
    const offer = azucar({ bulkTiers: tiers });
    expect(offer).toMatchObject({ variant: "BULK", mechanic: "LLEVANDO 5", savings: "20% OFF" });
    expect(offer.price).toEqual({ whole: "1.320", cents: null });
  });

  it("3u + 5u + Pack 10u 25 % → gana el Pack: $1.237,50 C/U, una sola oferta", () => {
    const offer = azucar({ bulkTiers: tiers, packSizeUnits: 10, packDiscountBps: 2_500 });
    expect(offer).toMatchObject({ variant: "UNIT_PACK", mechanic: "PACK 10 UNIDADES", savings: "25% OFF", secondary: "Precio unitario $ 1.650" });
    expect(offer.price).toEqual({ whole: "1.237", cents: "50" });
  });

  it("un Pack peor que el escalón no lo tapa (pack 10 % vs 5u 20 %)", () => {
    expect(azucar({ bulkTiers: tiers, packSizeUnits: 6, packDiscountBps: 1_000 })).toMatchObject({ variant: "BULK", mechanic: "LLEVANDO 5" });
  });

  it("los escalones viajan como enteros y se leen con defensa (los inválidos se descartan)", () => {
    const facts = parseSlideFacts({
      slideId: "a", name: "AZUCAR JL 1KG", unitType: "UNIT", listPriceCents: "165000", weightTiers: [],
      bulkTiers: [{ minimumUnits: 3, discountBps: 1500 }, { minimumUnits: 1, discountBps: 900 }, { minimumUnits: 5 }, "x", { minimumUnits: 5, discountBps: 2000 }]
    });
    expect(facts?.bulkTiers).toEqual(tiers);
  });
});
