/**
 * EAN-13 de los paquetes envasados (puro, sin dependencias, local: no hay servicio web ni librería externa de códigos de barras).
 * Hay DOS usos: el armado del número según el esquema configurado por la organización y su dibujo como barras.
 *
 * El armado replica `app_private.vacuum_build_ean` (migración 202611010093): el servidor es la fuente de verdad al registrar el paquete,
 * el navegador sólo lo usa para la vista previa. Ambos comparten los mismos vectores de prueba (vacuum-ean.test.ts y vacuum_packaging.test.sql).
 * NO existe un formato por defecto: sin esquema configurado `buildEan13` devuelve `{ ok: false, reason: "NOT_CONFIGURED" }`.
 */

export const EAN_SCHEMES = ["PRICE_EMBEDDED", "WEIGHT_EMBEDDED"] as const;
export type EanScheme = (typeof EAN_SCHEMES)[number];

export const EAN_SCHEME_LABELS: Record<EanScheme, string> = {
  PRICE_EMBEDDED: "Precio embebido en el código",
  WEIGHT_EMBEDDED: "Peso embebido en el código"
};

/** Esquema de armado del EAN-13: prefijo + PLU + valor variable = 12 dígitos; el 13.º es el verificador. */
export interface EanSchemeConfig {
  scheme: EanScheme;
  prefix: string;
  pluDigits: number;
  valueDigits: number;
  /** Divisor del valor embebido (1 = centavos o gramos; 100 = pesos enteros), con redondeo half-up. */
  valueStep: number;
}

export type EanBuildFailure = "NOT_CONFIGURED" | "INVALID_SCHEME" | "PLU_MISSING" | "PLU_TOO_LONG" | "VALUE_MISSING" | "VALUE_OVERFLOW";

export type EanBuildResult = { ok: true; ean13: string } | { ok: false; reason: EanBuildFailure; message: string };

export function isEanScheme(value: unknown): value is EanScheme {
  return typeof value === "string" && (EAN_SCHEMES as readonly string[]).includes(value);
}

