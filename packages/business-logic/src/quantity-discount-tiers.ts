import type { PaymentMethod } from "@carnicerias/types";

import { calculateBranchPromotionLinePricing, formatBasisPointsPercent, type BranchUnitPromotion, type UnitDiscountPricing } from "./unit-discounts";

/**
 * Descuentos GENERALES por cantidad con escalones (D-083). Generaliza el «Dto llevando 3u» (una sola regla "desde N") a una lista:
 *
 *   3 unidades → 15 %
 *   5 unidades → 20 %
 *
 * Reglas (no cambian la precedencia de pricing: precio manual > Pack > promoción específica del producto > ESTE descuento, sin acumular):
 *   - se aplica el MAYOR escalón alcanzado por la línea (mismo producto UNIT): 1–2 u → nada; 3–4 u → 15 %; 5 o más → 20 %;
 *   - los escalones NUNCA se suman (5 unidades es 20 %, no 15 % + 20 %);
 *   - sólo productos `UNIT` y por línea (nunca se combinan productos distintos); un producto `WEIGHT` no recibe esta regla;
 *   - cantidades enteras y porcentajes en basis points enteros (nunca floats); redondeo half-up del motor de siempre.
 *
 * El mismo cálculo corre en el POS (online y offline, con los escalones que sincronizó) y en el servidor al validar la venta sincronizada.
 */

export const MIN_QUANTITY_TIER_UNITS = 2;
export const MAX_QUANTITY_TIER_UNITS = 1_000;
export const MAX_QUANTITY_TIERS = 10;

/** Un escalón de la configuración (Admin): desde `minimumUnits` unidades, `discountBps` sobre toda la línea. */
export interface QuantityTier {
  minimumUnits: number;
  discountBps: number;
}

/**
 * El MAYOR escalón alcanzado por `quantityUnits` (el de mayor `minimumUnits` que no supera la cantidad), o `null` si no llega al primero.
 * No depende del orden de la lista.
 */
export function selectQuantityTier<T extends { minimumUnits: number }>(tiers: readonly T[], quantityUnits: number): T | null {
  if (!Number.isSafeInteger(quantityUnits) || quantityUnits <= 0) throw new RangeError("Invalid sale quantity");
  let best: T | null = null;
  for (const tier of tiers) {
    if (tier.minimumUnits <= quantityUnits && (best === null || tier.minimumUnits > best.minimumUnits)) best = tier;
  }
  return best;
}

/**
 * Línea `UNIT` normal con el descuento por cantidad: elige el mayor escalón alcanzado y lo calcula con el motor de la promoción de sucursal
 * (`calculateBranchPromotionLinePricing`). Devuelve `null` si la cantidad no llega al primer escalón. El resultado trae el id y el mínimo
 * del escalón aplicado (`promotionId`, `promotionMinimumUnits`): es lo que la venta guarda como snapshot.
 */
export function calculateQuantityTierLinePricing(input: {
  listPriceCents: bigint;
  quantityUnits: number;
  tiers: readonly BranchUnitPromotion[];
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): UnitDiscountPricing | null {
  const tier = selectQuantityTier(input.tiers, input.quantityUnits);
  if (!tier) return null;
  return calculateBranchPromotionLinePricing({
    listPriceCents: input.listPriceCents, quantityUnits: input.quantityUnits, promotion: tier, paymentMethod: input.paymentMethod, cashDiscountBps: input.cashDiscountBps
  });
}

/** «Llevando 3 o más: 15% dto.» */
export function quantityTierLabel(tier: QuantityTier): string {
  return `Llevando ${String(tier.minimumUnits)} o más: ${formatBasisPointsPercent(tier.discountBps)}% dto.`;
}

export type QuantityTiersResult = { ok: true; tiers: QuantityTier[] } | { ok: false; error: string };

/**
 * Valida y ordena los escalones de la configuración (la misma regla que `app_private.normalize_quantity_tiers` en el servidor): cantidad entera
 * entre 2 y 1000, porcentaje entre 0,01 % y 99,99 % en basis points enteros, sin cantidades repetidas, a lo sumo 10 y con descuento
 * estrictamente creciente (llevar más nunca puede dar menos descuento). Devuelve la lista ORDENADA por cantidad.
 */
export function normalizeQuantityTiers(tiers: readonly QuantityTier[]): QuantityTiersResult {
  if (tiers.length > MAX_QUANTITY_TIERS) return { ok: false, error: `Se admiten hasta ${String(MAX_QUANTITY_TIERS)} escalones.` };
  const seen = new Set<number>();
  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.minimumUnits) || tier.minimumUnits < MIN_QUANTITY_TIER_UNITS || tier.minimumUnits > MAX_QUANTITY_TIER_UNITS) {
      return { ok: false, error: `La cantidad mínima tiene que ser un número entero entre ${String(MIN_QUANTITY_TIER_UNITS)} y ${String(MAX_QUANTITY_TIER_UNITS)}.` };
    }
    if (!Number.isSafeInteger(tier.discountBps) || tier.discountBps < 1 || tier.discountBps > 9_999) {
      return { ok: false, error: "El descuento de cada escalón tiene que ser mayor a 0 % y menor a 100 %." };
    }
    if (seen.has(tier.minimumUnits)) return { ok: false, error: `No puede haber dos escalones con la misma cantidad (${String(tier.minimumUnits)}).` };
    seen.add(tier.minimumUnits);
  }
  const sorted = [...tiers].sort((left, right) => left.minimumUnits - right.minimumUnits);
  let previous = 0;
  for (const tier of sorted) {
    if (tier.discountBps <= previous) return { ok: false, error: `Llevar más unidades tiene que dar más descuento: el escalón de ${String(tier.minimumUnits)} unidades no supera al anterior.` };
    previous = tier.discountBps;
  }
  return { ok: true, tiers: sorted.map((tier) => ({ minimumUnits: tier.minimumUnits, discountBps: tier.discountBps })) };
}
