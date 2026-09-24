// Pure FormData/string parsing helpers shared by admin Server Actions. Kept in a plain
// module (not "use server") so they can be imported by both actions.ts (which, being a
// Server Actions file, may only export async functions) and by pure, unit-testable
// helpers like weight-discount-args.ts.

export function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function optionalId(formData: FormData, key: string) {
  return text(formData, key) || null;
}

export function ids(formData: FormData, key: string) {
  return formData.getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function decimal(value: string, label: string) {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`${label} inválido`);
  return parsed;
}

export function kilogramsToGrams(value: string, allowZero = false) {
  const match = /^(\d+)(?:[,.](\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new Error("Peso inválido");
  const grams = BigInt(match[1] ?? "") * 1_000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (grams < 0n || (!allowZero && grams === 0n) || grams > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Peso inválido");
  return Number(grams);
}

export function unitsToInteger(value: string) {
  if (!/^\d+$/.test(value.trim())) throw new Error("Cantidad de unidades inválida");
  const units = BigInt(value.trim());
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Cantidad de unidades inválida");
  return Number(units);
}

export function pesosToCents(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Precio inválido");
  const cents = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Precio inválido");
  return Number(cents);
}

export function percentageToBasisPoints(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Descuento inválido");
  const basisPoints = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints <= 0n || basisPoints > 10_000n) throw new Error("El descuento debe estar entre 0,01% y 100%");
  return Number(basisPoints);
}

export function percentageToBasisPointsAllowZero(value: string, label: string, maximumBps: bigint) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`${label} inválido`);
  const basisPoints = BigInt(match[1] ?? "") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (basisPoints < 0n || basisPoints > maximumBps) throw new Error(`${label} fuera del rango permitido`);
  return Number(basisPoints);
}
