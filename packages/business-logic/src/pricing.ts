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
