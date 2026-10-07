import { describe, expect, it } from "vitest";

import {
  buildEditorDisplay, buildOfferSlide, buildSignageView, clampSlideSeconds, formatMinimumWeight, isWellFormedToken, moveItem, nameFitFor,
  parseSlideFacts, priceFitFor, splitPrice, summarizeOffer, tvPath, type SlideFacts
} from "./signage";

const unit = (overrides: Partial<SlideFacts> = {}): SlideFacts => ({
  key: "s1", name: "Mayonesa Hellmann's 250gr", unitType: "UNIT", listPriceCents: 203_500n, bulkMinimumUnits: 3, bulkDiscountBps: 1_500, weightTiers: [], ...overrides
});
const weight = (overrides: Partial<SlideFacts> = {}): SlideFacts => ({
  key: "w1", name: "Molida vacuna", unitType: "WEIGHT", listPriceCents: 1_100_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], ...overrides
});

describe("buildOfferSlide — productos por unidad", () => {
  it("con promoción «llevando 3»: precio efectivo del motor, condición y precio unitario", () => {
    const offer = buildOfferSlide(unit());
    expect(offer).not.toBeNull();
    expect(offer?.variant).toBe("BULK");
    // 2.035 − 15 % = 1.729,75 (el mismo número que la etiqueta de góndola y el POS)
    expect(offer?.price).toEqual({ whole: "1.729", cents: "75" });
    expect(offer?.condition).toBe("LLEVANDO 3 UNIDADES");
    expect(offer?.secondary).toBe("Precio unitario $ 2.035");
    expect(offer?.promo).toBe(true);
    expect(offer?.name).toBe("Mayonesa Hellmann's 250gr");
  });

  it("el descuento sale del motor (calculateBranchPromotionLinePricing), no de una fórmula local: otro % y otro mínimo", () => {
    const offer = buildOfferSlide(unit({ listPriceCents: 100_000n, bulkMinimumUnits: 4, bulkDiscountBps: 2_000 }));
    expect(offer?.price).toEqual({ whole: "800", cents: null });
    expect(offer?.condition).toBe("LLEVANDO 4 UNIDADES");
    expect(offer?.secondary).toBe("Precio unitario $ 1.000");
  });

  it("sin promoción NO inventa «llevando 3»: precio unitario y nada más", () => {
    const offer = buildOfferSlide(unit({ name: "Aceite Cañuelas 900ml", listPriceCents: 245_000n, bulkMinimumUnits: null, bulkDiscountBps: null }));
    expect(offer?.variant).toBe("REGULAR");
    expect(offer?.price).toEqual({ whole: "2.450", cents: null });
    expect(offer?.condition).toBe("PRECIO UNITARIO");
    expect(offer?.secondary).toBeNull();
    expect(offer?.promo).toBe(false);
    expect(JSON.stringify(offer)).not.toMatch(/llevando/i);
  });

  it("una regla con 0 % o inválida se ignora (no rompe ni inventa)", () => {
    expect(buildOfferSlide(unit({ bulkDiscountBps: 0 }))?.variant).toBe("REGULAR");
    expect(buildOfferSlide(unit({ bulkDiscountBps: 10_000 }))?.variant).toBe("REGULAR");
    expect(buildOfferSlide(unit({ bulkMinimumUnits: 1 }))?.variant).toBe("REGULAR");
    expect(buildOfferSlide(unit({ bulkMinimumUnits: null }))?.variant).toBe("REGULAR");
  });

  it("un precio no positivo no es una oferta mostrable", () => {
    expect(buildOfferSlide(unit({ listPriceCents: 0n }))).toBeNull();
    expect(buildOfferSlide(unit({ listPriceCents: -5n }))).toBeNull();
  });
});

