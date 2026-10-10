import { applyWeightDiscount, calculateBranchPromotionLinePricing, formatCurrency, priceForWeight } from "@carnicerias/business-logic";

import { buildArtworkBranding, emptyArtworkBranding, parseArtworkBrandingFacts, type ArtworkBranding } from "./artwork-branding";

/**
 * Cartelería digital (D-072): de los HECHOS que entrega la base (`get_signage_display` / `get_signage_display_admin`) a lo que se
 * dibuja en el televisor. Puro: decide QUÉ texto lleva cada oferta; el dibujo vive en `components/artwork/tv-offer.tsx` (la misma identidad que las piezas).
 *
 * No hay fórmula de descuento propia: el precio «llevando N unidades» sale del mismo motor que usa el POS y la etiqueta de góndola
 * (`calculateBranchPromotionLinePricing`) y el de los tramos de peso de `applyWeightDiscount`. Una PROMOCIÓN cargada en Promociones (D-084)
 * llega como hecho (`promotion`): la de umbral por kg usa ese mismo `applyWeightDiscount` y el pack a precio total muestra su precio fijo
 * contra el precio normal de esa cantidad (nunca un precio calculado a mano). El precio de lista y la regla de la
 * sucursal ya vienen resueltos por la base con la precedencia del POS (precio de sucursal > global).
 */

/** Los tres tipos de oferta que resuelve la plantilla. `BULK`/`WEIGHT_PROMO` tienen promoción; los otros dos sólo precio. */
export type OfferVariant = "BULK" | "REGULAR" | "WEIGHT" | "WEIGHT_PROMO" | "PACK";

export interface OfferPrice {
  /** Parte entera ya con separador de miles ("1.729"). */
  whole: string;
  /** Centavos ("75") sólo si no son cero; null = precio redondo. */
  cents: string | null;
}

/** Una oferta lista para dibujar. Todo texto ya está formateado: el componente visual no calcula nada. */
export interface OfferSlideData {
  /** Clave estable (id del slide) para React. */
  key: string;
  variant: OfferVariant;
  name: string;
  price: OfferPrice;
  /** Sufijo pequeño pegado al precio ("/ KG"). */
  priceSuffix: string | null;
  /** Condición bajo el precio ("LLEVANDO 3 UNIDADES", "PRECIO UNITARIO", "DESDE 2 KG"). */
  condition: string;
  /** Línea secundaria ("Precio unitario $ 2.035"); null = no se muestra. */
  secondary: string | null;
  /** true cuando hay una promoción real: la plantilla la resalta. */
  promo: boolean;
  /** Por kilo o por unidad (la pieza imprime «X KG» sólo en los de peso). */
  unitType: "UNIT" | "WEIGHT";
  /** Precio de lista vigente (el «precio normal» que se muestra junto a una promoción). */
  regularPrice: OfferPrice;
  /** Foto comercial del producto como URL que el televisor puede pedir; null = sin foto (la pieza dibuja su reemplazo). */
  imageUrl: string | null;
}

export type SignageStatus = "ACTIVE" | "DISABLED";

/** Lo que consume el reproductor (serializable: viaja del servidor al navegador del televisor). */
export interface SignageView {
  status: SignageStatus;
  slideDurationSeconds: number;
  organizationName: string;
  /** Identidad de las piezas (franja verde + logo de la organización). Sin contacto: el televisor no lo muestra. */
  branding: ArtworkBranding;
  slides: OfferSlideData[];
}

export const MIN_SLIDE_SECONDS = 3;
export const MAX_SLIDE_SECONDS = 60;
export const DEFAULT_SLIDE_SECONDS = 8;
export const MAX_SIGNAGE_SLIDES = 50;

export function clampSlideSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SLIDE_SECONDS;
  return Math.min(MAX_SLIDE_SECONDS, Math.max(MIN_SLIDE_SECONDS, Math.round(value)));
}

/** "$ 1.729,75" → { whole: "1.729", cents: "75" }; "$ 2.450" → { whole: "2.450", cents: null }. Usa el mismo `formatCurrency` que el resto del sistema. */
export function splitPrice(cents: bigint): OfferPrice {
  const text = formatCurrency(cents).replace(/^\$\s*/, "");
  const comma = text.lastIndexOf(",");
  if (comma < 0) return { whole: text, cents: null };
  return { whole: text.slice(0, comma), cents: text.slice(comma + 1) };
}

