import { describe, expect, it } from "vitest";

import { must } from "./test-support/must";

import {
  buildEditorDisplay, buildOfferSlide, buildSignageView, findSignageMedia, parsePromotionFact, parseSlideFacts, type SlideFacts
} from "./signage";
import { signageMediaUrls } from "./signage-media";
import {
  addEntry, addPromotions, childrenOfGroup, entriesToInput, entryFromGroup, entryFromProduct, entryFromPromotion, entryKey, promotionReason, summarizeEntries
} from "./signage-entries";
import {
  countWithoutPhoto, filterByStatus, groupItemNote, parsePromotionCatalog, statusCounts, validityText, type PromotionOption
} from "./signage-promotions";

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

  it("pack por unidades: «POR 3 UNIDADES» y el precio normal de las 3", () => {
    const offer = buildOfferSlide(facts({ key: COCA, name: "Coca Cola", unitType: "UNIT", listPriceCents: 200_000n, promotion: pack({ promotionId: COCA, packQuantityGrams: null, packQuantityUnits: 3, packPriceCents: "540000" }) }));
    expect(offer).toMatchObject({ variant: "PACK", condition: "POR 3 UNIDADES", secondary: "Precio normal $ 6.000" });
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
    ],
    groups: [{ id: UUID(70), name: "Ofertas fin de semana", promotionIds: [COSTILLA, PATA], usedByDisplays: 2 }, { id: "sin-nombre" }]
  });

  it("resume cada promoción con el motor y descarta las filas raras", () => {
    expect(catalog.promotions).toHaveLength(5);
    const summaries = Object.fromEntries(catalog.promotions.map((option) => [option.productName, option.summary]));
    expect(summaries["Pata muslo"]).toBe("$ 9.000 / kg · desde 2 kg");
    expect(summaries["Costilla de cerdo"]).toBe("$ 14.000 · por 2 kg");
    expect(summaries["Coca Cola"]).toBe("$ 5.400 · por 3 unidades");
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
    expect(countWithoutPhoto(catalog.promotions, new Set([PATA, COSTILLA]))).toBe(1);
  });

  it("lee los grupos con el orden de sus promociones y en cuántas pantallas se usan", () => {
    expect(catalog.groups).toEqual([{ id: UUID(70), name: "Ofertas fin de semana", promotionIds: [COSTILLA, PATA], usedByDisplays: 2 }]);
  });

  it("notas de un grupo guardado: vencida, producto inactivo, sin foto o la promoción ya no existe", () => {
    const by = (name: string) => catalog.promotions.find((option) => option.productName === name);
    expect(groupItemNote(by("Pata muslo"))).toBe("");
    expect(groupItemNote(by("Vieja"))).toContain("Vencida");
    expect(groupItemNote(by("Costilla de cerdo"))).toBe("Sin foto");
    expect(groupItemNote(undefined)).toBe("La promoción ya no existe");
    expect(groupItemNote({ ...must(by("Pata muslo")), unavailable: "INACTIVE" })).toContain("Producto inactivo");
  });
});

describe("entradas de la pantalla (producto, promoción, grupo)", () => {
  const catalog = parsePromotionCatalog({
    promotions: [rawOption(PATA, "Pata muslo"), rawOption(COSTILLA, "Costilla", { hasPhoto: false }), rawOption(MATAMBRE, "Matambre", { status: "EXPIRED", validUntil: "2026-10-05T00:00:00Z" })],
    groups: [{ id: UUID(70), name: "Pollo", promotionIds: [PATA, COSTILLA, MATAMBRE, UUID(404)], usedByDisplays: 0 }]
  });
  const [pata, costilla, matambre] = catalog.promotions as [PromotionOption, PromotionOption, PromotionOption];
  const group = must(catalog.groups[0]);

  it("una promoción vencida o próxima no se reproduce y lo dice el motivo", () => {
    expect(promotionReason(pata)).toBeNull();
    expect(promotionReason(matambre)).toBe("PROMO_EXPIRED");
    expect(promotionReason({ status: "UPCOMING", unavailable: null })).toBe("PROMO_UPCOMING");
    expect(promotionReason({ status: "ACTIVE", unavailable: "NO_PRICE" })).toBe("NO_PRICE");
  });

  it("un grupo conserva sus promociones en orden y marca las que se saltean (la que ya no existe se omite)", () => {
    const entry = entryFromGroup(group, catalog);
    expect(entry.children.map((child) => [child.name, child.unavailable])).toEqual([["Pata muslo", null], ["Costilla", null], ["Matambre", "PROMO_EXPIRED"]]);
    expect(childrenOfGroup(group, catalog.promotions)).toHaveLength(3);
  });

  it("agrega una vez cada cosa y manda al servidor sólo kind + id (nada de precios)", () => {
    let entries = addEntry([], entryFromProduct({ id: UUID(900), name: "Producto", sku: null, unitType: "UNIT" })).entries;
    entries = addEntry(entries, entryFromPromotion(pata)).entries;
    entries = addEntry(entries, entryFromGroup(group, catalog)).entries;
    expect(addEntry(entries, entryFromPromotion(pata)).error).toBe("Esa promoción ya está en la presentación");
    expect(addEntry(entries, entryFromGroup(group, catalog)).error).toBe("Ese grupo ya está en la presentación");
    expect(entriesToInput(entries)).toEqual([{ kind: "PRODUCT", id: UUID(900) }, { kind: "PROMOTION", id: PATA }, { kind: "GROUP", id: UUID(70) }]);
    expect(JSON.stringify(entriesToInput(entries))).not.toMatch(/price|precio|name/i);
    expect(entryKey(must(entries[1]))).toBe(`PROMOTION:${PATA}`);
  });

  it("agregar varias promociones a la vez saltea las que ya estaban", () => {
    const first = addPromotions([], [pata, costilla]);
    expect(first.added).toBe(2);
    const second = addPromotions(first.entries, [costilla, matambre]);
    expect(second.added).toBe(1);
    expect(second.entries.map((entry) => entry.name)).toEqual(["Pata muslo", "Costilla", "Matambre"]);
  });

  it("resume cuántas entradas no se muestran y cuántas promociones no tienen foto", () => {
    const entries = addPromotions([], [pata, costilla, matambre]).entries;
    expect(summarizeEntries(entries)).toEqual({ blocked: 1, withoutPhoto: 1 });
    expect(summarizeEntries([entryFromGroup(group, catalog)])).toEqual({ blocked: 1, withoutPhoto: 1 });
  });
});

