/**
 * Lectura defensiva del JSON que devuelven las RPC de Pollos y Envasados (`Returns: Json`): el servidor es de confianza pero el tipo no lo
 * es, y los importes en centavos viajan como TEXTO (bigint) para no perder precisión. Cada pantalla parsea una sola vez, acá, y de ahí
 * en más trabaja con tipos fuertes.
 */

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function int(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return fallback;
}

export function intOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

/** Importe en centavos (viaja como texto de un bigint). */
export function cents(value: unknown): bigint {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return 0n;
}

export function centsOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}