/** Dígito verificador de los primeros 12 dígitos (pesos 1 y 3 alternados desde la izquierda). */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new RangeError("Se esperaban 12 dígitos para calcular el dígito verificador");
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(first12[index]) * (index % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** Un EAN-13 es válido si tiene 13 dígitos y el último es el verificador de los 12 anteriores. */
export function isValidEan13(value: string): boolean {
  return /^\d{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

/** Valida la configuración del esquema (la misma regla que `save_vacuum_ean_scheme`). Devuelve el problema en castellano o null. */
export function validateEanSchemeConfig(config: Pick<EanSchemeConfig, "prefix" | "pluDigits" | "valueDigits" | "valueStep">): string | null {
  if (!/^\d{1,6}$/.test(config.prefix)) return "El prefijo tiene que tener entre 1 y 6 dígitos";
  if (!Number.isInteger(config.pluDigits) || config.pluDigits < 1 || config.pluDigits > 8) return "Los dígitos del PLU van de 1 a 8";
  if (!Number.isInteger(config.valueDigits) || config.valueDigits < 1 || config.valueDigits > 8) return "Los dígitos del valor van de 1 a 8";
  const total = config.prefix.length + config.pluDigits + config.valueDigits;
  if (total !== 12) return `Prefijo + PLU + valor tienen que sumar 12 dígitos (el 13.º es el verificador); hoy suman ${String(total)}`;
  if (!Number.isInteger(config.valueStep) || config.valueStep < 1 || config.valueStep > 100_000) return "El divisor del valor es inválido";
  return null;
}

export interface EanInputs {
  /** PLU del producto (sólo dígitos). */
  plu: string | null;
  /** Importe final del paquete en centavos (esquema PRICE_EMBEDDED). */
  priceCents: bigint;
  /** Peso neto en gramos (esquema WEIGHT_EMBEDDED). */
  weightGrams: number;
}

/**
 * Arma el EAN-13: prefijo + PLU (ceros a la izquierda) + valor embebido (precio en centavos o peso en gramos ÷ divisor, half-up) + verificador.
 * Si algo no entra en los dígitos configurados se rechaza: nunca se trunca ni se inventa un formato.
 */
export function buildEan13(config: EanSchemeConfig | null, inputs: EanInputs): EanBuildResult {
  if (!config) return { ok: false, reason: "NOT_CONFIGURED", message: "Falta configurar el esquema EAN-13 de envasados" };
  if (!isEanScheme(config.scheme) || validateEanSchemeConfig(config) !== null) return { ok: false, reason: "INVALID_SCHEME", message: "El esquema EAN-13 configurado es inválido" };
  if (!inputs.plu || !/^\d+$/.test(inputs.plu)) return { ok: false, reason: "PLU_MISSING", message: "El producto no tiene un PLU numérico para el código EAN-13" };
  if (inputs.plu.length > config.pluDigits) return { ok: false, reason: "PLU_TOO_LONG", message: `El PLU ${inputs.plu} no entra en ${String(config.pluDigits)} dígitos` };
  const raw = config.scheme === "PRICE_EMBEDDED" ? inputs.priceCents : BigInt(inputs.weightGrams);
  if (raw < 0n) return { ok: false, reason: "VALUE_MISSING", message: "Falta el valor a embeber en el EAN-13" };
  const step = BigInt(config.valueStep);
  const value = (raw + step / 2n) / step;
  if (value.toString().length > config.valueDigits) {
    return { ok: false, reason: "VALUE_OVERFLOW", message: `El valor ${value.toString()} no entra en ${String(config.valueDigits)} dígitos del EAN-13` };
  }
  const first12 = config.prefix + inputs.plu.padStart(config.pluDigits, "0") + value.toString().padStart(config.valueDigits, "0");
  return { ok: true, ean13: first12 + String(ean13CheckDigit(first12)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Barras
// ---------------------------------------------------------------------------------------------------------------------

const L_CODES = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"] as const;
const complement = (bits: string) => Array.from(bits, (bit) => (bit === "0" ? "1" : "0")).join("");
const reverse = (bits: string) => Array.from(bits).reverse().join("");
/** R = complemento de L; G = R invertido (definición del estándar; la prueba decodifica las barras para verificar las tres tablas). */
const R_CODES = L_CODES.map(complement);
const G_CODES = R_CODES.map(reverse);
/** Paridad (L/G) de los 6 dígitos de la izquierda según el primer dígito del código. */
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"] as const;

const START_END = "101";
const CENTER = "01010";

/** Los 95 módulos del EAN-13 ("1" = barra, "0" = espacio). Lanza si el código no es un EAN-13 válido. */
export function ean13Modules(ean13: string): string {
  if (!isValidEan13(ean13)) throw new RangeError("EAN-13 inválido: no se puede dibujar");
  const digits = Array.from(ean13, Number);
  const parity = PARITY[digits[0] ?? 0] ?? "LLLLLL";
  let bits = START_END;
  for (let index = 0; index < 6; index += 1) {
    const digit = digits[index + 1] ?? 0;
    bits += (parity[index] === "L" ? L_CODES[digit] : G_CODES[digit]) ?? "";
  }
  bits += CENTER;
  for (let index = 7; index < 13; index += 1) bits += R_CODES[digits[index] ?? 0] ?? "";
  return bits + START_END;
}

export interface BarRun {
  /** Posición del primer módulo de la barra (0 = primer módulo del código) y ancho en módulos. */
  start: number;
  width: number;
}

/** Agrupa módulos consecutivos en barras (menos rectángulos que dibujar). */
export function modulesToRuns(modules: string): BarRun[] {
  const runs: BarRun[] = [];
  let start = -1;
  for (let index = 0; index <= modules.length; index += 1) {
    const black = modules[index] === "1";
    if (black && start < 0) start = index;
    if (!black && start >= 0) { runs.push({ start, width: index - start }); start = -1; }
  }
  return runs;
}

/** Decodifica los 95 módulos de vuelta a los 13 dígitos (se usa en las pruebas para verificar el dibujo, no al imprimir). */
export function decodeEan13Modules(modules: string): string {
  if (modules.length !== 95 || !modules.startsWith(START_END) || !modules.endsWith(START_END) || modules.slice(45, 50) !== CENTER) {
    throw new RangeError("Barras EAN-13 inválidas");
  }
  const left = modules.slice(3, 45);
  const right = modules.slice(50, 92);
  let parity = "";
  let digits = "";
  for (let index = 0; index < 6; index += 1) {
    const chunk = left.slice(index * 7, index * 7 + 7);
    const l = L_CODES.findIndex((code) => code === chunk);
    const g = G_CODES.findIndex((code) => code === chunk);
    if (l >= 0) { parity += "L"; digits += String(l); } else if (g >= 0) { parity += "G"; digits += String(g); } else throw new RangeError("Dígito izquierdo ilegible");
  }
  const first = PARITY.findIndex((pattern) => pattern === parity);
  if (first < 0) throw new RangeError("Paridad inválida");
  for (let index = 0; index < 6; index += 1) {
    const chunk = right.slice(index * 7, index * 7 + 7);
    const r = R_CODES.findIndex((code) => code === chunk);
    if (r < 0) throw new RangeError("Dígito derecho ilegible");
    digits += String(r);
  }
  return String(first) + digits;
}

export const EAN13_MODULE_COUNT = 95;