describe("buildOfferSlide — productos por peso", () => {
  it("fallback: precio por kilo sin promoción", () => {
    const offer = buildOfferSlide(weight());
    expect(offer?.variant).toBe("WEIGHT");
    expect(offer?.price).toEqual({ whole: "11.000", cents: null });
    expect(offer?.priceSuffix).toBe("/ KG");
    expect(offer?.condition).toBe("PRECIO POR KILO");
    expect(offer?.promo).toBe(false);
  });

  it("tramo porcentual «desde 2 kg»: lo resuelve applyWeightDiscount", () => {
    const offer = buildOfferSlide(weight({ weightTiers: [{ id: "t1", minimumGrams: 2_000, discountType: "PERCENTAGE", discountValue: 1_000n }] }));
    expect(offer?.variant).toBe("WEIGHT_PROMO");
    expect(offer?.price).toEqual({ whole: "9.900", cents: null });
    expect(offer?.condition).toBe("DESDE 2 KG");
    expect(offer?.secondary).toBe("Precio normal $ 11.000 / KG");
    expect(offer?.promo).toBe(true);
  });

  it("tramo de precio fijo por kilo; con varios tramos anuncia el de menor peso", () => {
    const offer = buildOfferSlide(weight({ weightTiers: [
      { id: "t2", minimumGrams: 5_000, discountType: "FIXED_PRICE_PER_KG", discountValue: 900_000n },
      { id: "t1", minimumGrams: 500, discountType: "FIXED_PRICE_PER_KG", discountValue: 1_000_000n }
    ] }));
    expect(offer?.price).toEqual({ whole: "10.000", cents: null });
    expect(offer?.condition).toBe("DESDE 0,5 KG");
  });

  it("un tramo que no es un descuento (fijo mayor al precio) cae al precio de lista", () => {
    const offer = buildOfferSlide(weight({ weightTiers: [{ id: "t1", minimumGrams: 2_000, discountType: "FIXED_PRICE_PER_KG", discountValue: 1_200_000n }] }));
    expect(offer?.variant).toBe("WEIGHT");
    expect(offer?.price.whole).toBe("11.000");
  });

  it("el peso mínimo se formatea en kilos", () => {
    expect(formatMinimumWeight(2_000)).toBe("2 KG");
    expect(formatMinimumWeight(2_500)).toBe("2,5 KG");
  });
});

describe("formato y ajustes tipográficos", () => {
  it("separa enteros y centavos con el formato del sistema", () => {
    expect(splitPrice(172_975n)).toEqual({ whole: "1.729", cents: "75" });
    expect(splitPrice(245_000n)).toEqual({ whole: "2.450", cents: null });
    expect(splitPrice(5_000n)).toEqual({ whole: "50", cents: null });
    expect(splitPrice(1_234_500_050n)).toEqual({ whole: "12.345.000", cents: "50" });
  });

  it("los nombres largos se achican con piso; los cortos no", () => {
    expect(nameFitFor("Aceite Cañuelas 900ml")).toBe(1);
    expect(nameFitFor("x".repeat(44))).toBe(0.5);
    expect(nameFitFor("x".repeat(500))).toBe(0.5);
    expect(nameFitFor("Hamburguesas de carne vacuna x 4")).toBeLessThan(1);
  });

  it("los precios muy largos se achican; los habituales no", () => {
    expect(priceFitFor({ whole: "1.729", cents: "75" }, null)).toBe(1);
    expect(priceFitFor({ whole: "11.000", cents: null }, "/ KG")).toBe(1);
    expect(priceFitFor({ whole: "123.456.789", cents: "99" }, "/ KG")).toBeLessThan(1);
    expect(priceFitFor({ whole: "999.999.999.999", cents: "99" }, "/ KG")).toBeGreaterThanOrEqual(0.4);
  });

  it("la duración se limita a 3–60 s y por defecto 8", () => {
    expect(clampSlideSeconds(1)).toBe(3);
    expect(clampSlideSeconds(500)).toBe(60);
    expect(clampSlideSeconds(12)).toBe(12);
    expect(clampSlideSeconds(Number.NaN)).toBe(8);
  });

  it("valida el formato del token", () => {
    expect(isWellFormedToken("a".repeat(64))).toBe(true);
    expect(isWellFormedToken("A".repeat(64))).toBe(false);
    expect(isWellFormedToken("a".repeat(63))).toBe(false);
    expect(isWellFormedToken("../etc/passwd")).toBe(false);
    expect(tvPath("abc")).toBe("/tv/abc");
  });
});

