import { describe, expect, it } from "vitest";

import { must } from "./test-support/must";

import { buildOfferSlide, buildSignageView, findSignageMedia, parsePromotionFact, parseSlideFacts, type SlideFacts } from "./signage";
import { signageMediaUrls } from "./signage-media";
import { filterByStatus, parsePromotionCatalog, statusCounts, validityText } from "./signage-promotions";

// Promociones y grupos en la cartelería de TV (D-084). Dinero en centavos.
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PATA = UUID(1);
const COSTILLA = UUID(2);
const COCA = UUID(3);
const MATAMBRE = UUID(4);

const facts = (overrides: Partial<SlideFacts> & { promotion: NonNullable<SlideFacts["promotion"]> }): SlideFacts => ({
  key: PATA, name: "Pata muslo", unitType: "WEIGHT", listPriceCents: 1_000_000n, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], ...overrides
});
const threshold = (overrides: Record<string, unknown> = {}) => must(parsePromotionFact({ promotionId: PATA, mode: "THRESHOLD", status: "ACTIVE", minimumGrams: 2_000, discountType: "PERCENTAGE", discountValue: "1000", ...overrides }));
const pack = (overrides: Record<string, unknown> = {}) => must(parsePromotionFact({ promotionId: COSTILLA, mode: "PACK_FIXED_TOTAL", status: "ACTIVE", packQuantityGrams: 2_000, packPriceCents: "1400000", ...overrides }));

describe("diapositivas de PROMOCIÓN (precio y condición del motor, nunca a mano)", () => {
  it("umbral por kg: «DESDE 2 KG» con el precio por kilo que da applyWeightDiscount y el precio normal por kilo", () => {
    const offer = buildOfferSlide(facts({ promotion: threshold() }));
    expect(offer).toMatchObject({ variant: "WEIGHT_PROMO", promo: true, condition: "DESDE 2 KG", priceSuffix: "/ KG", secondary: "Precio normal $ 10.000 / KG" });
    expect(offer?.price).toEqual({ whole: "9.000", cents: null });
    expect(offer?.regularPrice).toEqual({ whole: "10.000", cents: null });
  });

  it("umbral con precio fijo por kg", () => {
    const offer = buildOfferSlide(facts({ promotion: threshold({ discountType: "FIXED_PRICE_PER_KG", discountValue: "950000", minimumGrams: 5_000 }) }));
    expect(offer).toMatchObject({ variant: "WEIGHT_PROMO", condition: "DESDE 5 KG" });
    expect(offer?.price).toEqual({ whole: "9.500", cents: null });
  });

  it("pack por kg: el total fijo «POR 2 KG» contra el precio normal de ESA cantidad", () => {
    const offer = buildOfferSlide(facts({ key: COSTILLA, name: "Costilla de cerdo", listPriceCents: 800_000n, promotion: pack() }));
    expect(offer).toMatchObject({ variant: "PACK", promo: true, condition: "POR 2 KG", priceSuffix: null, secondary: "Precio normal $ 16.000" });
    expect(offer?.price).toEqual({ whole: "14.000", cents: null });
    expect(offer?.regularPrice).toEqual({ whole: "16.000", cents: null });
  });

  it("pack por unidades: «PACK 3 UNIDADES» y el precio normal de las 3", () => {
    const offer = buildOfferSlide(facts({ key: COCA, name: "Coca Cola", unitType: "UNIT", listPriceCents: 200_000n, promotion: pack({ promotionId: COCA, packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: "540000" }) }));
    expect(offer).toMatchObject({ variant: "PACK", condition: "PACK 3 UNIDADES", secondary: "Precio normal $ 6.000" });
    expect(offer?.price).toEqual({ whole: "5.400", cents: null });
  });

  it("un pack que no baja el precio (más caro que llevar suelto) no se anuncia como promoción: precio normal", () => {
    const offer = buildOfferSlide(facts({ key: COSTILLA, name: "Costilla de cerdo", listPriceCents: 800_000n, promotion: pack({ packPriceCents: "1700000" }) }));
    expect(offer).toMatchObject({ variant: "WEIGHT", promo: false, condition: "PRECIO POR KILO" });
    expect(offer?.price).toEqual({ whole: "8.000", cents: null });
  });

  it("un umbral inválido o que no descuenta cae al precio normal (no inventa un descuento)", () => {
    expect(buildOfferSlide(facts({ promotion: threshold({ discountType: "FIXED_PRICE_PER_KG", discountValue: "1200000" }) }))?.promo).toBe(false);
    expect(buildOfferSlide(facts({ promotion: threshold({ minimumGrams: null }) }))?.promo).toBe(false);
  });

  it("sin precio vigente no hay diapositiva (se saltea)", () => {
    expect(buildOfferSlide(facts({ listPriceCents: 0n, promotion: threshold() }))).toBeNull();
  });

  it("el cambio del precio promocional se refleja en la próxima lectura: nada queda copiado", () => {
    const before = buildOfferSlide(facts({ key: COCA, name: "Coca", unitType: "UNIT", listPriceCents: 200_000n, promotion: pack({ promotionId: COCA, packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: "540000" }) }));
    const after = buildOfferSlide(facts({ key: COCA, name: "Coca", unitType: "UNIT", listPriceCents: 200_000n, promotion: pack({ promotionId: COCA, packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: "480000" }) }));
    expect([before?.price.whole, after?.price.whole]).toEqual(["5.400", "4.800"]);
  });
});

