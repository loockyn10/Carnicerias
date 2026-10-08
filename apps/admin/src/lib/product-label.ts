import { calculateBranchPromotionLinePricing, formatBasisPointsPercent, formatCurrency } from "@carnicerias/business-logic";

import { toLabelText } from "./label-font";

/**
 * Contenido de la etiqueta de góndola (60 × 40 mm). Puro: decide QUÉ texto lleva cada etiqueta; DÓNDE va cada cosa lo decide
 * `label-layout.ts` (con las medidas de `label-spec.ts`), y el dibujo lo hacen el preview SVG y el PDF a partir de ese layout.
 *
 * No hay fórmula de descuento propia: el precio de la oferta «llevando N» sale del mismo motor que usa el POS
 * (`calculateBranchPromotionLinePricing`) y se formatea con `formatCurrency` (sin redondeos comerciales extra: si el motor da
 * $ 1.742,50 se imprime $ 1.742,50). La regla (cantidad mínima y porcentaje) y el precio de lista llegan ya resueltos para la
 * sucursal del grupo por la base (`get_label_group`).
 */

export type ProductLabelVariant = "PROMO" | "SIMPLE" | "WEIGHT" | "NO_PRICE";

/** Regla «llevando N» vigente (la de la sucursal del grupo o, sin sucursal, la global D-068). */
export interface BulkPromotionFact {
  minimumUnits: number;
  discountBps: number;
}

/** Lo que se IMPRIME de un producto, en valores exactos (los centavos viajan como texto: bigint seguro y serializable). */
export interface LabelValues {
  /** Nombre tal como queda en la etiqueta (mayúsculas, apto para las fuentes del PDF). */
  displayedName: string;
  /** Precio normal mostrado (por unidad o por kg), en centavos. */
  listPriceCents: string;
  /** Precio promocional mostrado, en centavos; null = la etiqueta no lleva oferta. */
  promoPriceCents: string | null;
  promoMinimumUnits: number | null;
  promoDiscountBps: number | null;
}

export interface ProductLabelData {
  variant: ProductLabelVariant;
  /** Nombre ya en mayúsculas y saneado (lo que se dibuja). */
  name: string;
  /** «SUPER OFERTAS»: identidad del negocio, en TODAS las etiquetas. */
  headline: string;
  /** «LLEVANDO 3 UNIDADES» (sólo con promoción). */
  conditionLine: string | null;
  /** «Descuento 15%»: sólo para el historial; NO se dibuja en la etiqueta. */
  discountLine: string | null;
  /** Precio dominante, ya formateado ("$ 1.742,50"); «SIN PRECIO» si el producto no tiene precio vigente. */
  price: string;
  /** Sufijo pequeño pegado al precio ("/kg"). */
  priceSuffix: string | null;
  /** Fila inferior de la oferta: «PRECIO NORMAL» + precio normal. */
  normalLabel: string | null;
  normalPrice: string | null;
  /** «PRECIO UNITARIO» / «PRECIO POR KILO» bajo el precio (variantes sin oferta). */
  footLabel: string | null;
  /** Valores exactos impresos (para el historial y para detectar cambios); null = no imprimible (sin precio). */
  values: LabelValues | null;
}

export const OFFER_HEADLINE = "SUPER OFERTAS";
export const NO_PRICE_TEXT = "SIN PRECIO";

export interface ProductLabelInput {
  name: string;
  unitType: "UNIT" | "WEIGHT";
  /** Precio de lista vigente en centavos (por unidad o por kg); null o <= 0 = sin precio definido. */
  listPriceCents: bigint | null;
  /** Regla «llevando N» vigente para el grupo; null = sin promoción. Sólo se usa en productos UNIT. */
  bulk: BulkPromotionFact | null;
}

/** Nombre tal como se imprime: mayúsculas (como el cartel actual) y sólo caracteres que el PDF puede dibujar. */
export function labelDisplayName(name: string): string {
  return toLabelText(name.trim().toLocaleUpperCase("es-AR"));
}

const EMPTY_TEXTS = {
  headline: OFFER_HEADLINE, conditionLine: null, discountLine: null, priceSuffix: null, normalLabel: null, normalPrice: null, footLabel: null
} as const;

export function buildProductLabel(input: ProductLabelInput): ProductLabelData {
  const name = labelDisplayName(input.name);
  const list = input.listPriceCents;

  if (list === null || list <= 0n) {
    return { ...EMPTY_TEXTS, variant: "NO_PRICE", name, price: NO_PRICE_TEXT, values: null };
  }
  const listText = formatCurrency(list);
  const values = (promo: { cents: bigint; minimumUnits: number; discountBps: number } | null): LabelValues => ({
    displayedName: name,
    listPriceCents: list.toString(),
    promoPriceCents: promo ? promo.cents.toString() : null,
    promoMinimumUnits: promo ? promo.minimumUnits : null,
    promoDiscountBps: promo ? promo.discountBps : null
  });

  // Sólo kg a precio de lista: la etiqueta no resuelve promociones por cantidad de productos WEIGHT.
  if (input.unitType === "WEIGHT") {
    return { ...EMPTY_TEXTS, variant: "WEIGHT", name, price: listText, priceSuffix: "/kg", footLabel: "PRECIO POR KILO", values: values(null) };
  }

  const bulk = input.bulk;
  if (bulk && bulk.discountBps > 0) {
    try {
      const pricing = calculateBranchPromotionLinePricing({
        listPriceCents: list, quantityUnits: bulk.minimumUnits, paymentMethod: "CASH", cashDiscountBps: 0n,
        promotion: { id: "label-bulk", minimumUnits: bulk.minimumUnits, discountBps: bulk.discountBps }
      });
      if (pricing && pricing.cashPriceCents > 0n && pricing.cashPriceCents < list) {
        return {
          ...EMPTY_TEXTS, variant: "PROMO", name,
          conditionLine: `LLEVANDO ${String(bulk.minimumUnits)} UNIDADES`,
          discountLine: `Descuento ${formatBasisPointsPercent(bulk.discountBps)}%`,
          price: formatCurrency(pricing.cashPriceCents),
          normalLabel: "PRECIO NORMAL", normalPrice: listText,
          values: values({ cents: pricing.cashPriceCents, minimumUnits: bulk.minimumUnits, discountBps: bulk.discountBps })
        };
      }
    } catch {
      // Regla inválida (p. ej. mínimo < 2): se imprime el precio unitario, que siempre es correcto.
    }
  }
  return { ...EMPTY_TEXTS, variant: "SIMPLE", name, price: listText, footLabel: "PRECIO UNITARIO", values: values(null) };
}

/** Texto de la condición para el historial (sin cambios): «POR 3 UNIDADES - Descuento 15%»; null si la etiqueta no lleva oferta. */
export function conditionText(label: ProductLabelData): string | null {
  const units = label.values?.promoMinimumUnits;
  return label.conditionLine && label.discountLine && units ? `POR ${String(units)} UNIDADES - ${label.discountLine}` : null;
}
