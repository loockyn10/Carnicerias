/**
 * EAN-13 de los paquetes envasados (puro, sin dependencias): armado del número según el esquema configurado por la organización, su LECTURA
 * (la que hace el POS al escanear) y el importe comercial. Compartido por el Admin (que imprime el código) y el POS (que lo lee): una sola regla.
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

/**
 * Importe comercial único (PRICE_EMBEDDED): el precio calculado con centavos, redondeado half-up a un múltiplo del divisor del valor (divisor 100 =
 * pesos enteros). Es el importe que se imprime, se embebe en el EAN, muestra el POS y se cobra. Replica `app_private.vacuum_commercial_total`
 * (202611070095). Con divisor 1 o con un esquema de peso devuelve el importe sin tocar.
 */
export function vacuumCommercialTotalCents(config: Pick<EanSchemeConfig, "scheme" | "valueStep"> | null, rawCents: bigint): bigint {
  if (config?.scheme !== "PRICE_EMBEDDED" || config.valueStep <= 1) return rawCents;
  const step = BigInt(config.valueStep);
  return ((rawCents + step / 2n) / step) * step;
}

export type VacuumEanReading =
  /** No es un código de Envasados: no tiene 13 dígitos, el dígito verificador no cierra o no empieza con el prefijo del esquema. */
  | { kind: "NOT_VACUUM" }
  | {
      kind: "VACUUM";
      /** PLU tal como viaja en el código (con ceros a la izquierda) y su valor numérico (sin ceros) para compararlo con el del producto. */
      plu: string;
      pluNumber: string;
      /** Valor embebido tal cual está en el código (antes de multiplicar por el divisor). */
      value: bigint;
      /** PRICE_EMBEDDED: importe en centavos (valor × divisor). null en un esquema de peso. */
      amountCents: bigint | null;
      /** WEIGHT_EMBEDDED: peso en gramos (valor × divisor). null en un esquema de precio. */
      weightGrams: bigint | null;
    };

/**
 * Lee un código escaneado con el esquema de Envasados. NO decide si el paquete existe (eso lo resuelve el registro): sólo reconoce que el código
 * está RESERVADO para Envasados (13 dígitos, verificador válido y prefijo del esquema) y extrae PLU y valor. Un código que no cumple las tres cosas
 * se interpreta como siempre (catálogo). Sin esquema (null) nada es de Envasados.
 */
/**
 * Un código que TIENE LA FORMA de un EAN de Envasados (13 dígitos y el prefijo del esquema) pero cuyo dígito verificador no cierra: una etiqueta
 * mal leída o dañada. Ningún EAN-13 comercial válido tiene un verificador incorrecto, así que tratarlo aparte nunca intercepta un código normal:
 * sólo evita que una mala lectura de un paquete termine dando de alta un producto.
 */
export function isMisreadVacuumEan13(config: EanSchemeConfig | null, scanned: string): boolean {
  if (!config || !isEanScheme(config.scheme) || validateEanSchemeConfig(config) !== null) return false;
  const code = scanned.trim();
  return /^\d{13}$/.test(code) && code.startsWith(config.prefix) && !isValidEan13(code);
}

export function readVacuumEan13(config: EanSchemeConfig | null, scanned: string): VacuumEanReading {
  if (!config || !isEanScheme(config.scheme) || validateEanSchemeConfig(config) !== null) return { kind: "NOT_VACUUM" };
  const code = scanned.trim();
  if (!isValidEan13(code) || !code.startsWith(config.prefix)) return { kind: "NOT_VACUUM" };
  const plu = code.slice(config.prefix.length, config.prefix.length + config.pluDigits);
  const value = BigInt(code.slice(config.prefix.length + config.pluDigits, 12));
  const scaled = value * BigInt(config.valueStep);
  return {
    kind: "VACUUM",
    plu,
    pluNumber: BigInt(plu).toString(),
    value,
    amountCents: config.scheme === "PRICE_EMBEDDED" ? scaled : null,
    weightGrams: config.scheme === "WEIGHT_EMBEDDED" ? scaled : null
  };
}
