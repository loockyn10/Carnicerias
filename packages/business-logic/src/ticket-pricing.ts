import { divideRoundHalfUp } from "./pricing";

/**
 * Pricing flexible del POS de Central (D-061): precio manual por línea y descuento porcentual del ticket.
 *
 * Orden vigente de una venta de Central (el motor de `pricing.ts` no cambia):
 *
 *   línea normal  : precio de lista -> promoción/pack -> recargo por tarjeta (D-044) -> subtotal de línea
 *   línea manual  : el precio que fijó el operador ES el precio final: sin promoción, sin recargo, sin
 *                   ajuste por medio de pago -> subtotal de línea
 *   ticket        : suma de subtotales de línea -> descuento general (% libre) -> TOTAL cobrado
 *
 * Todo en centavos enteros y basis points, redondeo half-up (`divideRoundHalfUp`); nunca floats.
 */

export interface ManualLinePricing {
  /** Precio normal (lista / efectivo) por kg o por unidad al momento de la venta. */
  listPriceCents: bigint;
  /** Precio por kg o por unidad que fijó el operador para esta línea de esta venta. */
  manualUnitPriceCents: bigint;
  /** Lo que habría costado la línea a precio normal. */
  listSubtotalCents: bigint;
  /** Lo que se cobra por la línea. */
  subtotalCents: bigint;
  /** `subtotal - listSubtotal`: negativo = rebaja, positivo = recargo manual. */
  manualAdjustmentCents: bigint;
}

/**
 * Precio manual de una línea `WEIGHT` (`quantityDivisor` 1000: gramos) o `UNIT` (`quantityDivisor` 1).
 * Es una decisión explícita: no consulta promociones ni medio de pago. Rechaza todo lo que luego la base
 * rechazaría (`sale_items.subtotal_cents > 0`): precio <= 0 o una línea que redondea a $0.
 */
export function calculateManualLinePricing(input: {
  listPriceCents: bigint;
  manualUnitPriceCents: bigint;
  quantity: number;
  quantityDivisor: 1 | 1_000;
}): ManualLinePricing {
  const { listPriceCents, manualUnitPriceCents, quantity, quantityDivisor } = input;
  if (listPriceCents <= 0n || manualUnitPriceCents <= 0n || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError("Invalid manual price or quantity");
  }
  const line = (price: bigint) => divideRoundHalfUp(price * BigInt(quantity), BigInt(quantityDivisor));
  const listSubtotalCents = line(listPriceCents);
  const subtotalCents = line(manualUnitPriceCents);
  if (subtotalCents <= 0n) throw new RangeError("Manual price leaves the line at $0");
  return { listPriceCents, manualUnitPriceCents, listSubtotalCents, subtotalCents, manualAdjustmentCents: subtotalCents - listSubtotalCents };
}

export const MAX_TICKET_DISCOUNT_BPS = 10_000n;

export type DiscountPercentParse =
  | { ok: true; bps: bigint }
  | { ok: false; message: string };

/**
 * Texto libre del input "Descuento %" -> basis points. Vacío = 0 (sin descuento). Acepta coma o punto
 * decimal y hasta 2 decimales (12,5 -> 1250 bps; 7,25 -> 725 bps); 0..100. Mientras se tipea, "5." o "5,"
 * son válidos (equivalen a 5). No usa floats.
 */
export function parseDiscountPercent(raw: string): DiscountPercentParse {
  const value = raw.trim();
  if (value === "") return { ok: true, bps: 0n };
  if (value.startsWith("-")) return { ok: false, message: "El descuento no puede ser negativo." };
  const match = /^(\d{1,3})(?:[.,](\d*))?$/.exec(value);
  if (!match) return { ok: false, message: "Escribí un porcentaje, por ejemplo 5 o 12,5." };
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { ok: false, message: "Usá hasta 2 decimales." };
  const bps = BigInt(match[1] ?? "0") * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (bps > MAX_TICKET_DISCOUNT_BPS) return { ok: false, message: "El descuento no puede superar el 100%." };
  return { ok: true, bps };
}

/** `1250n` -> `12,5`; `500n` -> `5`; `725n` -> `7,25` (para mostrar, es-AR). */
export function formatDiscountPercent(bps: bigint): string {
  const whole = bps / 100n;
  const fraction = bps % 100n;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(2, "0").replace(/0$/, "");
  return `${whole.toString()},${digits}`;
}

export interface TicketDiscount {
  subtotalCents: bigint;
  discountBps: bigint;
  /** Importe descontado (>= 0). */
  discountCents: bigint;
  /** Subtotal menos descuento: lo que realmente se cobra. */
  totalCents: bigint;
}

/**
 * Descuento general sobre el subtotal FINAL del ticket (ya con precios manuales, promociones y recargo por
 * tarjeta de cada línea). Redondeo half-up del importe descontado; el total es subtotal - descuento, así
 * que subtotal = total + descuento siempre, sin centavos huérfanos.
 */
export function calculateTicketDiscount(subtotalCents: bigint, discountBps: bigint): TicketDiscount {
  if (subtotalCents < 0n || discountBps < 0n || discountBps > MAX_TICKET_DISCOUNT_BPS) {
    throw new RangeError("Ticket subtotal or discount percentage is outside the allowed range");
  }
  const discountCents = divideRoundHalfUp(subtotalCents * discountBps, 10_000n);
  return { subtotalCents, discountBps, discountCents, totalCents: subtotalCents - discountCents };
}

/**
 * Reparte el descuento del ticket entre sus líneas, proporcional a su subtotal, por mayor resto (empate:
 * la línea de menor índice). La suma de lo asignado es EXACTAMENTE `discountCents` y ninguna línea
 * recibe más que su propio subtotal. Es la misma regla que aplica el servidor al guardar la venta
 * (`app_private.allocate_ticket_discount`): sirve para que Rentabilidad atribuya el ingreso real a cada
 * producto sin perder ni inventar centavos.
 */
export function allocateTicketDiscount(lineSubtotalsCents: readonly bigint[], discountCents: bigint): bigint[] {
  const total = lineSubtotalsCents.reduce((sum, value) => sum + value, 0n);
  if (discountCents < 0n || discountCents > total || lineSubtotalsCents.some((value) => value <= 0n)) {
    throw new RangeError("Ticket discount cannot be allocated");
  }
  if (discountCents === 0n) return lineSubtotalsCents.map(() => 0n);
  const shares = lineSubtotalsCents.map((value) => ({ share: (discountCents * value) / total, remainder: (discountCents * value) % total }));
  let leftover = discountCents - shares.reduce((sum, entry) => sum + entry.share, 0n);
  const order = shares.map((entry, index) => ({ index, remainder: entry.remainder }))
    .sort((left, right) => (left.remainder === right.remainder ? left.index - right.index : left.remainder < right.remainder ? 1 : -1));
  const allocated = shares.map((entry) => entry.share);
  for (const { index } of order) {
    if (leftover <= 0n) break;
    allocated[index] = (allocated[index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return allocated;
}