/** "$ 2.035" con el formato del sistema (para las líneas secundarias). */
function money(cents: bigint): string {
  return formatCurrency(cents);
}

const KG_FORMAT = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });

/** 2000 → "2 KG", 500 → "0,5 KG", 2500 → "2,5 KG". */
export function formatMinimumWeight(grams: number): string {
  return `${KG_FORMAT.format(grams / 1_000)} KG`;
}

export interface WeightTierFact {
  id: string;
  minimumGrams: number;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG";
  discountValue: bigint;
}

/** La promoción cargada en Promociones que dibuja un slide de tipo PROMOCIÓN (hechos puros: precio y cantidad exactos de la base). */
export interface PromotionFact {
  promotionId: string;
  mode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  status: "ACTIVE" | "UPCOMING" | "EXPIRED" | null;
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: bigint | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: bigint | null;
}

/** Hechos de un slide tal como los entrega la base (el precio viaja como texto: bigint seguro). */
export interface SlideFacts {
  key: string;
  name: string;
  unitType: "UNIT" | "WEIGHT";
  listPriceCents: bigint;
  bulkMinimumUnits: number | null;
  bulkDiscountBps: number | null;
  weightTiers: WeightTierFact[];
  /** Sólo en un slide de tipo PROMOCIÓN (una promoción directa o la de un grupo); null en un slide de producto. */
  promotion?: PromotionFact | null;
}

function finish(facts: SlideFacts, data: Omit<OfferSlideData, "key" | "name" | "unitType" | "regularPrice" | "imageUrl"> & { regularPriceOverride?: OfferPrice }): OfferSlideData {
  const { regularPriceOverride, ...rest } = data;
  return { ...rest, key: facts.key, name: facts.name.trim(), unitType: facts.unitType, regularPrice: regularPriceOverride ?? splitPrice(facts.listPriceCents), imageUrl: null };
}

/**
 * Una diapositiva de PROMOCIÓN (D-084): lo que la promoción vigente ofrece hoy, calculado con el motor. Umbral por kg → «DESDE 2 KG» con el
 * precio por kilo resultante; pack a precio total → el total fijo «POR 2 KG» / «POR 40 UNIDADES» contra el precio normal de esa cantidad. Si la
 * promoción no baja el precio (valores inválidos o un pack más caro que comprar suelto) NO se anuncia como promoción: se muestra el precio normal.
 */
function buildPromotionSlide(facts: SlideFacts, promotion: PromotionFact): OfferSlideData | null {
  const list = facts.listPriceCents;
  if (promotion.mode === "THRESHOLD" && facts.unitType === "WEIGHT" && promotion.minimumGrams !== null && promotion.minimumGrams > 0
      && promotion.discountType !== null && promotion.discountValue !== null && promotion.discountValue > 0n) {
    try {
      const applied = applyWeightDiscount(list, promotion.minimumGrams, [{
        id: promotion.promotionId, minimumGrams: promotion.minimumGrams, discountType: promotion.discountType, discountValue: promotion.discountValue
      }]);
      if (applied.ruleId !== null && applied.finalPricePerKgCents > 0n && applied.finalPricePerKgCents < list) {
        return finish(facts, {
          variant: "WEIGHT_PROMO", price: splitPrice(applied.finalPricePerKgCents), priceSuffix: "/ KG",
          condition: `DESDE ${formatMinimumWeight(promotion.minimumGrams)}`, secondary: `Precio normal ${money(list)} / KG`, promo: true
        });
      }
    } catch {
      // regla inválida: se cae al precio normal
    }
  }
  if (promotion.mode === "PACK_FIXED_TOTAL" && promotion.packPriceCents !== null && promotion.packPriceCents > 0n) {
    const grams = facts.unitType === "WEIGHT" ? promotion.packQuantityGrams : null;
    const units = facts.unitType === "UNIT" ? promotion.packQuantityUnits : null;
    if ((grams !== null && grams > 0) || (units !== null && units > 0)) {
      const normalTotal = grams !== null ? priceForWeight(list, grams) : list * BigInt(units ?? 0);
      if (promotion.packPriceCents < normalTotal) {
        const quantity = grams !== null ? formatMinimumWeight(grams) : units === 1 ? "1 UNIDAD" : `${String(units)} UNIDADES`;
        return finish(facts, {
          variant: "PACK", price: splitPrice(promotion.packPriceCents), priceSuffix: null,
          condition: `POR ${quantity}`, secondary: `Precio normal ${money(normalTotal)}`, promo: true,
          // El «precio normal» que se muestra junto al total del pack es el de ESA cantidad, no el precio por kilo o por unidad.
          regularPriceOverride: splitPrice(normalTotal)
        });
      }
    }
  }
  return finishRegular(facts);
}

