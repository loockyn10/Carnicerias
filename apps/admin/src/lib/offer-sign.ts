import { sanitizeGlyphs } from "./artwork-text";
import { formatIsoDate } from "./date-range";
import { buildOfferSlide, formatMinimumWeight, parsePromotionFact, splitPrice, type OfferPrice, type PromotionFact, type SlideFacts } from "./signage";

/**
 * Carteles de ofertas impresos A4 (D-087): de las promociones MANUALES cargadas en Productos → Promociones (`product_weight_discounts`,
 * leídas con `get_signage_promotion_catalog`: ya trae vigencia, sucursal, producto activo y precio de lista de esa sucursal) a lo que lleva
 * cada cartel. Puro y sin red. No hay ningún precio escrito a mano: el precio sale del MISMO motor que la cartelería de TV (`buildOfferSlide`),
 * y sólo se ofrece una promoción que de verdad baja el precio (si no, no hay oferta que anunciar ni «precio normal» que comparar).
 */

export type OfferSignFormat = "STRIP" | "POSTER";

export const OFFER_SIGN_FORMATS: readonly { id: OfferSignFormat; label: string; perPage: number }[] = [
  { id: "STRIP", label: "Tira · 3 ofertas por hoja", perPage: 3 },
  { id: "POSTER", label: "Cartel grande · 1 oferta por hoja", perPage: 1 }
];

export function signsPerPage(format: OfferSignFormat): number {
  return format === "STRIP" ? 3 : 1;
}

export function signPageCount(format: OfferSignFormat, count: number): number {
  return count <= 0 ? 0 : Math.ceil(count / signsPerPage(format));
}

/** Máximo de carteles por PDF (el servidor lo valida; con 60 el PDF sigue siendo liviano). */
export const MAX_OFFER_SIGNS = 60;

/** Un cartel listo para dibujar: todo texto ya está formateado; el layout no calcula nada. */
export interface OfferSign {
  promotionId: string;
  productId: string;
  /** Nombre del producto en mayúsculas, sólo con glifos de la fuente. */
  name: string;
  /** Condición destacada: «DESDE 2 KG», «LLEVANDO 2 KG», «PACK 12 UNIDADES». */
  condition: string;
  /** Precio de la promoción: parte entera con miles («6.500») y centavos sólo si son reales. */
  price: OfferPrice;
  /** Bajo el precio: «/ KG», «POR LOS 2 KG», «POR EL PACK». */
  unitLabel: string;
  /** Línea secundaria opcional («$741,67 C/U»); null = no se muestra. */
  secondary: string | null;
  /** «PRECIO NORMAL $7.000/KG»; null = no hay una comparación válida (nunca se inventa). */
  normalPrice: string | null;
  /** Resumen para la lista de selección («Desde 2 kg · $6.500/kg»). */
  summary: string;
  branchName: string | null;
  validUntil: string | null;
}

/** «$6.500» / «$1.729,75»: sin espacio tras el signo y sin decimales de más. */
export function moneyText(price: OfferPrice): string {
  return `$${price.whole}${price.cents ? `,${price.cents}` : ""}`;
}

