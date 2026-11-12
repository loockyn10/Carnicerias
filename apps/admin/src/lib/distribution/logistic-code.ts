/**
 * Identificador LOGÍSTICO de un paquete (distinto del EAN-13 comercial, que sólo sirve para cobrar): 9 caracteres del alfabeto de Crockford (sin I, L, O, U) =
 * 8 aleatorios + 1 de control. Lo genera la base (`app_private.logistic_code_generate`, único por organización, vinculado 1 a 1 al UUID del paquete); acá está la
 * MISMA lectura (normalizar, validar el control, mostrar con guiones) para escanear y tipear sin errores. Los vectores de prueba son los mismos que los de
 * `supabase/tests/vacuum_distribution.test.sql`.
 */

export const LOGISTIC_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EAN13_RE = /^[0-9]{13}$/;

/** Mayúsculas, sin espacios ni guiones y con los caracteres parecidos unificados (O→0, I y L→1), como la base. */
export function normalizeLogisticCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Carácter de control de los 8 primeros: suma ponderada (1…8) módulo 31. */
export function logisticCheckChar(body: string): string {
  if (!BODY_RE.test(body)) throw new RangeError("Se esperaban 8 caracteres del alfabeto logístico");
  let sum = 0;
  for (let index = 0; index < 8; index += 1) sum += LOGISTIC_ALPHABET.indexOf(body.charAt(index)) * (index + 1);
  return LOGISTIC_ALPHABET.charAt(sum % 31);
}

export function isValidLogisticCode(code: string): boolean {
  return CODE_RE.test(code) && code.charAt(8) === logisticCheckChar(code.slice(0, 8));
}

/** «7K3M9QX4S» → «7K3M-9QX4-S» (sólo para mostrar; lo que se codifica y se busca es el código sin guiones). */
export function formatLogisticCode(code: string): string {
  return CODE_RE.test(code) ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;
}

export type ScannedIdentifier =
  | { kind: "LOGISTIC"; code: string }
  | { kind: "UUID"; id: string }
  | { kind: "COMMERCIAL_EAN"; ean13: string }
  | { kind: "INVALID"; message: string };

/**
 * Qué es lo que se escaneó o tipeó. Un EAN-13 (13 dígitos) es el código COMERCIAL: dos paquetes pueden compartirlo, así que NUNCA identifica un paquete y no se
 * acepta para entregas, devoluciones ni conciliación.
 */
export function parseScannedIdentifier(raw: string): ScannedIdentifier {
  const text = raw.trim();
  if (text === "") return { kind: "INVALID", message: "Escaneá o ingresá el código" };
  if (UUID_RE.test(text)) return { kind: "UUID", id: text.toLowerCase() };
  if (EAN13_RE.test(text)) return { kind: "COMMERCIAL_EAN", ean13: text };
  const code = normalizeLogisticCode(text);
  if (!isValidLogisticCode(code)) return { kind: "INVALID", message: "El código no es un identificador logístico válido (revisá que esté completo)" };
  return { kind: "LOGISTIC", code };
}
