import {
  applyWeightDiscount, calculateBranchPromotionLinePricing, calculateUnitPackLinePricing, formatBasisPointsPercent, formatCurrency, priceForWeight
} from "@carnicerias/business-logic";

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

/**
 * Los tipos de oferta que resuelve la plantilla. `BULK` (llevando N), `UNIT_PACK` (pack de producto), `WEIGHT_PROMO` (desde N kg) y `PACK`
 * (promoción de pack a precio total) tienen promoción; `REGULAR` y `WEIGHT` sólo precio.
 */
export type OfferVariant = "BULK" | "UNIT_PACK" | "REGULAR" | "WEIGHT" | "WEIGHT_PROMO" | "PACK";

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
  /**
   * La mecánica promocional dicha como la dice el comercio, en mayúsculas y corta ("LLEVANDO 3", "PACK 10 UNIDADES", "DESDE 2 KG",
   * "POR 2 KG"); es lo que las piezas destacan junto al precio. null = sin promoción (nunca se inventa una mecánica).
   */
  mechanic: string | null;
  /** «25% OFF» sólo cuando la regla vigente es un porcentaje real (pack, escalón, tramo); nunca se calcula a mano. null = no aplica. */
  savings: string | null;
  /** Fin de la vigencia de la promoción (ISO) para que el televisor deje de mostrarla aunque pierda conexión; null = sin fin. */
  validUntil: string | null;
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
  /** La foto tiene fondo transparente (PNG recortado): la pieza la aprovecha con una mancha detrás. false = con fondo propio o desconocido. */
  imageTransparent: boolean;
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
  /** La promoción está encendida (false = desactivada a mano; una vencida por fecha sigue en true). null = el dato no vino. */
  active: boolean | null;
  validFrom: string | null;
  validUntil: string | null;
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: bigint | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: bigint | null;
}

export interface BulkTierFact { minimumUnits: number; discountBps: number }

/** Hechos de un slide tal como los entrega la base (el precio viaja como texto: bigint seguro). */
export interface SlideFacts {
  key: string;
  name: string;
  unitType: "UNIT" | "WEIGHT";
  listPriceCents: bigint;
  bulkMinimumUnits: number | null;
  bulkDiscountBps: number | null;
  /** TODOS los escalones «llevando N» vigentes (menor a mayor). Ausente = sólo el escalón único de arriba. */
  bulkTiers?: BulkTierFact[];
  weightTiers: WeightTierFact[];
  /** Pack del producto (D-064; sólo UNIT): unidades por pack y su descuento propio en basis points. Ausente/null = sin pack. */
  packSizeUnits?: number | null;
  packDiscountBps?: number | null;
  /** Sólo en un slide de tipo PROMOCIÓN (una promoción directa o la de un grupo); null en un slide de producto. */
  promotion?: PromotionFact | null;
}

type FinishData = Omit<OfferSlideData, "key" | "name" | "unitType" | "regularPrice" | "imageUrl" | "imageTransparent" | "mechanic" | "savings" | "validUntil">
  & Partial<Pick<OfferSlideData, "mechanic" | "savings" | "validUntil">> & { regularPriceOverride?: OfferPrice };

function finish(facts: SlideFacts, data: FinishData): OfferSlideData {
  const { regularPriceOverride, mechanic, savings, validUntil, ...rest } = data;
  return {
    ...rest, mechanic: mechanic ?? null, savings: savings ?? null, validUntil: validUntil ?? facts.promotion?.validUntil ?? null,
    key: facts.key, name: facts.name.trim(), unitType: facts.unitType, regularPrice: regularPriceOverride ?? splitPrice(facts.listPriceCents), imageUrl: null, imageTransparent: false
  };
}

