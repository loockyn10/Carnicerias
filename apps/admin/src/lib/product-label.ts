import { calculateBranchPromotionLinePricing, formatCurrency } from "@carnicerias/business-logic";

/**
 * Datos de la etiqueta de góndola (70 × 50 mm). Puro: decide QUÉ texto lleva la etiqueta; el dibujo vive en
 * `components/product-price-label.tsx`. No tiene fórmula de descuento propia: el precio «llevando 3u» sale del mismo motor que
 * usa el POS (`calculateBranchPromotionLinePricing`, con la configuración global D-068) y se formatea con `formatCurrency`.
 */

/** Tamaño físico de la etiqueta. La relación 70 / 50 = 1,4 se conserva en cualquier escala de preview. */
export const LABEL_WIDTH_MM = 70;
export const LABEL_HEIGHT_MM = 50;

/** Cantidad mínima de la promoción global «llevando 3u» (D-068: regla `FROM_MINIMUM`, mínimo 3, sobre toda la línea). */
export const LABEL_BULK_MINIMUM_UNITS = 3;

/**
 * Tipografía: UN tamaño base (el del precio) y el resto como proporción de él. Ajustar `LABEL_PRICE_BASE_PT` reescala toda la
 * etiqueta sin romper la jerarquía. Fuente de verdad en pt (impresión), nunca px.
 */
export const LABEL_PRICE_BASE_PT = 28;
export const LABEL_TITLE_SCALE = 0.7;
export const LABEL_NOTE_SCALE = 0.3;
export const LABEL_UNIT_PRICE_SCALE = 0.4;

/** Tamaños derivados en pt (el CSS los calcula con `calc()` sobre las mismas escalas; esto sirve para mostrarlos y verificarlos). */
export function labelFontSizesPt(basePt: number = LABEL_PRICE_BASE_PT) {
  return { price: basePt, title: basePt * LABEL_TITLE_SCALE, note: basePt * LABEL_NOTE_SCALE, unitPrice: basePt * LABEL_UNIT_PRICE_SCALE };
}

export type ProductLabelVariant = "BULK" | "REGULAR" | "WEIGHT" | "NO_PRICE";

export interface ProductLabelData {
  variant: ProductLabelVariant;
  name: string;
  /** Precio dominante, ya formateado ("$ 1.729,75"); null = sin precio. */
  price: string | null;
  /** Sufijo pequeño pegado al precio ("/kg"). */
  priceSuffix: string | null;
  /** Aclaración bajo el precio ("llevando 3 unidades"); null = no se muestra. */
  note: string | null;
  /** Línea inferior ("Precio unitario: $ 2.035" / "Precio unitario"); null = no se muestra. */
  unitPrice: string | null;
  /** Factor (0,6–1) que achica el nombre largo para que entre en 2 líneas. */
  titleFit: number;
  /** Factor (0,5–1) que achica TODA la tipografía si el precio es muy largo (conserva las proporciones). */
  priceFit: number;
}

/** ~30 caracteres entran en 2 líneas al 70 % de 28 pt en 70 mm; más largo ⇒ se reduce hasta un piso de 0,6 (después se corta a 2 líneas). */
const TITLE_CHARS_AT_FULL_SIZE = 30;
const TITLE_MIN_FIT = 0.6;
const PRICE_CHARS_AT_FULL_SIZE = 11;
const PRICE_MIN_FIT = 0.5;

export function titleFitFor(name: string): number {
  const length = name.trim().length;
  if (length <= TITLE_CHARS_AT_FULL_SIZE) return 1;
  return Math.max(TITLE_MIN_FIT, Math.round((TITLE_CHARS_AT_FULL_SIZE / length) * 100) / 100);
}

export function priceFitFor(priceText: string | null, suffix: string | null): number {
  const length = (priceText?.length ?? 0) + (suffix ? suffix.length * 0.4 : 0);
  if (length <= PRICE_CHARS_AT_FULL_SIZE) return 1;
  return Math.max(PRICE_MIN_FIT, Math.round((PRICE_CHARS_AT_FULL_SIZE / length) * 100) / 100);
}

export interface ProductLabelInput {
  name: string;
  unitType: "UNIT" | "WEIGHT";
  /** Precio de lista vigente en centavos (por unidad o por kg); null o <= 0 = sin precio definido. */
  listPriceCents: number | null;
  /** «Dto llevando 3u» global en basis points (`organization_pricing_settings.unit_bulk_discount_bps`); null/0 = sin promoción. */
  unitBulkDiscountBps: number | null;
}

export function buildProductLabel(input: ProductLabelInput): ProductLabelData {
  const name = input.name.trim();
  const finish = (data: Omit<ProductLabelData, "name" | "titleFit" | "priceFit">): ProductLabelData => ({
    ...data, name, titleFit: titleFitFor(name), priceFit: priceFitFor(data.price, data.priceSuffix)
  });

  if (input.listPriceCents === null || input.listPriceCents <= 0) {
    return finish({ variant: "NO_PRICE", price: null, priceSuffix: null, note: null, unitPrice: null });
  }
  const listPrice = BigInt(input.listPriceCents);
  const listText = formatCurrency(listPrice);

  // Por ahora sólo kg a precio de lista: la etiqueta no resuelve promociones por cantidad de WEIGHT.
  if (input.unitType === "WEIGHT") {
    return finish({ variant: "WEIGHT", price: listText, priceSuffix: "/kg", note: null, unitPrice: null });
  }

  const bps = input.unitBulkDiscountBps;
  if (bps !== null && bps > 0) {
    const bulk = calculateBranchPromotionLinePricing({
      listPriceCents: listPrice, quantityUnits: LABEL_BULK_MINIMUM_UNITS, paymentMethod: "CASH", cashDiscountBps: 0n,
      promotion: { id: "label-bulk", minimumUnits: LABEL_BULK_MINIMUM_UNITS, discountBps: bps }
    });
    if (bulk) {
      return finish({ variant: "BULK", price: formatCurrency(bulk.cashPriceCents), priceSuffix: null, note: `llevando ${String(LABEL_BULK_MINIMUM_UNITS)} unidades`, unitPrice: `Precio unitario: ${listText}` });
    }
  }
  return finish({ variant: "REGULAR", price: listText, priceSuffix: null, note: null, unitPrice: "Precio unitario" });
}