describe("lectura del JSON de la base (defensiva)", () => {
  const publicPayload = (slides: unknown[], extra: Record<string, unknown> = {}) => ({
    status: "ACTIVE", slideDurationSeconds: 12, organizationName: "Despensa Demo", slides, ...extra
  });
  const rawUnit = { slideId: "a", name: "Mayonesa", unitType: "UNIT", listPriceCents: "203500", bulkMinimumUnits: 3, bulkDiscountBps: 1500, weightTiers: [] };
  const rawWeight = { slideId: "b", name: "Molida", unitType: "WEIGHT", listPriceCents: "1100000", bulkMinimumUnits: null, bulkDiscountBps: null,
    weightTiers: [{ id: "t", minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000" }] };

  it("arma la vista con el orden, la duración y la marca", () => {
    const view = buildSignageView(publicPayload([rawWeight, rawUnit]));
    expect(view?.slides.map((slide) => slide.name)).toEqual(["Molida", "Mayonesa"]);
    expect(view?.slides[0]?.variant).toBe("WEIGHT_PROMO");
    expect(view?.slides[1]?.variant).toBe("BULK");
    expect(view?.slideDurationSeconds).toBe(12);
    expect(view?.organizationName).toBe("Despensa Demo");
  });

  it("un slide con datos inválidos se descarta sin romper los demás", () => {
    const view = buildSignageView(publicPayload([null, 7, { slideId: "x" }, { ...rawUnit, listPriceCents: "abc" }, { ...rawUnit, unitType: "KIT" }, rawUnit]));
    expect(view?.slides).toHaveLength(1);
    expect(view?.slides[0]?.name).toBe("Mayonesa");
  });

  it("pantalla desactivada: sin slides aunque la base los mandara", () => {
    const view = buildSignageView(publicPayload([rawUnit], { status: "DISABLED" }));
    expect(view?.status).toBe("DISABLED");
    expect(view?.slides).toEqual([]);
  });

  it("la vista del Admin: los slides no disponibles no llegan al reproductor", () => {
    const view = buildSignageView(publicPayload([{ ...rawUnit, available: false, unavailableReason: "NO_PRICE" }, { ...rawUnit, slideId: "z", available: true }]));
    expect(view?.slides.map((slide) => slide.key)).toEqual(["z"]);
  });

  it("null (token inexistente) y formas raras no producen una vista", () => {
    expect(buildSignageView(null)).toBeNull();
    expect(buildSignageView("hola")).toBeNull();
    expect(buildSignageView([])).toBeNull();
    expect(buildSignageView({})?.slides).toEqual([]);
  });

  it("una duración fuera de rango se corrige, una ausente usa el valor por defecto", () => {
    expect(buildSignageView(publicPayload([], { slideDurationSeconds: 1 }))?.slideDurationSeconds).toBe(3);
    expect(buildSignageView(publicPayload([], { slideDurationSeconds: null }))?.slideDurationSeconds).toBe(8);
  });

  it("los hechos aceptan el precio como número o como texto, nunca como otra cosa", () => {
    expect(parseSlideFacts({ ...rawUnit, listPriceCents: 203500 })?.listPriceCents).toBe(203_500n);
    expect(parseSlideFacts({ ...rawUnit, listPriceCents: 1.5 })).toBeNull();
    expect(parseSlideFacts({ ...rawUnit, listPriceCents: {} })).toBeNull();
  });
});

describe("editor del Admin", () => {
  const adminPayload = {
    displayId: "d1", name: "TV Despensa Central", enabled: true, branchId: "b1", slideDurationSeconds: 10, tokenRotatedAt: "2026-10-07T12:00:00Z",
    slides: [
      { slideId: "s1", position: 0, productId: "p1", name: "Mayonesa", sku: "SKU1", unitType: "UNIT", available: true, unavailableReason: null,
        listPriceCents: "203500", bulkMinimumUnits: 3, bulkDiscountBps: 1500, weightTiers: [] },
      { slideId: "s2", position: 1, productId: "p2", name: "Viejo", sku: null, unitType: "UNIT", available: false, unavailableReason: "NO_PRICE",
        listPriceCents: null, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [] }
    ]
  };

  it("resume la oferta de cada slide y conserva el motivo de los no disponibles", () => {
    const display = buildEditorDisplay(adminPayload);
    expect(display?.name).toBe("TV Despensa Central");
    expect(display?.slideDurationSeconds).toBe(10);
    expect(display?.branchId).toBe("b1");
    expect(display?.slides[0]?.summary).toBe("$ 1.729,75 · llevando 3 unidades");
    expect(display?.slides[0]?.unavailable).toBeNull();
    expect(display?.slides[1]).toMatchObject({ summary: null, unavailable: "NO_PRICE" });
  });

  it("summarizeOffer no repite la condición cuando no hay promoción", () => {
    const offer = buildOfferSlide(weight());
    expect(offer && summarizeOffer(offer)).toBe("$ 11.000 / kg");
  });

  it("reordena: sube y baja de a una posición, los extremos no se mueven", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    const original = ["a", "b"];
    moveItem(original, 0, 1);
    expect(original).toEqual(["a", "b"]);
  });
});

describe("privacidad: lo que se dibuja no contiene costos, márgenes ni datos administrativos", () => {
  it("una oferta sólo tiene campos comerciales", () => {
    const offer = buildOfferSlide(unit());
    expect(Object.keys(offer ?? {}).sort()).toEqual(["condition", "key", "name", "nameFit", "price", "priceSuffix", "promo", "secondary", "variant"]);
  });

  it("aunque la base mandara campos de más, la vista no los arrastra", () => {
    const view = buildSignageView({
      status: "ACTIVE", slideDurationSeconds: 8, organizationName: "X",
      slides: [{ slideId: "a", name: "Mayonesa", unitType: "UNIT", listPriceCents: "203500", costCents: 123456, marginBps: 3333, stock: 9, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [] }]
    });
    expect(JSON.stringify(view)).not.toMatch(/123456|3333|cost|margin|stock/i);
  });
});