/** El precio normal del producto, sin promoción (WEIGHT por kilo o UNIT por unidad). */
function finishRegular(facts: SlideFacts): OfferSlideData {
  return facts.unitType === "WEIGHT"
    ? finish(facts, { variant: "WEIGHT", price: splitPrice(facts.listPriceCents), priceSuffix: "/ KG", condition: "PRECIO POR KILO", secondary: null, promo: false })
    : finish(facts, { variant: "REGULAR", price: splitPrice(facts.listPriceCents), priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false });
}

/** Una oferta por producto (o por promoción). `null` = no se puede mostrar (sin precio válido): el reproductor lo saltea. */
export function buildOfferSlide(facts: SlideFacts): OfferSlideData | null {
  if (facts.listPriceCents <= 0n) return null;
  const list = facts.listPriceCents;
  if (facts.promotion) return buildPromotionSlide(facts, facts.promotion);

  if (facts.unitType === "WEIGHT") {
    // Sólo el primer tramo por cantidad (el de menor peso): es el que anuncia «desde X kg». Si el motor no lo puede resolver
    // limpiamente (valor inválido o no es un descuento) se muestra el precio de lista, que siempre es correcto.
    const tier = [...facts.weightTiers].sort((a, b) => a.minimumGrams - b.minimumGrams)[0];
    if (tier) {
      try {
        const applied = applyWeightDiscount(list, tier.minimumGrams, facts.weightTiers.map((rule) => ({
          id: rule.id, minimumGrams: rule.minimumGrams, discountType: rule.discountType, discountValue: rule.discountValue
        })));
        if (applied.ruleId !== null && applied.finalPricePerKgCents > 0n && applied.finalPricePerKgCents < list) {
          return finish(facts, {
            variant: "WEIGHT_PROMO", price: splitPrice(applied.finalPricePerKgCents), priceSuffix: "/ KG",
            condition: `DESDE ${formatMinimumWeight(tier.minimumGrams)}`, secondary: `Precio normal ${money(list)} / KG`, promo: true
          });
        }
      } catch {
        // regla inválida: se cae al precio de lista
      }
    }
    return finish(facts, { variant: "WEIGHT", price: splitPrice(list), priceSuffix: "/ KG", condition: "PRECIO POR KILO", secondary: null, promo: false });
  }

  const minimum = facts.bulkMinimumUnits;
  const bps = facts.bulkDiscountBps;
  if (minimum !== null && bps !== null && bps > 0) {
    try {
      const bulk = calculateBranchPromotionLinePricing({
        listPriceCents: list, quantityUnits: minimum, paymentMethod: "CASH", cashDiscountBps: 0n,
        promotion: { id: "signage-bulk", minimumUnits: minimum, discountBps: bps }
      });
      if (bulk && bulk.cashPriceCents > 0n && bulk.cashPriceCents < list) {
        return finish(facts, {
          variant: "BULK", price: splitPrice(bulk.cashPriceCents), priceSuffix: null,
          condition: `LLEVANDO ${String(minimum)} UNIDADES`, secondary: `Precio unitario ${money(list)}`, promo: true
        });
      }
    } catch {
      // regla inválida: se cae al precio unitario
    }
  }
  return finish(facts, { variant: "REGULAR", price: splitPrice(list), priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false });
}

// ---------------------------------------------------------------------------------------------------------------------
// Lectura defensiva del JSON de la base (nunca se confía en su forma: un campo raro descarta ese slide, no rompe la pantalla)
// ---------------------------------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d{1,18}$/.test(value)) return BigInt(value);
  return null;
}

