import type { PaymentMethod } from "@carnicerias/types";

export interface QuantityDiscount {
  id: string;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG";
  discountValue: bigint;
}

export interface SalePricing {
  listPriceCents: bigint;
  cashPriceCents: bigint;
  finalPriceCents: bigint;
  listSubtotalCents: bigint;
  cashSubtotalCents: bigint;
  subtotalCents: bigint;
  cashDiscountBps: bigint;
  cashDiscountCents: bigint;
  /** Amount added on top of the list price for a card payment (DEBIT/CREDIT) — see
   * isCardSurchargePaymentMethod. Always 0 for CASH/TRANSFER/OTHER, which now pay exactly the
   * configured list price with no adjustment at all (see D-044). */
  cardSurchargeCents: bigint;
  promotionDiscountCents: bigint;
  discountCents: bigint;
}

/** Integer division rounded half up. Inputs must be non-negative. */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("Invalid monetary ratio");
  return (numerator + denominator / 2n) / denominator;
}

export function validateBasisPoints(value: bigint, allowHundred = false): void {
  if (value < 0n || value > (allowHundred ? 10_000n : 9_999n)) {
    throw new RangeError("Basis points are outside the allowed range");
  }
}

/**
 * DEBIT/CREDIT ("Tarjeta" in the POS) get a card surcharge added on top of the configured list
 * price; CASH/TRANSFER/OTHER pay that list price with no adjustment at all (see D-044 — this
 * used to be the inverse: CASH/TRANSFER/OTHER got a discount off a higher list price, DEBIT/
 * CREDIT paid list price unchanged. The underlying partition of methods is the same as before,
 * only which side gets the bps adjustment — and its sign — changed).
 */
export function isCardSurchargePaymentMethod(method: PaymentMethod): boolean {
  return method === "DEBIT" || method === "CREDIT";
}

/** Builds the target cash price and its inverse list price without floating point. */
export function calculatePriceFormation(costCents: bigint, profitMarkupBps: bigint, cashDiscountBps: bigint) {
  if (costCents < 0n || profitMarkupBps < 0n || profitMarkupBps > 100_000n) {
    throw new RangeError("Cost or target profit is outside the allowed range");
  }
  validateBasisPoints(cashDiscountBps);
  const targetCashPriceCents = divideRoundHalfUp(costCents * (10_000n + profitMarkupBps), 10_000n);
  const listPriceCents = divideRoundHalfUp(costCents * (10_000n + profitMarkupBps), 10_000n - cashDiscountBps);
  const effectiveCashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n - cashDiscountBps), 10_000n);
  return { targetCashPriceCents, listPriceCents, effectiveCashPriceCents };
}

/**
 * Recalculates from the immutable list price every time; discounts never accumulate.
 *
 * Payment-method adjustment (D-044): CASH/TRANSFER/OTHER pay exactly listPriceCents, no
 * adjustment at all — cashDiscountCents is always 0. DEBIT/CREDIT ("Tarjeta") pay
 * listPriceCents plus a card surcharge (cardSurchargeCents), computed from the same
 * `cashDiscountBps` configuration value (kept under its legacy name/column — see D-044 — it now
 * configures the surcharge percentage, not a discount). A promotion is then evaluated against
 * that post-surcharge price (cashPriceCents), exactly like before: it still can never increase
 * the price relative to whatever this payment method would otherwise pay.
 */
export function calculateSalePricing(input: {
  listPriceCents: bigint;
  quantity: number;
  quantityDivisor: 1 | 1_000;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
  promotion?: QuantityDiscount | null;
}): SalePricing {
  const { listPriceCents, quantity, quantityDivisor, paymentMethod, promotion } = input;
  if (listPriceCents <= 0n || !Number.isSafeInteger(quantity) || quantity <= 0) throw new RangeError("Invalid sale quantity or price");
  validateBasisPoints(input.cashDiscountBps);
  const cashDiscountBps = isCardSurchargePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const cashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n + cashDiscountBps), 10_000n);
  let finalPriceCents = cashPriceCents;
  if (promotion) {
    finalPriceCents = promotion.discountType === "PERCENTAGE"
      ? divideRoundHalfUp(cashPriceCents * (10_000n - promotion.discountValue), 10_000n)
      : promotion.discountValue;
    if (finalPriceCents <= 0n || finalPriceCents > cashPriceCents) throw new RangeError("Promotion is not a discount for this payment method");
  }
  const line = (price: bigint) => divideRoundHalfUp(price * BigInt(quantity), BigInt(quantityDivisor));
  const listSubtotalCents = line(listPriceCents);
  const cashSubtotalCents = line(cashPriceCents);
  const subtotalCents = line(finalPriceCents);
  const cashDiscountCents = 0n;
  const cardSurchargeCents = cashSubtotalCents - listSubtotalCents;
  const promotionDiscountCents = cashSubtotalCents - subtotalCents;
  return {
    listPriceCents, cashPriceCents, finalPriceCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, cardSurchargeCents, promotionDiscountCents,
    discountCents: cashDiscountCents + promotionDiscountCents
  };
}

