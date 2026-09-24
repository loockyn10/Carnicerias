import { kilogramsToGrams, optionalId, percentageToBasisPoints, pesosToCents, text, unitsToInteger } from "./form-parsing";

/**
 * public.save_weight_discount has two overloads in the database: a legacy 9-parameter one
 * that predates pack support, and the current 13-parameter one (see
 * supabase/migrations/202609230031_promotion_pack_fixed_total.sql). PostgREST resolves
 * which overload to call by the exact set of parameter names present in the request body,
 * and p_minimum_grams/p_discount_type/p_discount_value have no SQL default on the new
 * function — so every call must always name all 13 parameters, with whichever trio doesn't
 * apply (legacy for a pack, pack for a threshold) sent explicitly as null. Omitting them
 * makes PostgREST unable to match either overload ("Could not find the function... in the
 * schema cache").
 */
export interface SaveWeightDiscountArgs {
  p_id: string | null;
  p_product_id: string;
  p_branch_id: string | null;
  p_active: boolean;
  p_valid_from: string;
  p_valid_until: string | null;
  p_promotion_mode: string;
  p_minimum_grams: number | null;
  p_discount_type: string | null;
  p_discount_value: number | null;
  p_pack_quantity_grams: number | null;
  p_pack_quantity_units: number | null;
  p_pack_price_cents: number | null;
}

export function buildSaveWeightDiscountArgs(formData: FormData): SaveWeightDiscountArgs {
  const promotionMode = text(formData, "promotion_mode") || "THRESHOLD";
  const shared = {
    p_id: optionalId(formData, "discount_id"), p_product_id: text(formData, "product_id"), p_branch_id: optionalId(formData, "branch_id"),
    p_active: formData.get("active") === "on",
    p_valid_from: text(formData, "valid_from") ? new Date(text(formData, "valid_from")).toISOString() : new Date().toISOString(),
    p_valid_until: text(formData, "valid_until") ? new Date(text(formData, "valid_until")).toISOString() : null,
    p_promotion_mode: promotionMode
  };
  if (promotionMode === "PACK_FIXED_TOTAL") {
    // A pack's quantity is expressed in kg or in units depending on the product's own sale
    // type — the client only ever renders the field that matches, but the server RPC re-checks
    // it against the real product row regardless (see 202609230031_promotion_pack_fixed_total.sql).
    const packUnitType = text(formData, "pack_unit_type");
    return {
      ...shared,
      p_minimum_grams: null, p_discount_type: null, p_discount_value: null,
      p_pack_quantity_grams: packUnitType === "WEIGHT" ? kilogramsToGrams(text(formData, "pack_quantity_kg")) : null,
      p_pack_quantity_units: packUnitType === "UNIT" ? unitsToInteger(text(formData, "pack_quantity_units")) : null,
      p_pack_price_cents: pesosToCents(text(formData, "pack_price"))
    };
  }
  const discountType = text(formData, "discount_type");
  if (discountType !== "PERCENTAGE" && discountType !== "FIXED_PRICE_PER_KG") throw new Error("Tipo de descuento inválido");
  return {
    ...shared,
    p_minimum_grams: kilogramsToGrams(text(formData, "minimum_kg")), p_discount_type: discountType,
    p_discount_value: discountType === "PERCENTAGE" ? percentageToBasisPoints(text(formData, "discount_value")) : pesosToCents(text(formData, "discount_value")),
    p_pack_quantity_grams: null, p_pack_quantity_units: null, p_pack_price_cents: null
  };
}