/** «10% OFF» de una regla por porcentaje (basis points reales de la promoción); null para un precio fijo por kilo. */
function percentSavings(discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null, discountValue: bigint | null): string | null {
  if (discountType !== "PERCENTAGE" || discountValue === null || discountValue <= 0n || discountValue >= 10_000n) return null;
  return `${formatBasisPointsPercent(Number(discountValue))}% OFF`;
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
          condition: `DESDE ${formatMinimumWeight(promotion.minimumGrams)}`, secondary: `Precio normal ${money(list)} / KG`, promo: true,
          mechanic: `DESDE ${formatMinimumWeight(promotion.minimumGrams)}`, savings: percentSavings(promotion.discountType, promotion.discountValue)
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
        // Por kilo se dice «POR 2 KG»; por unidades, «PACK 6 UNIDADES» (el pack se anuncia como pack).
        const mechanic = grams !== null ? `POR ${quantity}` : `PACK ${quantity}`;
        return finish(facts, {
          variant: "PACK", price: splitPrice(promotion.packPriceCents), priceSuffix: null,
          condition: mechanic, mechanic, secondary: `Precio normal ${money(normalTotal)}`, promo: true,
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
            condition: `DESDE ${formatMinimumWeight(tier.minimumGrams)}`, secondary: `Precio normal ${money(list)} / KG`, promo: true,
            mechanic: `DESDE ${formatMinimumWeight(tier.minimumGrams)}`, savings: percentSavings(tier.discountType, tier.discountValue)
          });
        }
      } catch {
        // regla inválida: se cae al precio de lista
      }
    }
    return finish(facts, { variant: "WEIGHT", price: splitPrice(list), priceSuffix: "/ KG", condition: "PRECIO POR KILO", secondary: null, promo: false });
  }

  const bulk = bulkOffer(facts);
  const pack = unitPackOffer(facts);
  // Un producto con las dos mecánicas anuncia la que deja el MENOR precio por unidad (empate: «llevando N»).
  const best = bulk && pack ? (pack.perUnit < bulk.perUnit ? pack : bulk) : bulk ?? pack;
  if (best) return best.offer;
  return finish(facts, { variant: "REGULAR", price: splitPrice(list), priceSuffix: null, condition: "PRECIO UNITARIO", secondary: null, promo: false });
}

interface UnitOffer { offer: OfferSlideData; perUnit: bigint }

/** «Llevando N»: de todos los escalones vigentes se anuncia el que deja el MENOR precio por unidad (3u 15 % y 5u 20 % → «llevando 5»). */
function bulkOffer(facts: SlideFacts): UnitOffer | null {
  const tiers = facts.bulkTiers ?? (facts.bulkMinimumUnits !== null && facts.bulkDiscountBps !== null ? [{ minimumUnits: facts.bulkMinimumUnits, discountBps: facts.bulkDiscountBps }] : []);
  let best: UnitOffer | null = null;
  for (const tier of tiers) {
    const offer = bulkTierOffer(facts, tier.minimumUnits, tier.discountBps);
    if (offer && (!best || offer.perUnit < best.perUnit)) best = offer;
  }
  return best;
}

function bulkTierOffer(facts: SlideFacts, minimum: number, bps: number): UnitOffer | null {
  if (bps <= 0) return null;
  const list = facts.listPriceCents;
  try {
    const bulk = calculateBranchPromotionLinePricing({
      listPriceCents: list, quantityUnits: minimum, paymentMethod: "CASH", cashDiscountBps: 0n,
      promotion: { id: "signage-bulk", minimumUnits: minimum, discountBps: bps }
    });
    if (bulk && bulk.cashPriceCents > 0n && bulk.cashPriceCents < list) {
      return {
        perUnit: bulk.cashPriceCents,
        offer: finish(facts, {
          variant: "BULK", price: splitPrice(bulk.cashPriceCents), priceSuffix: "C/U",
          condition: `LLEVANDO ${String(minimum)} UNIDADES`, secondary: `Precio unitario ${money(list)}`, promo: true,
          mechanic: `LLEVANDO ${String(minimum)}`, savings: `${formatBasisPointsPercent(bps)}% OFF`
        })
      };
    }
  } catch {
    // regla inválida: se cae al precio unitario
  }
  return null;
}

