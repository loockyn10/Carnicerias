import { formatCurrency } from "@carnicerias/business-logic";

import { emptyArtworkBranding, type ArtworkBranding } from "./artwork-branding";
import { sanitizeGlyphs } from "./artwork-text";
import { COLLAGE_MAX_ITEMS, COLLAGE_MIN_ITEMS, DEFAULT_COLLAGE_HEADLINE, DEFAULT_HEADLINE, MAX_HEADLINE_LENGTH, type ArtworkTemplate } from "./artwork-tokens";
import { buildOfferSlide, parseSlideFacts, type OfferPrice, type OfferSlideData, type SignageView, type SlideUnavailableReason } from "./signage";

/**
 * Piezas de cartelería (D-074 «Producto protagonista», D-075 «Collage»): de los HECHOS que entrega `get_product_artwork` al modelo
 * que dibujan los renderers (TV, Feed, Story). Puro, sin acceso a datos ni a React.
 *
 * No hay fórmula de descuento propia: el precio promocional sale de `buildOfferSlide` (cartelería de TV, D-072), que a su vez usa el
 * mismo motor que el POS y la etiqueta de góndola (`calculateBranchPromotionLinePricing` / `applyWeightDiscount`). Acá sólo se
 * decide QUÉ se muestra: con promoción, precio promocional + condición + precio normal; sin promoción, sólo el precio vigente.
 * Ningún precio se escribe a mano: cada ítem se resuelve contra la base para la sucursal elegida.
 */

export interface ArtworkBranch {
  name: string;
}

/** Un producto de la pieza (1 en el protagonista, 2 a 5 en el collage). */
export interface OfferItem {
  productId: string;
  productName: string;
  /** URL o data-URL de la foto comercial; null = el producto no tiene (la pieza dibuja un panel de reemplazo). */
  imageUrl: string | null;
  unitType: "UNIT" | "WEIGHT";
  /** Precio vigente de lista (el «precio normal»). */
  regularPrice: OfferPrice;
  /** Precio con la promoción vigente; null = no hay promoción (la pieza no inventa «llevando 3» ni descuentos). */
  promotionalPrice: OfferPrice | null;
  /** «LLEVANDO 3 UNIDADES» / «DESDE 2 KG»; null cuando no hay promoción. */
  promotionCondition: string | null;
  /** Sufijo del precio ("/ KG"); null para productos por unidad. */
  priceSuffix: string | null;
  /** Línea bajo el nombre para productos por peso ("X KG"); null por unidad. */
  unitLabel: string | null;
}

/** Especificación común de la pieza: todos los formatos la leen igual (misma semántica, mismos datos). */
export interface OfferArtworkModel {
  type: ArtworkTemplate;
  headline: string;
  branch: ArtworkBranch | null;
  /** Logo, colores y contacto de la sucursal (compartidos por todas las plantillas). */
  branding: ArtworkBranding;
  /** HERO: exactamente 1. COLLAGE: de 2 a 5, en el orden elegido. */
  items: OfferItem[];
}

/** El precio grande del ítem: el promocional si hay promoción; si no, el vigente. */
export function heroPrice(item: Pick<OfferItem, "promotionalPrice" | "regularPrice">): OfferPrice {
  return item.promotionalPrice ?? item.regularPrice;
}

export function hasPromotion(item: Pick<OfferItem, "promotionalPrice">): boolean {
  return item.promotionalPrice !== null;
}

/** Cantidad de productos de la pieza que no tienen foto comercial (la pieza usa un panel de reemplazo). */
export function countMissingPhotos(model: Pick<OfferArtworkModel, "items">): number {
  return model.items.filter((item) => item.imageUrl === null).length;
}

/** "17.900" + "50" → 1790050n (inverso exacto de `splitPrice`). */
export function priceToCents(price: OfferPrice): bigint {
  const whole = BigInt(price.whole.replace(/\D/g, "") || "0");
  const cents = price.cents === null ? 0n : BigInt(price.cents.padEnd(2, "0").slice(0, 2));
  return whole * 100n + cents;
}

/** Texto plano del precio ("$ 17.900,50") con el formato del sistema. */
export function formatPriceText(price: OfferPrice): string {
  return formatCurrency(priceToCents(price));
}

// ---------------------------------------------------------------------------------------------------------------------
// Titular
// ---------------------------------------------------------------------------------------------------------------------

const HEADLINE_ALLOWED = /[^A-ZÁÉÍÓÚÜÑ0-9 !¡?¿%$.,+-]/g;