describe("editor: la pantalla tal como la devuelve el servidor", () => {
  const photo = { storagePath: "org/1/photo.png", contentType: "image/png" };
  const slide = (entryId: string, id: string, name: string, extra: Record<string, unknown>) => ({
    slideId: id, entryId, kind: "PROMOTION", position: 0, productId: UUID(900), name, sku: null, unitType: "WEIGHT", available: true, unavailableReason: null,
    listPriceCents: "1000000", bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [],
    promotion: { promotionId: id, mode: "THRESHOLD", status: "ACTIVE", minimumGrams: 2000, discountType: "PERCENTAGE", discountValue: "1000" }, photo, ...extra
  });
  const payload = {
    displayId: UUID(60), name: "TV Avenida", enabled: true, branchId: UUID(50), slideDurationSeconds: 8, tokenRotatedAt: "2026-10-10T12:00:00Z",
    entries: [
      { entryId: UUID(61), position: 0, kind: "PROMOTION", promotionId: PATA, productId: null, groupId: null, groupName: null, groupPromotionCount: 0 },
      { entryId: UUID(62), position: 1, kind: "GROUP", promotionId: null, productId: null, groupId: UUID(70), groupName: "Ofertas fin de semana", groupPromotionCount: 3 }
    ],
    slides: [
      slide(UUID(61), PATA, "Pata muslo", {}),
      slide(UUID(62), COSTILLA, "Costilla de cerdo", { photo: null, available: false, unavailableReason: "PROMO_EXPIRED", promotion: { promotionId: COSTILLA, mode: "PACK_FIXED_TOTAL", status: "EXPIRED", packQuantityGrams: 2000, packPriceCents: "1400000" } }),
      slide(UUID(62), MATAMBRE, "Matambre", { photo: null })
    ]
  };

  it("muestra la promoción con su resumen y el grupo con cada promoción, su estado y el aviso de foto", () => {
    const display = buildEditorDisplay(payload);
    expect(display?.entries.map((entry) => [entry.kind, entry.name])).toEqual([["PROMOTION", "Pata muslo"], ["GROUP", "Ofertas fin de semana"]]);
    expect(display?.entries[0]).toMatchObject({ id: PATA, summary: "$ 9.000 / kg · desde 2 kg", unavailable: null, hasPhoto: true });
    const children = display?.entries[1]?.children ?? [];
    expect(children.map((child) => [child.name, child.unavailable, child.hasPhoto])).toEqual([["Costilla de cerdo", "PROMO_EXPIRED", false], ["Matambre", null, false]]);
    expect(children[0]?.summary).toBeNull();
  });

  it("un servidor anterior (sin entries ni kind) se lee como una lista de productos", () => {
    const legacy = buildEditorDisplay({
      displayId: UUID(60), name: "TV", enabled: true, branchId: null, slideDurationSeconds: 8, tokenRotatedAt: "",
      slides: [{ slideId: UUID(61), productId: UUID(900), name: "Mayonesa", sku: "SKU1", unitType: "UNIT", available: true, unavailableReason: null, listPriceCents: "203500", bulkMinimumUnits: 3, bulkDiscountBps: 1500, weightTiers: [] }]
    });
    expect(legacy?.entries).toHaveLength(1);
    expect(legacy?.entries[0]).toMatchObject({ kind: "PRODUCT", id: UUID(900), name: "Mayonesa", summary: "$ 1.729,75 · llevando 3 unidades" });
  });
});