/**
 * PACK_FIXED_TOTAL on a WEIGHT product (e.g. "Vacío: 2kg por $18.000"): a real
 * pre-cut piece never weighs the nominal pack amount exactly, so the pack
 * charges its configured total regardless of the actual weighed grams — the
 * weight is still what feeds stock. This is intentionally NOT a threshold: it
 * never scales with quantity. Only sanity-checked against the LIST price for
 * the weighed amount, so it can never be a worse deal than buying that same
 * piece unweighted at full list price — in practice this never triggers for a
 * real pack's natural weight variance.
 *
 * Payment method (D-044): a pack's configured total is deliberately
 * payment-method-invariant — paying by card never adds a surcharge on top of
 * it, exactly as it never varied with the weighed grams. `paymentMethod`/
 * `cashDiscountBps` are accepted only for a uniform call signature with the
 * other pricing functions and to snapshot the config that was in effect;
 * cashPriceCents/cashSubtotalCents/cardSurchargeCents/cashDiscountCents all
 * collapse to their list-price-equivalent values here (this was the one
 * business decision this migration deliberately did NOT reinterpret — see
 * D-044's report). Mirrors complete_discounted_sale's PACK_FIXED_TOTAL branch
 * exactly (same rounding, same clamped promotionDiscountCents) so the
 * server-side snapshot and this pure calculation always agree.
 */
export function calculateWeightPackSalePricing(input: {
  listPriceCents: bigint;
  weightGrams: number;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
  packPriceCents: bigint;
}): SalePricing {
  const { listPriceCents, weightGrams, packPriceCents } = input;
  if (listPriceCents <= 0n || !Number.isSafeInteger(weightGrams) || weightGrams <= 0) {
    throw new RangeError("Invalid sale quantity or price");
  }
  if (packPriceCents <= 0n) throw new RangeError("Invalid pack price");
  validateBasisPoints(input.cashDiscountBps);
  const listSubtotalCents = divideRoundHalfUp(listPriceCents * BigInt(weightGrams), 1_000n);
  if (packPriceCents > listSubtotalCents) {
    throw new RangeError("Pack price exceeds list price for the weighed amount");
  }
  const subtotalCents = packPriceCents;
  const finalPriceCents = divideRoundHalfUp(subtotalCents * 1_000n, BigInt(weightGrams));
  const rawPromotionDiscountCents = listSubtotalCents - subtotalCents;
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents: listPriceCents, finalPriceCents, listSubtotalCents, cashSubtotalCents: listSubtotalCents,
    subtotalCents, cashDiscountBps: 0n, cashDiscountCents: 0n, cardSurchargeCents: 0n, promotionDiscountCents,
    discountCents: listSubtotalCents - subtotalCents
  };
}

export interface UnitPackPromotion {
  id: string;
  packQuantityUnits: number;
  packPriceCents: bigint;
}

/**
 * PACK_FIXED_TOTAL on a UNIT product (e.g. "Hamburguesa: 40 unidades por
 * $28.000"): unlike the WEIGHT pack, unit counts are exact, so whole packs
 * apply automatically on exact multiples (80 = 2x40) and any remainder sells
 * at the normal per-unit price — never a partial/invented discount for the
 * remainder.
 *
 * Payment method (D-044): the whole-pack portion (packPriceCents * wholePacks)
 * is payment-method-invariant, exactly like the WEIGHT pack — a card payment
 * never adds a surcharge on top of the pack's configured total. The remainder
 * units are a genuine normal-price sale (not part of the pack), so they DO
 * carry the card surcharge like any other line: cashPriceCents reflects it,
 * and it feeds the remainder's contribution to subtotalCents/cardSurchargeCents.
 */
export function calculateUnitPackSalePricing(input: {
  listPriceCents: bigint;
  quantityUnits: number;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
  pack: UnitPackPromotion;
}): SalePricing {
  const { listPriceCents, quantityUnits, paymentMethod, pack } = input;
  if (listPriceCents <= 0n || !Number.isSafeInteger(quantityUnits) || quantityUnits <= 0) {
    throw new RangeError("Invalid sale quantity or price");
  }
  if (!Number.isSafeInteger(pack.packQuantityUnits) || pack.packQuantityUnits <= 0 || pack.packPriceCents <= 0n) {
    throw new RangeError("Invalid pack configuration");
  }
  const packListEquivalentCents = listPriceCents * BigInt(pack.packQuantityUnits);
  if (pack.packPriceCents > packListEquivalentCents) {
    throw new RangeError("Pack price exceeds list price for its quantity");
  }
  validateBasisPoints(input.cashDiscountBps);
  const cashDiscountBps = isCardSurchargePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const cashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n + cashDiscountBps), 10_000n);
  const wholePacks = Math.floor(quantityUnits / pack.packQuantityUnits);
  const remainderUnits = quantityUnits - wholePacks * pack.packQuantityUnits;
  const listSubtotalCents = listPriceCents * BigInt(quantityUnits);
  const cashSubtotalCents = pack.packPriceCents * BigInt(wholePacks) + cashPriceCents * BigInt(remainderUnits);
  const subtotalCents = cashSubtotalCents;
  const cashDiscountCents = 0n;
  const cardSurchargeCents = cashPriceCents > listPriceCents ? (cashPriceCents - listPriceCents) * BigInt(remainderUnits) : 0n;
  const rawPromotionDiscountCents = (listPriceCents * BigInt(wholePacks * pack.packQuantityUnits)) - (pack.packPriceCents * BigInt(wholePacks));
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents, finalPriceCents: subtotalCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, cardSurchargeCents, promotionDiscountCents,
    discountCents: cashDiscountCents + promotionDiscountCents
  };
}