/** Titular corto en mayúsculas, sólo letras/números/signos simples y a lo sumo 20 caracteres. Vacío => `fallback` («OFERTA»). */
export function normalizeHeadline(input: unknown, fallback: string = DEFAULT_HEADLINE): string {
  if (typeof input !== "string") return fallback;
  const cleaned = sanitizeGlyphs(input).toLocaleUpperCase("es-AR").replace(HEADLINE_ALLOWED, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.slice(0, MAX_HEADLINE_LENGTH).trim();
  return clipped || fallback;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hechos de la base → modelo
// ---------------------------------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export interface ArtworkPhotoRef {
  storagePath: string;
  contentType: "image/jpeg" | "image/png";
}

export type ArtworkUnavailableReason = SlideUnavailableReason;

/** Lo que se entiende de la respuesta de `get_product_artwork`. */
export interface ArtworkFacts {
  productId: string;
  /** Nombre tal como lo devuelve la base (sirve para avisar «X no se puede incluir» aunque el producto no esté disponible). */
  productName: string | null;
  /** Hechos de precio/promoción para el motor (mismo formato que la cartelería de TV). */
  available: boolean;
  unavailableReason: ArtworkUnavailableReason | null;
  /** El producto de la pieza sin imagen (la imagen depende de quien dibuja); null si no está disponible. */
  item: Omit<OfferItem, "imageUrl"> | null;
  branch: ArtworkBranch | null;
  photo: ArtworkPhotoRef | null;
  branchId: string | null;
}

function parsePhoto(raw: unknown): ArtworkPhotoRef | null {
  if (!isRecord(raw)) return null;
  const storagePath = asString(raw.storagePath);
  const contentType = raw.contentType;
  if (!storagePath || (contentType !== "image/jpeg" && contentType !== "image/png")) return null;
  return { storagePath, contentType };
}

function isReason(value: unknown): value is ArtworkUnavailableReason {
  return value === "INACTIVE" || value === "NOT_IN_BRANCH" || value === "NO_PRICE";
}

export const ARTWORK_UNAVAILABLE_LABELS: Record<ArtworkUnavailableReason, string> = {
  INACTIVE: "El producto está inactivo o no es de venta: no se puede generar la pieza.",
  NOT_IN_BRANCH: "El producto no se vende en esa sucursal: elegí otra sucursal.",
  NO_PRICE: "El producto no tiene precio vigente: cargale un precio antes de generar la pieza."
};

/**
 * JSON de `get_product_artwork` → hechos + ítem base (sin imagen, que depende de quien dibuja). `null` = respuesta que no se
 * entiende (producto inexistente o de otra organización).
 */
export function parseArtworkFacts(payload: unknown): ArtworkFacts | null {
  if (!isRecord(payload)) return null;
  const productId = asString(payload.productId);
  if (!productId) return null;
  const photo = parsePhoto(payload.photo);
  const branchId = asString(payload.branchId);
  const unavailableReason = isReason(payload.unavailableReason) ? payload.unavailableReason : null;
  const branchName = asString(payload.branchName);
  const branch: ArtworkBranch | null = branchName ? { name: branchName } : null;
  const productName = asString(payload.name);

  if (payload.available !== true || unavailableReason) {
    return { productId, productName, available: false, unavailableReason: unavailableReason ?? "NO_PRICE", item: null, branch, photo, branchId };
  }
  const facts = parseSlideFacts(payload);
  const offer = facts ? buildOfferSlide(facts) : null;
  if (!facts || !offer) return { productId, productName, available: false, unavailableReason: "NO_PRICE", item: null, branch, photo, branchId };

  return { productId, productName, available: true, unavailableReason: null, photo, branchId, branch, item: slideToItemBase(productId, offer) };
}

/**
 * Una oferta de cartelería (`buildOfferSlide`, el motor de pricing) → el ítem que dibujan las piezas. ES LA MISMA conversión para
 * el producto de una pieza y para cada diapositiva del televisor: sin promoción, sólo el precio vigente; con promoción, precio
 * promocional + condición + precio normal. No calcula nada.
 */
export function slideToItemBase(productId: string, offer: OfferSlideData): Omit<OfferItem, "imageUrl"> {
  return {
    productId,
    productName: sanitizeGlyphs(offer.name.toLocaleUpperCase("es-AR")),
    unitType: offer.unitType,
    regularPrice: offer.promo ? offer.regularPrice : offer.price,
    promotionalPrice: offer.promo ? offer.price : null,
    promotionCondition: offer.promo ? offer.condition : null,
    priceSuffix: offer.priceSuffix,
    unitLabel: offer.unitType === "WEIGHT" ? "X KG" : null
  };
}

export function slideToOfferItem(productId: string, offer: OfferSlideData, imageUrl: string | null): OfferItem {
  return { ...slideToItemBase(productId, offer), imageUrl };
}

/** La diapositiva del televisor como pieza «Producto protagonista»: el mismo modelo que Piezas (titular por defecto, sin contacto). */
export function slideToArtworkModel(view: Pick<SignageView, "branding">, offer: OfferSlideData): OfferArtworkModel {
  return {
    type: "HERO",
    headline: normalizeHeadline(null),
    branch: null,
    // El televisor no muestra el contacto de la sucursal (prioridad: marca, producto, foto y precio).
    branding: { ...view.branding, contact: null },
    items: [slideToOfferItem(offer.key, offer, offer.imageUrl)]
  };
}

interface BuildExtras {
  headline: unknown;
  branding?: ArtworkBranding;
}

/** Pieza «Producto protagonista»: un modelo, para cualquier formato. */
export function buildOfferArtworkModel(facts: ArtworkFacts, extras: BuildExtras & { imageUrl: string | null }): OfferArtworkModel | null {
  if (!facts.item) return null;
  return {
    type: "HERO",
    headline: normalizeHeadline(extras.headline),
    branch: facts.branch,
    branding: extras.branding ?? emptyArtworkBranding(),
    items: [{ ...facts.item, imageUrl: extras.imageUrl }]
  };
}

export interface CollageEntry {
  facts: ArtworkFacts;
  imageUrl: string | null;
}

export interface UnavailableItem {
  productId: string;
  productName: string;
  reason: ArtworkUnavailableReason;
}

export type CollageBuild =
  | { ok: true; model: OfferArtworkModel }
  | { ok: false; error: "COUNT"; message: string }
  | { ok: false; error: "UNAVAILABLE"; message: string; unavailable: UnavailableItem[] };

export const COLLAGE_COUNT_MESSAGE = `El collage lleva de ${String(COLLAGE_MIN_ITEMS)} a ${String(COLLAGE_MAX_ITEMS)} productos.`;

const REASON_SHORT: Record<ArtworkUnavailableReason, string> = {
  INACTIVE: "está inactivo o no es de venta",
  NOT_IN_BRANCH: "no se vende en esa sucursal",
  NO_PRICE: "no tiene precio vigente"
};

/** Mensaje para el usuario cuando algún producto del collage no se puede mostrar (nunca sale una pieza a medias ni a $0). */
export function describeUnavailable(items: UnavailableItem[]): string {
  const parts = items.map((item) => `«${item.productName}» ${REASON_SHORT[item.reason]}`);
  return `No se puede armar el collage: ${parts.join("; ")}. Quitalo o corregilo e intentá de nuevo.`;
}

/** Pieza «Collage»: de 2 a 5 productos EN EL ORDEN dado. Un producto no disponible impide armarla (no se omite en silencio). */
export function buildCollageArtworkModel(entries: readonly CollageEntry[], extras: BuildExtras): CollageBuild {
  if (entries.length < COLLAGE_MIN_ITEMS || entries.length > COLLAGE_MAX_ITEMS) return { ok: false, error: "COUNT", message: COLLAGE_COUNT_MESSAGE };
  const unavailable: UnavailableItem[] = [];
  const items: OfferItem[] = [];
  for (const entry of entries) {
    if (!entry.facts.item) {
      unavailable.push({
        productId: entry.facts.productId,
        productName: entry.facts.productName ?? "Producto",
        reason: entry.facts.unavailableReason ?? "NO_PRICE"
      });
      continue;
    }
    items.push({ ...entry.facts.item, imageUrl: entry.imageUrl });
  }
  if (unavailable.length) return { ok: false, error: "UNAVAILABLE", message: describeUnavailable(unavailable), unavailable };
  const branch = entries.find((entry) => entry.facts.branch)?.facts.branch ?? null;
  return {
    ok: true,
    model: {
      type: "COLLAGE",
      headline: normalizeHeadline(extras.headline, DEFAULT_COLLAGE_HEADLINE),
      branch,
      branding: extras.branding ?? emptyArtworkBranding(),
      items
    }
  };
}

function slug(text: string, max: number): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

/** Nombre de archivo del PNG: «super-ofertas-feed-nalga-vacuna.png» / «super-ofertas-collage-feed-ofertas-de-pollo.png». */
export function artworkFilename(model: OfferArtworkModel, format: string): string {
  if (model.type === "COLLAGE") return `super-ofertas-collage-${format}-${slug(model.headline, 32) || "ofertas"}.png`;
  return `super-ofertas-${format}-${slug(model.items[0]?.productName ?? "", 48) || "producto"}.png`;
}