export function parseSlideFacts(raw: unknown): SlideFacts | null {
  if (!isRecord(raw)) return null;
  const key = asString(raw.slideId);
  const name = asString(raw.name);
  const unitType = raw.unitType;
  const listPriceCents = asBigInt(raw.listPriceCents);
  if (!key || !name?.trim() || (unitType !== "UNIT" && unitType !== "WEIGHT") || listPriceCents === null) return null;
  const tiers: WeightTierFact[] = [];
  if (Array.isArray(raw.weightTiers)) {
    for (const tier of raw.weightTiers as unknown[]) {
      if (!isRecord(tier)) continue;
      const id = asString(tier.id);
      const minimumGrams = asInteger(tier.minimumGrams);
      const discountType = tier.discountType;
      const discountValue = asBigInt(tier.discountValue);
      if (!id || minimumGrams === null || minimumGrams <= 0 || discountValue === null || discountValue <= 0n) continue;
      if (discountType !== "PERCENTAGE" && discountType !== "FIXED_PRICE_PER_KG") continue;
      tiers.push({ id, minimumGrams, discountType, discountValue });
    }
  }
  return {
    key, name, unitType, listPriceCents,
    bulkMinimumUnits: asInteger(raw.bulkMinimumUnits), bulkDiscountBps: asInteger(raw.bulkDiscountBps),
    weightTiers: tiers,
    promotion: parsePromotionFact(raw.promotion)
  };
}

/** El hecho de una promoción (`promotion` del slide). Una forma inesperada se ignora: el slide queda como producto normal. */
export function parsePromotionFact(raw: unknown): PromotionFact | null {
  if (!isRecord(raw)) return null;
  const promotionId = asString(raw.promotionId);
  const mode = raw.mode;
  if (!promotionId || (mode !== "THRESHOLD" && mode !== "PACK_FIXED_TOTAL")) return null;
  const status = raw.status === "ACTIVE" || raw.status === "UPCOMING" || raw.status === "EXPIRED" ? raw.status : null;
  const discountType = raw.discountType === "PERCENTAGE" || raw.discountType === "FIXED_PRICE_PER_KG" ? raw.discountType : null;
  return {
    promotionId, mode, status, discountType,
    minimumGrams: asInteger(raw.minimumGrams), discountValue: asBigInt(raw.discountValue),
    packQuantityGrams: asInteger(raw.packQuantityGrams), packQuantityUnits: asInteger(raw.packQuantityUnits), packPriceCents: asBigInt(raw.packPriceCents)
  };
}

/** Referencia a un archivo de imagen de Storage (la foto de un producto o el logo). */
export interface MediaRef {
  storagePath: string;
  contentType: "image/jpeg" | "image/png";
}

/**
 * Cómo se llega a las imágenes desde el navegador de quien mira (el televisor o el Admin): las resuelve cada superficie (ruta
 * `/api/tv/<token>/media/<id>` en el televisor, la de la sesión en la vista previa). Sin resolvedor no hay imágenes.
 */
export interface SignageMedia {
  photoUrl: (slideKey: string, photo: MediaRef) => string | null;
  logoUrl: (logo: MediaRef) => string | null;
}

function parsePhotoRef(raw: unknown): MediaRef | null {
  if (!isRecord(raw)) return null;
  const storagePath = asString(raw.storagePath);
  const contentType = raw.contentType;
  if (!storagePath || (contentType !== "image/jpeg" && contentType !== "image/png")) return null;
  return { storagePath, contentType };
}

/** La referencia de la imagen `id` (id de una diapositiva, o `logo`) dentro del JSON de la base; null si no existe. Sólo sirve rutas de ESA presentación. */
export function findSignageMedia(payload: unknown, id: string): MediaRef | null {
  if (!isRecord(payload)) return null;
  if (id === "logo") {
    const facts = parseArtworkBrandingFacts({ organizationName: null, logo: payload.logo, branch: null });
    return facts?.logo ? { storagePath: facts.logo.storagePath, contentType: facts.logo.contentType } : null;
  }
  if (!Array.isArray(payload.slides)) return null;
  for (const raw of payload.slides as unknown[]) {
    if (isRecord(raw) && raw.slideId === id) return parsePhotoRef(raw.photo);
  }
  return null;
}

