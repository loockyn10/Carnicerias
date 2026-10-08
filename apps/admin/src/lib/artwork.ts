import { formatCurrency } from "@carnicerias/business-logic";

import { sanitizeGlyphs } from "./artwork-text";
import { BRAND_NAME, DEFAULT_HEADLINE, MAX_HEADLINE_LENGTH } from "./artwork-tokens";
import { buildOfferSlide, parseSlideFacts, splitPrice, type OfferPrice, type SlideUnavailableReason } from "./signage";

/**
 * Pieza «Producto protagonista» (D-074): de los HECHOS que entrega `get_product_artwork` al modelo que dibujan los tres renderers
 * (TV, Feed, Story). Puro, sin acceso a datos ni a React.
 *
 * No hay fórmula de descuento propia: el precio promocional sale de `buildOfferSlide` (cartelería de TV, D-072), que a su vez usa el
 * mismo motor que el POS y la etiqueta de góndola (`calculateBranchPromotionLinePricing` / `applyWeightDiscount`). Acá sólo se
 * decide QUÉ se muestra: con promoción, precio promocional + condición + precio normal; sin promoción, sólo el precio vigente.
 */

export interface ArtworkBranch {
  name: string;
  /** Dirección de la sucursal si está cargada (nunca se inventa ni se copia de una imagen de referencia). */
  address: string | null;
}

/** Especificación común de la pieza: los tres formatos la leen igual (misma semántica, mismos datos). */
export interface OfferArtworkModel {
  businessName: string;
  headline: string;
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
  branch: ArtworkBranch | null;
}

/** El precio grande de la pieza: el promocional si hay promoción; si no, el vigente. */
export function heroPrice(model: OfferArtworkModel): OfferPrice {
  return model.promotionalPrice ?? model.regularPrice;
}

export function hasPromotion(model: OfferArtworkModel): boolean {
  return model.promotionalPrice !== null;
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

/** Titular corto en mayúsculas, sólo letras/números/signos simples y a lo sumo 16 caracteres. Vacío => «OFERTA». */
export function normalizeHeadline(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_HEADLINE;
  const cleaned = sanitizeGlyphs(input).toLocaleUpperCase("es-AR").replace(HEADLINE_ALLOWED, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.slice(0, MAX_HEADLINE_LENGTH).trim();
  return clipped || DEFAULT_HEADLINE;
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
  /** Hechos de precio/promoción para el motor (mismo formato que la cartelería de TV). */
  available: boolean;
  unavailableReason: ArtworkUnavailableReason | null;
  model: Omit<OfferArtworkModel, "headline" | "imageUrl"> | null;
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
 * JSON de `get_product_artwork` → hechos + modelo base (sin titular ni imagen, que dependen de quien dibuja). `null` = respuesta
 * que no se entiende (producto inexistente o de otra organización).
 */
export function parseArtworkFacts(payload: unknown): ArtworkFacts | null {
  if (!isRecord(payload)) return null;
  const productId = asString(payload.productId);
  if (!productId) return null;
  const photo = parsePhoto(payload.photo);
  const branchId = asString(payload.branchId);
  const unavailableReason = isReason(payload.unavailableReason) ? payload.unavailableReason : null;
  const branchName = asString(payload.branchName);
  const branch: ArtworkBranch | null = branchName ? { name: branchName, address: asString(payload.branchAddress) } : null;

  if (payload.available !== true || unavailableReason) {
    return { productId, available: false, unavailableReason: unavailableReason ?? "NO_PRICE", model: null, photo, branchId };
  }
  const facts = parseSlideFacts(payload);
  const offer = facts ? buildOfferSlide(facts) : null;
  if (!facts || !offer) return { productId, available: false, unavailableReason: "NO_PRICE", model: null, photo, branchId };

  const regularPrice = offer.promo ? splitPrice(facts.listPriceCents) : offer.price;
  return {
    productId, available: true, unavailableReason: null, photo, branchId,
    model: {
      businessName: BRAND_NAME,
      productName: sanitizeGlyphs(offer.name.toLocaleUpperCase("es-AR")),
      unitType: facts.unitType,
      regularPrice,
      promotionalPrice: offer.promo ? offer.price : null,
      promotionCondition: offer.promo ? offer.condition : null,
      priceSuffix: offer.priceSuffix,
      unitLabel: facts.unitType === "WEIGHT" ? "X KG" : null,
      branch
    }
  };
}

/** Completa el modelo con el titular (normalizado) y la imagen. Una pieza = un modelo, para cualquier formato. */
export function buildOfferArtworkModel(facts: ArtworkFacts, extras: { headline: unknown; imageUrl: string | null }): OfferArtworkModel | null {
  if (!facts.model) return null;
  return { ...facts.model, headline: normalizeHeadline(extras.headline), imageUrl: extras.imageUrl };
}

/** Nombre de archivo del PNG: «super-ofertas-feed-nalga-vacuna.png». */
export function artworkFilename(model: OfferArtworkModel, format: string): string {
  const slug = model.productName
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "producto";
  return `super-ofertas-${format}-${slug}.png`;
}
