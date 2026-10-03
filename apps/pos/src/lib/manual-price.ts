import { parsePesosToCents } from "./quick-product";

export type ManualPriceValidation = { ok: true; priceCents: bigint } | { ok: false; error: string };

/** El precio manual de una línea tiene que ser un importe válido y MAYOR a cero (nunca "0", vacío ni negativo). */
export function validateManualPrice(raw: string): ManualPriceValidation {
  if (raw.trim() === "") return { ok: false, error: "Escribí el precio" };
  if (raw.trim().startsWith("-")) return { ok: false, error: "El precio tiene que ser mayor a cero" };
  const priceCents = parsePesosToCents(raw);
  if (priceCents === null) return { ok: false, error: "Precio inválido" };
  if (priceCents <= 0n) return { ok: false, error: "El precio tiene que ser mayor a cero" };
  return { ok: true, priceCents };
}

/** Centavos -> texto editable del input (`1000000n` -> `10000`, `1050n` -> `10,50`). */
export function centsToPriceInput(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return fraction === 0n ? whole.toString() : `${whole.toString()},${fraction.toString().padStart(2, "0")}`;
}

/** El texto del descuento general sólo admite hasta 3 dígitos enteros y 2 decimales mientras se tipea. */
export function sanitizeDiscountInput(raw: string, previous: string): string {
  return /^\d{0,3}(?:[.,]\d{0,2})?$/.test(raw) ? raw : previous;
}