/** JSON de `get_signage_display` (o de la vista del Admin) → vista del reproductor. `null` si la base no devolvió una pantalla (token inexistente). */
export function buildSignageView(payload: unknown, media?: SignageMedia): SignageView | null {
  if (!isRecord(payload)) return null;
  const status: SignageStatus = payload.status === "ACTIVE" ? "ACTIVE" : "DISABLED";
  const duration = asInteger(payload.slideDurationSeconds);
  const slides: OfferSlideData[] = [];
  if (status === "ACTIVE" && Array.isArray(payload.slides)) {
    for (const raw of payload.slides as unknown[]) {
      // La vista del Admin trae también los slides que el TV no puede mostrar (`available: false`): la vista previa los saltea igual que el TV.
      if (isRecord(raw) && raw.available === false) continue;
      const facts = parseSlideFacts(raw);
      const offer = facts ? buildOfferSlide(facts) : null;
      if (!offer) continue;
      const photo = isRecord(raw) ? parsePhotoRef(raw.photo) : null;
      slides.push({ ...offer, imageUrl: photo && media ? media.photoUrl(offer.key, photo) : null });
    }
  }
  const brandingFacts = parseArtworkBrandingFacts({ organizationName: payload.organizationName, logo: payload.logo, branch: null });
  const branding = brandingFacts ? buildArtworkBranding(brandingFacts, brandingFacts.logo && media ? media.logoUrl(brandingFacts.logo) : null) : emptyArtworkBranding();
  return {
    status,
    slideDurationSeconds: duration === null ? DEFAULT_SLIDE_SECONDS : clampSlideSeconds(duration),
    organizationName: asString(payload.organizationName)?.trim() ?? "",
    branding,
    slides
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Editor del Admin
// ---------------------------------------------------------------------------------------------------------------------

export type SlideUnavailableReason = "INACTIVE" | "NOT_IN_BRANCH" | "NO_PRICE";

export const UNAVAILABLE_LABELS: Record<SlideUnavailableReason, string> = {
  INACTIVE: "Producto inactivo o no vendible: no se muestra en el TV",
  NOT_IN_BRANCH: "No se vende en la sucursal elegida: no se muestra en el TV",
  NO_PRICE: "Sin precio vigente: no se muestra en el TV"
};

/** Motivos del editor: los de un producto más los de una promoción que no está vigente (D-084). */
export type EditorUnavailableReason = SlideUnavailableReason | "PROMO_EXPIRED" | "PROMO_UPCOMING";

export const EDITOR_UNAVAILABLE_LABELS: Record<EditorUnavailableReason, string> = {
  ...UNAVAILABLE_LABELS,
  NOT_IN_BRANCH: "No aplica a la sucursal de esta pantalla: no se muestra en el TV",
  PROMO_EXPIRED: "La promoción venció o está desactivada: el TV la saltea",
  PROMO_UPCOMING: "La promoción todavía no empezó: el TV la saltea hasta esa fecha"
};

export type EntryKind = "PRODUCT" | "PROMOTION" | "GROUP";

/** Una promoción dentro de un grupo, tal como la reproduciría hoy ESTA pantalla (con el motivo si se saltea). */
export interface EditorChild {
  promotionId: string;
  name: string;
  summary: string | null;
  unavailable: EditorUnavailableReason | null;
  /** El producto tiene foto comercial; sin foto la TV dibuja un reemplazo y el editor avisa «Sin foto». */
  hasPhoto: boolean;
}

/**
 * Una entrada de la lista de la pantalla (D-084): un producto, una promoción ya cargada en Promociones o un grupo de promociones. La pantalla
 * guarda sólo el origen (id); el precio, el nombre y la foto se resuelven en cada lectura.
 */
export interface EditorEntry {
  kind: EntryKind;
  /** productId, promotionId o groupId, según `kind`. */
  id: string;
  name: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT" | null;
  /** Resumen de la oferta que verá el TV ("$ 1.729,75 · llevando 3 unidades"); null = entrada recién agregada (se calcula al publicar). */
  summary: string | null;
  unavailable: EditorUnavailableReason | null;
  hasPhoto: boolean;
  /** Sólo en un GRUPO: sus promociones en el orden del grupo. */
  children: EditorChild[];
}

export interface EditorDisplay {
  id: string;
  name: string;
  enabled: boolean;
  branchId: string | null;
  slideDurationSeconds: number;
  tokenRotatedAt: string;
  entries: EditorEntry[];
}

function isReason(value: unknown): value is EditorUnavailableReason {
  return value === "INACTIVE" || value === "NOT_IN_BRANCH" || value === "NO_PRICE" || value === "PROMO_EXPIRED" || value === "PROMO_UPCOMING";
}

/** Texto de una oferta para listas del Admin: "$ 1.729,75 · llevando 3 unidades". */
export function summarizeOffer(offer: OfferSlideData): string {
  const price = `$ ${offer.price.whole}${offer.price.cents ? `,${offer.price.cents}` : ""}${offer.priceSuffix ? ` ${offer.priceSuffix.toLowerCase()}` : ""}`;
  return offer.promo ? `${price} · ${offer.condition.toLowerCase()}` : price;
}

function summaryOf(raw: JsonRecord, unavailable: EditorUnavailableReason | null): string | null {
  if (unavailable) return null;
  const facts = parseSlideFacts(raw);
  const offer = facts ? buildOfferSlide(facts) : null;
  return offer ? summarizeOffer(offer) : null;
}

/** JSON de `get_signage_display_admin` → pantalla del editor (entradas con su estado actual y, en los grupos, sus promociones). */
export function buildEditorDisplay(payload: unknown): EditorDisplay | null {
  if (!isRecord(payload)) return null;
  const id = asString(payload.displayId);
  const name = asString(payload.name);
  if (!id || name === null) return null;
  const slides = Array.isArray(payload.slides) ? (payload.slides as unknown[]).filter(isRecord) : [];
  // Cada diapositiva pertenece a la entrada que la originó (un grupo origina varias); un servidor anterior no manda entryId: cada una es su propio producto.
  const byEntry = new Map<string, JsonRecord[]>();
  for (const slide of slides) {
    const entryId = asString(slide.entryId) ?? asString(slide.slideId);
    if (entryId) byEntry.set(entryId, [...(byEntry.get(entryId) ?? []), slide]);
  }
  const rawEntries: JsonRecord[] = Array.isArray(payload.entries)
    ? (payload.entries as unknown[]).filter(isRecord)
    : slides.map((slide) => ({ entryId: asString(slide.slideId), kind: "PRODUCT", productId: slide.productId }));
  const entries: EditorEntry[] = [];
  for (const entry of rawEntries) {
    const entryId = asString(entry.entryId);
    const kind = entry.kind === "PROMOTION" || entry.kind === "GROUP" ? entry.kind : "PRODUCT";
    if (!entryId) continue;
    const own = byEntry.get(entryId) ?? [];
    if (kind === "GROUP") {
      const groupId = asString(entry.groupId);
      if (!groupId) continue;
      const children: EditorChild[] = [];
      for (const slide of own) {
        const promotionId = asString(slide.slideId);
        const childName = asString(slide.name);
        if (!promotionId || !childName) continue;
        const unavailable = isReason(slide.unavailableReason) ? slide.unavailableReason : null;
        children.push({ promotionId, name: childName, summary: summaryOf(slide, unavailable), unavailable, hasPhoto: parsePhotoRef(slide.photo) !== null });
      }
      const groupName = asString(entry.groupName) ?? "Grupo";
      entries.push({ kind, id: groupId, name: groupName, sku: null, unitType: null, summary: null, unavailable: null, hasPhoto: true, children });
      continue;
    }
    const slide = own[0];
    if (!slide) continue;
    const refId = kind === "PROMOTION" ? asString(entry.promotionId) : asString(entry.productId);
    const slideName = asString(slide.name);
    const unitType = slide.unitType;
    if (!refId || !slideName || (unitType !== "UNIT" && unitType !== "WEIGHT")) continue;
    const unavailable = isReason(slide.unavailableReason) ? slide.unavailableReason : null;
    entries.push({
      kind, id: refId, name: slideName, sku: asString(slide.sku), unitType, summary: summaryOf(slide, unavailable), unavailable,
      hasPhoto: parsePhotoRef(slide.photo) !== null, children: []
    });
  }
  return {
    id, name,
    enabled: payload.enabled === true,
    branchId: asString(payload.branchId),
    slideDurationSeconds: clampSlideSeconds(asInteger(payload.slideDurationSeconds) ?? DEFAULT_SLIDE_SECONDS),
    tokenRotatedAt: asString(payload.tokenRotatedAt) ?? "",
    entries
  };
}

/** Mueve el elemento `index` una posición (−1 sube, +1 baja). Devuelve una copia; fuera de rango = sin cambios. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const copy = [...items];
  if (index < 0 || index >= copy.length || target < 0 || target >= copy.length) return copy;
  const moved = copy[index] as T;
  copy[index] = copy[target] as T;
  copy[target] = moved;
  return copy;
}

/** Ruta pública del televisor. */
export function tvPath(token: string): string {
  return `/tv/${token}`;
}

/** Formato exacto del token que emite la base (32 bytes en hex minúscula). */
export function isWellFormedToken(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}
