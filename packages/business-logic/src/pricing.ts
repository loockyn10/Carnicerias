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
 * Order (D-044, corrected): list price -> promotion -> card surcharge. A promotion is evaluated
 * against the plain list price (never against a card-adjusted one) — this is the CASH/TRANSFER
 * equivalent price (cashPriceCents/cashSubtotalCents). The card surcharge is then a single
 * multiplicative step applied to that CASH-equivalent result, for CASH/TRANSFER/OTHER there is no
 * exception: no adjustment at all — cashDiscountCents is always 0. DEBIT/CREDIT ("Tarjeta") pay
 * the CASH-equivalent amount plus the configured surcharge percentage (cardSurchargeCents),
 * computed from the same `cashDiscountBps` configuration value (kept under its legacy name/column
 * — see D-044 — it now configures the surcharge percentage, not a discount). Every payment method
 * that isn't a card surcharge one gets exactly the CASH-equivalent price; there is no promotion or
 * pack exception to the surcharge itself (D-044's correction).
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
  let cashPriceCents = listPriceCents;
  if (promotion) {
    cashPriceCents = promotion.discountType === "PERCENTAGE"
      ? divideRoundHalfUp(listPriceCents * (10_000n - promotion.discountValue), 10_000n)
      : promotion.discountValue;
    if (cashPriceCents <= 0n || cashPriceCents > listPriceCents) throw new RangeError("Promotion is not a discount");
  }
  const finalPriceCents = cashDiscountBps > 0n ? divideRoundHalfUp(cashPriceCents * (10_000n + cashDiscountBps), 10_000n) : cashPriceCents;
  const line = (price: bigint) => divideRoundHalfUp(price * BigInt(quantity), BigInt(quantityDivisor));
  const listSubtotalCents = line(listPriceCents);
  const cashSubtotalCents = line(cashPriceCents);
  const subtotalCents = line(finalPriceCents);
  const cashDiscountCents = 0n;
  const cardSurchargeCents = subtotalCents - cashSubtotalCents;
  const promotionDiscountCents = listSubtotalCents - cashSubtotalCents;
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
 * Payment method (D-044, corrected): the pack's configured total (packPriceCents) IS the
 * CASH-equivalent commercial result — cashSubtotalCents. A card payment then applies the
 * surcharge to that whole total, exactly like any other line: no pack exception to the
 * surcharge itself. finalPriceCents (a derived $/kg display value) is computed from the
 * surcharge-inclusive subtotal, since the pack total — not a per-kg rate — is the ground truth.
 */
export function calculateWeightPackSalePricing(input: {
  listPriceCents: bigint;
  weightGrams: number;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
  packPriceCents: bigint;
}): SalePricing {
  const { listPriceCents, weightGrams, paymentMethod, packPriceCents } = input;
  if (listPriceCents <= 0n || !Number.isSafeInteger(weightGrams) || weightGrams <= 0) {
    throw new RangeError("Invalid sale quantity or price");
  }
  if (packPriceCents <= 0n) throw new RangeError("Invalid pack price");
  validateBasisPoints(input.cashDiscountBps);
  const cashDiscountBps = isCardSurchargePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const listSubtotalCents = divideRoundHalfUp(listPriceCents * BigInt(weightGrams), 1_000n);
  if (packPriceCents > listSubtotalCents) {
    throw new RangeError("Pack price exceeds list price for the weighed amount");
  }
  const cashSubtotalCents = packPriceCents;
  const subtotalCents = cashDiscountBps > 0n ? divideRoundHalfUp(cashSubtotalCents * (10_000n + cashDiscountBps), 10_000n) : cashSubtotalCents;
  const finalPriceCents = divideRoundHalfUp(subtotalCents * 1_000n, BigInt(weightGrams));
  const cardSurchargeCents = subtotalCents - cashSubtotalCents;
  const rawPromotionDiscountCents = listSubtotalCents - cashSubtotalCents;
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents: listPriceCents, finalPriceCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents: 0n, cardSurchargeCents, promotionDiscountCents,
    discountCents: promotionDiscountCents
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
 * Payment method (D-044, corrected): first compute the full CASH-equivalent commercial
 * result — whole packs at their fixed price plus any remainder at the (list) per-unit price —
 * exactly as a CASH/TRANSFER customer would pay. The card surcharge is then applied ONCE to
 * that whole total (cashSubtotalCents), never only to the remainder: a 45-unit sale (1 pack +
 * 5 loose) surcharges the full $32.000, not just the $4.000 remainder.
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
  const wholePacks = Math.floor(quantityUnits / pack.packQuantityUnits);
  const remainderUnits = quantityUnits - wholePacks * pack.packQuantityUnits;
  const listSubtotalCents = listPriceCents * BigInt(quantityUnits);
  const cashSubtotalCents = pack.packPriceCents * BigInt(wholePacks) + listPriceCents * BigInt(remainderUnits);
  const subtotalCents = cashDiscountBps > 0n ? divideRoundHalfUp(cashSubtotalCents * (10_000n + cashDiscountBps), 10_000n) : cashSubtotalCents;
  const cashDiscountCents = 0n;
  const cardSurchargeCents = subtotalCents - cashSubtotalCents;
  const rawPromotionDiscountCents = (listPriceCents * BigInt(wholePacks * pack.packQuantityUnits)) - (pack.packPriceCents * BigInt(wholePacks));
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents: listPriceCents, finalPriceCents: subtotalCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, cardSurchargeCents, promotionDiscountCents,
    discountCents: cashDiscountCents + promotionDiscountCents
  };
}
