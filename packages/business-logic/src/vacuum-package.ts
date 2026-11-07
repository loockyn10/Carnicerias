import type { PaymentMethod } from "@carnicerias/types";

import { divideRoundHalfUp, isCardSurchargePaymentMethod, validateBasisPoints, type SalePricing } from "./pricing";

/**
 * Línea de venta PACKAGE (paquete envasado al vacío): el importe del paquete es FIJO. Nunca se recalcula precio/kg × peso: el precio/kg pudo
 * cambiar desde que se envasó y lo que está impreso en la etiqueta y embebido en el EAN es el importe del paquete.
 *
 * Lo único que puede sumarse es el recargo de tarjeta (DEBIT/CREDIT, D-044), una sola vez sobre el importe completo y redondeado half-up, igual que el
 * Pack por peso. No recibe promociones, descuentos por cantidad, Pack ni precio manual. Replica `sync_vacuum_package_line` (202611070095) y el
 * `insert_sale` de Rust, que validan el mismo cálculo.
 *
 * `listPriceCents`/`finalPriceCents` son precios por kg DERIVADOS (importe × 1000 / gramos) sólo para mostrar/reportar: la verdad es el importe.
 */
export function calculateVacuumPackagePricing(input: {
  fixedTotalCents: bigint;
  weightGrams: number;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): SalePricing {
  const { fixedTotalCents, weightGrams, paymentMethod } = input;
  if (fixedTotalCents <= 0n || !Number.isSafeInteger(weightGrams) || weightGrams <= 0) throw new RangeError("Invalid vacuum package amount or weight");
  validateBasisPoints(input.cashDiscountBps);
  const cashDiscountBps = isCardSurchargePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const subtotalCents = cashDiscountBps > 0n ? divideRoundHalfUp(fixedTotalCents * (10_000n + cashDiscountBps), 10_000n) : fixedTotalCents;
  const listPriceCents = divideRoundHalfUp(fixedTotalCents * 1_000n, BigInt(weightGrams));
  return {
    listPriceCents,
    cashPriceCents: listPriceCents,
    finalPriceCents: divideRoundHalfUp(subtotalCents * 1_000n, BigInt(weightGrams)),
    listSubtotalCents: fixedTotalCents,
    cashSubtotalCents: fixedTotalCents,
    subtotalCents,
    cashDiscountBps,
    cashDiscountCents: 0n,
    cardSurchargeCents: subtotalCents - fixedTotalCents,
    promotionDiscountCents: 0n,
    discountCents: 0n
  };
}
