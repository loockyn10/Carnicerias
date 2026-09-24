import { formatCurrency } from "@carnicerias/business-logic";

// minimum_grams/discount_type/discount_value are only populated for a THRESHOLD promotion;
// a PACK_FIXED_TOTAL row has those null and its own pack_* columns populated instead (see
// supabase/migrations/202609230031_promotion_pack_fixed_total.sql's mode_shape_check). All
// are genuinely nullable here — never coerce a missing value to 0/"" to build a display
// string ("sin costo"/"sin precio" is a real, distinct state from "$0").
export interface PromotionLabelRow {
  promotion_mode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimum_grams: number | null;
  discount_type: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discount_value: number | null;
  pack_quantity_grams: number | null;
  pack_quantity_units: number | null;
  pack_price_cents: number | null;
}

/**
 * Short one-line summary used on Productos → Productos (e.g. "10% desde 2 kg" or
 * "40 u por $28.000"). Mirrors the label on Productos → Promociones (promotions/page.tsx's
 * displayLine). Defensive: if a field the row's own mode requires turns out missing
 * (shouldn't happen given the DB's mode_shape_check, but this must never crash the page on
 * it), returns null instead of fabricating a $0/0 kg value.
 */
export function promotionLabel(discount: PromotionLabelRow): string | null {
  if (discount.promotion_mode === "PACK_FIXED_TOTAL") {
    const quantity = discount.pack_quantity_grams != null ? `${(discount.pack_quantity_grams / 1000).toLocaleString("es-AR")} kg`
      : discount.pack_quantity_units != null ? `${discount.pack_quantity_units.toLocaleString("es-AR")} u` : null;
    if (quantity == null || discount.pack_price_cents == null) return null;
    return `${quantity} por ${formatCurrency(BigInt(discount.pack_price_cents))}`;
  }
  if (discount.minimum_grams == null || discount.discount_value == null || discount.discount_type == null) return null;
  const value = discount.discount_type === "PERCENTAGE"
    ? `${(discount.discount_value / 100).toLocaleString("es-AR")}%`
    : `${formatCurrency(BigInt(discount.discount_value))}/kg`;
  return `${value} desde ${(discount.minimum_grams / 1000).toLocaleString("es-AR")} kg`;
}