/** Precio por unidad de un pack (centavos redondeados al más cercano): «$741,67»; null si no hay más de una unidad. */
export function perUnitText(packPriceCents: bigint, units: number): string | null {
  if (!Number.isSafeInteger(units) || units < 2) return null;
  const divisor = BigInt(units);
  const each = (packPriceCents * 2n + divisor) / (divisor * 2n);
  return moneyText(splitPrice(each));
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

function asCents(value: unknown): bigint | null {
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? BigInt(value) : null;
}

function unitsText(units: number): string {
  return units === 1 ? "1 UNIDAD" : `${String(units)} UNIDADES`;
}

function packQuantity(promotion: PromotionFact, unitType: "UNIT" | "WEIGHT"): { grams: number | null; units: number | null } {
  return {
    grams: unitType === "WEIGHT" && promotion.packQuantityGrams !== null && promotion.packQuantityGrams > 0 ? promotion.packQuantityGrams : null,
    units: unitType === "UNIT" && promotion.packQuantityUnits !== null && promotion.packQuantityUnits > 0 ? promotion.packQuantityUnits : null
  };
}

/** Una fila de `get_signage_promotion_catalog` → cartel. null = no se puede imprimir como oferta (vencida, producto inactivo, sin precio, no baja el precio…). */
export function buildOfferSign(raw: unknown): OfferSign | null {
  if (!isRecord(raw)) return null;
  const promotionId = asString(raw.promotionId);
  const productId = asString(raw.productId);
  const productName = asString(raw.productName);
  const unitType = raw.unitType;
  if (!promotionId || !productId || !productName || (unitType !== "UNIT" && unitType !== "WEIGHT")) return null;
  // Sólo promociones activas HOY, de un producto activo y con precio vigente en la sucursal.
  if (raw.status !== "ACTIVE" || (raw.unavailableReason !== null && raw.unavailableReason !== undefined)) return null;
  const listPriceCents = asCents(raw.listPriceCents);
  const promotion = parsePromotionFact(raw);
  if (listPriceCents === null || listPriceCents <= 0n || !promotion) return null;

  const facts: SlideFacts = { key: promotionId, name: productName, unitType, listPriceCents, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], promotion };
  const offer = buildOfferSlide(facts);
  if (!offer?.promo) return null;
  const name = sanitizeGlyphs(offer.name).toLocaleUpperCase("es-AR");
  if (!name) return null;

  const price = offer.price;
  const base = {
    promotionId, productId, name, price, branchName: asString(raw.branchName), validUntil: promotion.validUntil
  };

  if (offer.variant === "WEIGHT_PROMO") {
    const normal = `PRECIO NORMAL ${moneyText(offer.regularPrice)}/KG`;
    const condition = offer.mechanic ?? `DESDE ${formatMinimumWeight(promotion.minimumGrams ?? 0)}`;
    return { ...base, condition, unitLabel: "/ KG", secondary: null, normalPrice: normal, summary: `${capitalize(condition)} · ${moneyText(price)}/kg` };
  }

  // PACK: el total fijo contra el precio normal de ESA cantidad.
  const { grams, units } = packQuantity(promotion, unitType);
  const normal = `PRECIO NORMAL ${moneyText(offer.regularPrice)}`;
  if (grams !== null) {
    const quantity = formatMinimumWeight(grams);
    return { ...base, condition: `LLEVANDO ${quantity}`, unitLabel: `POR LOS ${quantity}`, secondary: null, normalPrice: normal, summary: `${quantity.toLowerCase()} por ${moneyText(price)}` };
  }
  if (units !== null && promotion.packPriceCents !== null) {
    const each = perUnitText(promotion.packPriceCents, units);
    return {
      ...base, condition: `PACK ${unitsText(units)}`, unitLabel: "POR EL PACK", secondary: each ? `${each} C/U` : null, normalPrice: normal,
      summary: `Pack ${unitsText(units).toLowerCase()} · ${moneyText(price)}`
    };
  }
  return null;
}

function capitalize(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Lista de carteles imprimibles de una sucursal (el orden de la base: nombre; una promoción repetida no se duplica). */
export function parseOfferSignCatalog(payload: unknown): OfferSign[] {
  if (!isRecord(payload) || !Array.isArray(payload.promotions)) return [];
  const signs: OfferSign[] = [];
  const seen = new Set<string>();
  for (const raw of payload.promotions as unknown[]) {
    const sign = buildOfferSign(raw);
    if (!sign || seen.has(sign.promotionId)) continue;
    seen.add(sign.promotionId);
    signs.push(sign);
  }
  return signs;
}

/** Texto de vigencia para la lista («Hasta el 20/10/2026» o «Sin fecha de fin»). */
export function signValidityText(sign: Pick<OfferSign, "validUntil">): string {
  return sign.validUntil ? `Hasta el ${formatIsoDate(sign.validUntil.slice(0, 10))}` : "Sin fecha de fin";
}

/** Parte `items` en hojas (3 por hoja en tira, 1 en cartel grande). */
export function paginateSigns<T>(items: readonly T[], format: OfferSignFormat): T[][] {
  const size = signsPerPage(format);
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

/** «carteles-ofertas-central-2026-10-13.pdf»: sin tildes ni caracteres raros. */
export function offerSignFilename(branchName: string, date: string): string {
  const ascii = branchName.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = (ascii || "sucursal").slice(0, 40).replace(/-+$/g, "");
  return `carteles-ofertas-${slug}-${date}.pdf`;
}


/** Texto sin tildes ni mayúsculas, para buscar «jamon» y encontrar «JAMÓN». */
function searchKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Filtra la lista por nombre del producto o por la condición («desde 2 kg», «pack»); todas las palabras tienen que estar. */
export function filterSigns(signs: readonly OfferSign[], query: string): OfferSign[] {
  const words = searchKey(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...signs];
  return signs.filter((sign) => {
    const haystack = searchKey(`${sign.name} ${sign.condition} ${sign.summary}`);
    return words.every((word) => haystack.includes(word));
  });
}