/** Pack del producto (D-064): N unidades con el descuento propio del pack; el precio por unidad sale del motor del POS. */
function unitPackOffer(facts: SlideFacts): UnitOffer | null {
  const size = facts.packSizeUnits ?? null;
  const bps = facts.packDiscountBps ?? null;
  if (size === null || bps === null || bps <= 0 || !Number.isSafeInteger(size) || size < 2) return null;
  const list = facts.listPriceCents;
  try {
    const pricing = calculateUnitPackLinePricing({
      listPriceCents: list, pack: { packCount: 1, packSizeUnits: size, packDiscountBps: bps }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    if (pricing.cashPriceCents > 0n && pricing.cashPriceCents < list) {
      const mechanic = `PACK ${String(size)} UNIDADES`;
      return {
        perUnit: pricing.cashPriceCents,
        offer: finish(facts, {
          variant: "UNIT_PACK", price: splitPrice(pricing.cashPriceCents), priceSuffix: "C/U",
          condition: mechanic, secondary: `Precio unitario ${money(list)}`, promo: true, mechanic, savings: `${formatBasisPointsPercent(bps)}% OFF`
        })
      };
    }
  } catch {
    // pack inválido: se cae al precio unitario
  }
  return null;
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
    ...(Array.isArray(raw.bulkTiers) ? { bulkTiers: parseBulkTiers(raw.bulkTiers as unknown[]) } : {}),
    packSizeUnits: asInteger(raw.packSizeUnits), packDiscountBps: asInteger(raw.packDiscountBps),
    weightTiers: tiers,
    promotion: parsePromotionFact(raw.promotion)
  };
}

function parseBulkTiers(raw: unknown[]): BulkTierFact[] {
  const tiers: BulkTierFact[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const minimumUnits = asInteger(item.minimumUnits);
    const discountBps = asInteger(item.discountBps);
    if (minimumUnits !== null && minimumUnits >= 2 && discountBps !== null && discountBps > 0) tiers.push({ minimumUnits, discountBps });
  }
  return tiers;
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
    promotionId, mode, status, discountType, active: typeof raw.active === "boolean" ? raw.active : null,
    validFrom: asString(raw.validFrom), validUntil: asString(raw.validUntil),
    minimumGrams: asInteger(raw.minimumGrams), discountValue: asBigInt(raw.discountValue),
    packQuantityGrams: asInteger(raw.packQuantityGrams), packQuantityUnits: asInteger(raw.packQuantityUnits), packPriceCents: asBigInt(raw.packPriceCents)
  };
}

/** Referencia a un archivo de imagen de Storage (la foto de un producto o el logo). */
export interface MediaRef {
  storagePath: string;
  contentType: "image/jpeg" | "image/png";
  /** PNG con fondo transparente (true), con fondo propio (false) o todavía sin analizar (null). */
  hasAlpha?: boolean | null;
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
  return { storagePath, contentType, ...(typeof raw.hasAlpha === "boolean" ? { hasAlpha: raw.hasAlpha } : {}) };
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
      slides.push({ ...offer, imageUrl: photo && media ? media.photoUrl(offer.key, photo) : null, imageTransparent: photo?.hasAlpha === true });
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

/** Texto de una oferta para listas del Admin: "$ 1.729,75 · llevando 3 unidades". */
export function summarizeOffer(offer: OfferSlideData): string {
  const price = `$ ${offer.price.whole}${offer.price.cents ? `,${offer.price.cents}` : ""}${offer.priceSuffix ? ` ${offer.priceSuffix.toLowerCase()}` : ""}`;
  return offer.promo ? `${price} · ${offer.condition.toLowerCase()}` : price;
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