describe("lo que recibe el televisor", () => {
  const photo = (id: number) => ({ storagePath: `org/${String(id)}/${UUID(100 + id)}.png`, contentType: "image/png" });
  const slide = (id: string, name: string, extra: Record<string, unknown>) => ({ slideId: id, kind: "PROMOTION", name, unitType: "WEIGHT", listPriceCents: "1000000", bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], ...extra });
  const payload = {
    status: "ACTIVE", slideDurationSeconds: 8, organizationName: "Org", logo: { storagePath: "org/branding/logo.png", contentType: "image/png", width: 800, height: 600 },
    slides: [
      slide(PATA, "Pata muslo", { photo: photo(1), promotion: { promotionId: PATA, mode: "THRESHOLD", status: "ACTIVE", minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000" } }),
      slide(COSTILLA, "Costilla de cerdo", { listPriceCents: "800000", photo: photo(2), promotion: { promotionId: COSTILLA, mode: "PACK_FIXED_TOTAL", status: "ACTIVE", packQuantityGrams: 2000, packPriceCents: "1400000" } }),
      slide(MATAMBRE, "Matambre", { promotion: { promotionId: MATAMBRE, mode: "PACK_FIXED_TOTAL", status: "ACTIVE", packQuantityGrams: 3000, packPriceCents: "3000000" }, listPriceCents: "1200000" })
    ]
  };
  const view = buildSignageView(payload, signageMediaUrls("/api/tv/TOKEN"));

  it("rotan en el orden recibido, con el precio promocional de cada una", () => {
    expect(view?.slides.map((slide) => slide.name)).toEqual(["Pata muslo", "Costilla de cerdo", "Matambre"]);
    expect(view?.slides.map((slide) => `${slide.price.whole}${slide.priceSuffix ?? ""}|${slide.condition}`)).toEqual(["9.000/ KG|DESDE 2 KG", "14.000|POR 2 KG", "30.000|POR 3 KG"]);
  });

  it("la foto se pide por la ruta autorizada del token con el id de la promoción (el bucket sigue privado)", () => {
    expect(view?.slides[0]?.imageUrl).toBe(`/api/tv/TOKEN/media/${PATA}?v=${UUID(101)}`);
    expect(view?.slides[1]?.imageUrl).toBe(`/api/tv/TOKEN/media/${COSTILLA}?v=${UUID(102)}`);
    expect(view?.slides[0]?.imageUrl).not.toContain("org/1/");
  });

  it("una promoción sin foto reproduce igual, sin imagen (el renderer dibuja el reemplazo)", () => {
    expect(view?.slides[2]).toMatchObject({ name: "Matambre", imageUrl: null });
  });

  it("la ruta de la imagen sale de la presentación publicada del token, nunca del pedido", () => {
    expect(findSignageMedia(payload, PATA)).toEqual({ storagePath: `org/1/${UUID(101)}.png`, contentType: "image/png" });
    expect(findSignageMedia(payload, MATAMBRE)).toBeNull();
    expect(findSignageMedia(payload, UUID(99))).toBeNull();
    expect(findSignageMedia({ ...payload, slides: [] }, PATA)).toBeNull();
  });

  it("la vista previa del Admin saltea las promociones no disponibles igual que el televisor", () => {
    const adminView = buildSignageView({ ...payload, slides: [{ ...payload.slides[0], available: false, unavailableReason: "PROMO_EXPIRED" }, { ...payload.slides[1], available: true }] });
    expect(adminView?.slides.map((slide) => slide.name)).toEqual(["Costilla de cerdo"]);
  });

  it("no filtra costos ni datos administrativos", () => {
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/costCents|cost_cents|margin|stock|marginBps/i);
  });
});

describe("parseSlideFacts / parsePromotionFact (lectura defensiva)", () => {
  it("un hecho de promoción mal formado se ignora: el slide queda como producto normal", () => {
    expect(parsePromotionFact({ mode: "OTRO" })).toBeNull();
    expect(parsePromotionFact(null)).toBeNull();
    const parsed = parseSlideFacts({ slideId: PATA, name: "Pata", unitType: "WEIGHT", listPriceCents: "100", promotion: { mode: "OTRO" } });
    expect(parsed?.promotion).toBeNull();
  });

  it("el precio del pack viaja como texto (bigint seguro)", () => {
    expect(pack().packPriceCents).toBe(1_400_000n);
    expect(threshold().discountValue).toBe(1_000n);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const rawOption = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  promotionId: id, productId: UUID(900), productName: name, sku: null, unitType: "WEIGHT", branchId: null, branchName: null, mode: "THRESHOLD", status: "ACTIVE",
  validFrom: "2026-10-01T00:00:00Z", validUntil: null, listPriceCents: "1000000", hasPhoto: true, unavailableReason: null, minimumGrams: 2000, discountType: "PERCENTAGE",
  discountValue: "1000", packQuantityGrams: null, packQuantityUnits: null, packPriceCents: null, ...extra
});

describe("catálogo de promociones del editor", () => {
  const catalog = parsePromotionCatalog({
    promotions: [
      rawOption(PATA, "Pata muslo"),
      rawOption(COSTILLA, "Costilla de cerdo", { mode: "PACK_FIXED_TOTAL", branchId: UUID(50), branchName: "Avenida", listPriceCents: "800000", minimumGrams: null, discountType: null, discountValue: null, packQuantityGrams: 2000, packPriceCents: "1400000", hasPhoto: false }),
      rawOption(COCA, "Coca Cola", { unitType: "UNIT", mode: "PACK_FIXED_TOTAL", listPriceCents: "200000", minimumGrams: null, discountType: null, discountValue: null, packQuantityUnits: 3, packPriceCents: "540000" }),
      rawOption(MATAMBRE, "Matambre", { status: "UPCOMING", validFrom: "2026-10-20T00:00:00Z" }),
      rawOption(UUID(5), "Vieja", { status: "EXPIRED", validUntil: "2026-10-05T00:00:00Z" }),
      { promotionId: "x" }
    ]
  });

  it("resume cada promoción con el motor y descarta las filas raras", () => {
    expect(catalog.promotions).toHaveLength(5);
    const summaries = Object.fromEntries(catalog.promotions.map((option) => [option.productName, option.summary]));
    expect(summaries["Pata muslo"]).toBe("$ 9.000 / kg · desde 2 kg");
    expect(summaries["Costilla de cerdo"]).toBe("$ 14.000 · por 2 kg");
    expect(summaries["Coca Cola"]).toBe("$ 5.400 · pack 3 unidades");
  });

  it("separa activas, próximas y vencidas (por defecto se ofrecen las activas)", () => {
    expect(statusCounts(catalog.promotions)).toEqual({ ACTIVE: 3, UPCOMING: 1, EXPIRED: 1 });
    expect(filterByStatus(catalog.promotions, "ACTIVE").map((option) => option.productName)).toEqual(["Pata muslo", "Costilla de cerdo", "Coca Cola"]);
    expect(filterByStatus(catalog.promotions, "EXPIRED").map((option) => option.productName)).toEqual(["Vieja"]);
  });

  it("dice la vigencia en lenguaje simple", () => {
    const by = (name: string) => must(catalog.promotions.find((option) => option.productName === name));
    expect(validityText(by("Pata muslo"))).toBe("Sin fecha de fin");
    expect(validityText(by("Matambre"))).toBe("Desde el 20/10/2026");
    expect(validityText(by("Vieja"))).toBe("Venció el 05/10/2026");
  });

  it("marca las que no tienen foto (se reproducen igual)", () => {
    const sinFoto = catalog.promotions.filter((option) => !option.hasPhoto).map((option) => option.productName);
    expect(sinFoto).toEqual(["Costilla de cerdo"]);
  });

});

