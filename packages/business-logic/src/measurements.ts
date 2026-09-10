const ARS_FORMATTER = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const KG_FORMATTER = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});

/** Formats integer cents without converting stored values to binary floating point. */
export function formatCurrency(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return ARS_FORMATTER.format(Number(whole) + Number(fraction) / 100);
}

/** Formats an integer gram quantity for the operator-facing kilogram UI. */
export function formatWeight(grams: number): string {
  if (!Number.isSafeInteger(grams)) {
    throw new RangeError("Weight must be a safe integer number of grams");
  }

  return `${KG_FORMATTER.format(grams / 1_000)} kg`;
}

/**
 * Calculates cents for a weight sale. Half-cent results round away from zero.
 * The price is expressed per kilogram and the quantity as integer grams.
 */
export function priceForWeight(pricePerKgCents: bigint, grams: number): bigint {
  if (pricePerKgCents < 0n || !Number.isSafeInteger(grams) || grams < 0) {
    throw new RangeError("Price and weight must be non-negative integers");
  }

  return (pricePerKgCents * BigInt(grams) + 500n) / 1_000n;
}

