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

export function isDiscountEligiblePaymentMethod(method: PaymentMethod): boolean {
  return method !== "DEBIT" && method !== "CREDIT";
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

/** Recalculates from the immutable list price every time; discounts never accumulate. */
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
  const cashDiscountBps = isDiscountEligiblePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const cashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n - cashDiscountBps), 10_000n);
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
  const cashDiscountCents = listSubtotalCents - cashSubtotalCents;
  const promotionDiscountCents = cashSubtotalCents - subtotalCents;
  return {
    listPriceCents, cashPriceCents, finalPriceCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, promotionDiscountCents,
    discountCents: cashDiscountCents + promotionDiscountCents
  };
}

/**
 * PACK_FIXED_TOTAL on a WEIGHT product (e.g. "Vacío: 2kg por $18.000"): a real
 * pre-cut piece never weighs the nominal pack amount exactly, so the pack
 * charges its configured total regardless of the actual weighed grams — the
 * weight is still what feeds stock. This is intentionally NOT a threshold: it
 * never scales with quantity. Only sanity-checked against the LIST price for
 * the weighed amount (never against the cash-discounted price), so it can
 * never be a worse deal than buying that same piece unweighted at full list
 * price — in practice this never triggers for a real pack's natural weight
 * variance. Mirrors complete_discounted_sale's PACK_FIXED_TOTAL branch
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
  const { listPriceCents, weightGrams, paymentMethod, packPriceCents } = input;
  if (listPriceCents <= 0n || !Number.isSafeInteger(weightGrams) || weightGrams <= 0) {
    throw new RangeError("Invalid sale quantity or price");
  }
  if (packPriceCents <= 0n) throw new RangeError("Invalid pack price");
  validateBasisPoints(input.cashDiscountBps);
  const cashDiscountBps = isDiscountEligiblePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const cashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n - cashDiscountBps), 10_000n);
  const listSubtotalCents = divideRoundHalfUp(listPriceCents * BigInt(weightGrams), 1_000n);
  if (packPriceCents > listSubtotalCents) {
    throw new RangeError("Pack price exceeds list price for the weighed amount");
  }
  const cashSubtotalCents = divideRoundHalfUp(cashPriceCents * BigInt(weightGrams), 1_000n);
  const subtotalCents = packPriceCents;
  const finalPriceCents = divideRoundHalfUp(subtotalCents * 1_000n, BigInt(weightGrams));
  const cashDiscountCents = listSubtotalCents - cashSubtotalCents;
  const rawPromotionDiscountCents = cashSubtotalCents - subtotalCents;
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents, finalPriceCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, promotionDiscountCents,
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
 * at the normal (cash-discounted) per-unit price — never a partial/invented
 * discount for the remainder. Not wired into the POS sale flow yet (POS does
 * not sell UNIT products at all — see docs/TASKS.md); kept as a pure,
 * independently tested function ready for when that ships.
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
  const cashDiscountBps = isDiscountEligiblePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const cashPriceCents = divideRoundHalfUp(listPriceCents * (10_000n - cashDiscountBps), 10_000n);
  const wholePacks = Math.floor(quantityUnits / pack.packQuantityUnits);
  const remainderUnits = quantityUnits - wholePacks * pack.packQuantityUnits;
  const listSubtotalCents = listPriceCents * BigInt(quantityUnits);
  const cashSubtotalCents = cashPriceCents * BigInt(quantityUnits);
  const subtotalCents = pack.packPriceCents * BigInt(wholePacks) + cashPriceCents * BigInt(remainderUnits);
  const cashDiscountCents = listSubtotalCents - cashSubtotalCents;
  const rawPromotionDiscountCents = cashSubtotalCents - subtotalCents;
  const promotionDiscountCents = rawPromotionDiscountCents > 0n ? rawPromotionDiscountCents : 0n;
  return {
    listPriceCents, cashPriceCents, finalPriceCents: subtotalCents, listSubtotalCents, cashSubtotalCents,
    subtotalCents, cashDiscountBps, cashDiscountCents, promotionDiscountCents,
    discountCents: listSubtotalCents - subtotalCents
  };
}
