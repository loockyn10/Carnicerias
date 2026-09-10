const ARS_INTEGER_FORMATTER = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const KG_FORMATTER = new Intl.NumberFormat("es-AR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});

/** Formats integer ARS cents without converting stored values to binary floating point. */
export function formatCurrency(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  const fractionText = fraction === 0n ? "" : `,${fraction.toString().padStart(2, "0")}`;

  return `${negative ? "-" : ""}$ ${ARS_INTEGER_FORMATTER.format(whole)}${fractionText}`;
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

/** Parses an operator-entered kilogram value (comma or dot decimal separator) into integer grams. */
export function parseWeightToGrams(input: string): number {
  const normalized = input.trim().replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(normalized);

  if (!match) {
    throw new RangeError("Weight must be expressed in kilograms with at most three decimals");
  }

  const kilograms = BigInt(match[1] ?? "0");
  const fractionalGrams = BigInt((match[2] ?? "").padEnd(3, "0"));
  const grams = kilograms * 1_000n + fractionalGrams;

  if (grams <= 0n || grams > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Weight must be a positive safe integer number of grams");
  }

  return Number(grams);
}

export function sumMoney(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
