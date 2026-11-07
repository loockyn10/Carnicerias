/**
 * EAN-13 de los paquetes envasados en el Admin: el armado y la lectura del número viven en `@carnicerias/business-logic` (el POS usa la misma regla);
 * acá queda su dibujo como barras (local: no hay servicio web ni librería externa de códigos de barras).
 *
 * El armado replica `app_private.vacuum_build_ean` (migración 202611010093): el servidor es la fuente de verdad al registrar el paquete,
 * el navegador sólo lo usa para la vista previa. Ambos comparten los mismos vectores de prueba (vacuum-ean.test.ts y vacuum_packaging.test.sql).
 * NO existe un formato por defecto: sin esquema configurado `buildEan13` devuelve `{ ok: false, reason: "NOT_CONFIGURED" }`.
 */

import { isValidEan13 } from "@carnicerias/business-logic";

export {
  buildEan13, EAN_SCHEME_LABELS, EAN_SCHEMES, ean13CheckDigit, isEanScheme, isValidEan13, readVacuumEan13, validateEanSchemeConfig, vacuumCommercialTotalCents
} from "@carnicerias/business-logic";
export type { EanBuildFailure, EanBuildResult, EanInputs, EanScheme, EanSchemeConfig, VacuumEanReading } from "@carnicerias/business-logic";

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
