import { isScaleProtocol, KRETZ_SERIAL_PARAMS, SERIAL_BAUD_RATES, type ScaleProtocol, type SerialLineParams } from "@carnicerias/business-logic";

import type { VacuumLabelDims } from "../vacuum-label-spec";
import { DEFAULT_STATION_TUNING, type StationTuning } from "./machine";

/**
 * Configuración PERSISTENTE de la estación, por dispositivo (localStorage del navegador de esa computadora). Es deliberadamente distinta de la
 * configuración comercial de Envasados (esquema EAN, medidas de etiqueta, cortes, vida útil), que vive en la base y es de toda la organización: acá sólo
 * van cosas de ESTA balanza y ESTA impresora. Todo lo que se lee se normaliza (límites, tipos): un valor corrupto o viejo nunca rompe la estación.
 */

export const STATION_CONFIG_VERSION = 1;
export const STATION_CONFIG_KEY = `vacuum-station:v${String(STATION_CONFIG_VERSION)}`;

export type LabelRotation = 0 | 90 | 180 | 270;
export const LABEL_ROTATIONS: readonly LabelRotation[] = [0, 90, 180, 270];

export type StationPrintKind = "BOTH" | "INFO" | "PRICE";

export interface UsbPortId {
  usbVendorId: number;
  usbProductId: number;
}

export interface StationConfig {
  version: typeof STATION_CONFIG_VERSION;
  /** Sucursal donde se registran los paquetes de esta estación (null = la de producción de la organización). */
  branchId: string | null;
  scale: {
    protocol: ScaleProtocol;
    params: SerialLineParams;
    /** Volver a conectar solo cuando el navegador lo permita (puerto ya autorizado). */
    autoReconnect: boolean;
    /** Identificación USB del puerto elegido: Web Serial no permite guardar el puerto en sí, sólo reencontrarlo entre los ya autorizados. */
    port: UsbPortId | null;
  };
  tuning: StationTuning;
  print: {
    /** Imprimir las etiquetas solas al registrar. Sólo puede estar activa si la prueba de impresión vigente salió bien. */
    auto: boolean;
    kind: StationPrintKind;
    /** Giro del contenido de la etiqueta (calibración de orientación): el controlador de la impresora decide cómo entra el papel. */
    rotation: LabelRotation;
    /** Firma de medidas + giro con los que se aprobó la prueba de impresión; si cambian, la prueba deja de valer. */
    testPassedSignature: string | null;
    testPassedAt: string | null;
  };
  /** Cortes favoritos de ESTA estación (ids de producto). */
  favorites: string[];
}

export const DEFAULT_STATION_CONFIG: StationConfig = {
  version: STATION_CONFIG_VERSION,
  branchId: null,
  scale: { protocol: "KRETZ_STX_CR", params: KRETZ_SERIAL_PARAMS, autoReconnect: true, port: null },
  tuning: DEFAULT_STATION_TUNING,
  print: { auto: false, kind: "BOTH", rotation: 0, testPassedSignature: null, testPassedAt: null },
  favorites: []
};

/** Límites de cada parámetro de afinado (los que valida la pantalla y los que se aplican al leer). */
export const STATION_TUNING_LIMITS: Record<keyof StationTuning, { min: number; max: number; unit: string; label: string }> = {
  stableMs: { min: 300, max: 5_000, unit: "ms", label: "Tiempo de peso estable" },
  toleranceGrams: { min: 1, max: 50, unit: "g", label: "Tolerancia de estabilidad" },
  minWeightGrams: { min: 5, max: 2_000, unit: "g", label: "Peso mínimo" },
  zeroToleranceGrams: { min: 0, max: 100, unit: "g", label: "Tolerancia de retorno a cero" },
  zeroHoldMs: { min: 200, max: 5_000, unit: "ms", label: "Tiempo en cero para dar por retirado" },
  maxGapMs: { min: 500, max: 10_000, unit: "ms", label: "Silencio máximo entre lecturas" },
  tareGrams: { min: 0, max: 5_000, unit: "g", label: "Tara" }
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeTuning(raw: unknown): StationTuning {
  const source = record(raw);
  const next = { ...DEFAULT_STATION_TUNING };
  for (const key of Object.keys(STATION_TUNING_LIMITS) as (keyof StationTuning)[]) {
    const limits = STATION_TUNING_LIMITS[key];
    next[key] = clampInt(source[key], DEFAULT_STATION_TUNING[key], limits.min, limits.max);
  }
  // Coherencia: el peso mínimo tiene que estar por encima del ruido de «cero», y la tara no puede dejar el mínimo fuera de alcance de cualquier paquete.
  if (next.minWeightGrams <= next.zeroToleranceGrams) next.minWeightGrams = next.zeroToleranceGrams + 1;
  return next;
}

export function normalizeSerialParams(raw: unknown): SerialLineParams {
  const source = record(raw);
  const baud = typeof source.baudRate === "number" && (SERIAL_BAUD_RATES as readonly number[]).includes(source.baudRate) ? source.baudRate : KRETZ_SERIAL_PARAMS.baudRate;
  return {
    baudRate: baud,
    dataBits: source.dataBits === 7 ? 7 : 8,
    stopBits: source.stopBits === 1 ? 1 : 2,
    parity: source.parity === "even" || source.parity === "odd" ? source.parity : "none"
  };
}

function usbPort(raw: unknown): UsbPortId | null {
  const source = record(raw);
  const vendor = source.usbVendorId;
  const product = source.usbProductId;
  if (typeof vendor === "number" && Number.isInteger(vendor) && vendor >= 0 && typeof product === "number" && Number.isInteger(product) && product >= 0) {
    return { usbVendorId: vendor, usbProductId: product };
  }
  return null;
}

export function normalizeStationConfig(raw: unknown): StationConfig {
  const source = record(raw);
  const scale = record(source.scale);
  const print = record(source.print);
  const rotation = LABEL_ROTATIONS.find((candidate) => candidate === print.rotation) ?? 0;
  const kind: StationPrintKind = print.kind === "INFO" || print.kind === "PRICE" ? print.kind : "BOTH";
  const favorites = Array.isArray(source.favorites) ? source.favorites.filter((entry): entry is string => typeof entry === "string").slice(0, 60) : [];
  const signature = typeof print.testPassedSignature === "string" && print.testPassedSignature !== "" ? print.testPassedSignature : null;
  return {
    version: STATION_CONFIG_VERSION,
    branchId: typeof source.branchId === "string" && source.branchId !== "" ? source.branchId : null,
    scale: {
      protocol: isScaleProtocol(scale.protocol) ? scale.protocol : DEFAULT_STATION_CONFIG.scale.protocol,
      params: normalizeSerialParams(scale.params),
      autoReconnect: scale.autoReconnect !== false,
      port: usbPort(scale.port)
    },
    tuning: normalizeTuning(source.tuning),
    print: {
      auto: print.auto === true && signature !== null,
      kind, rotation, testPassedSignature: signature,
      testPassedAt: typeof print.testPassedAt === "string" ? print.testPassedAt : null
    },
    favorites: [...new Set(favorites)]
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Prueba de impresión: la impresión automática sólo se habilita con una prueba aprobada para las medidas y el giro VIGENTES
// ---------------------------------------------------------------------------------------------------------------------

export function printSignature(dims: VacuumLabelDims, rotation: LabelRotation): string {
  return `${String(dims.widthMm)}x${String(dims.infoHeightMm)}x${String(dims.priceHeightMm)}@${String(rotation)}`;
}

/** ¿La prueba de impresión guardada sigue valiendo para las medidas y el giro actuales? */
export function isPrintTestCurrent(config: StationConfig, dims: VacuumLabelDims): boolean {
  return config.print.testPassedSignature !== null && config.print.testPassedSignature === printSignature(dims, config.print.rotation);
}

/** La impresión automática está efectivamente habilitada: elegida Y con una prueba vigente. */
export function isAutoPrintEnabled(config: StationConfig, dims: VacuumLabelDims): boolean {
  return config.print.auto && isPrintTestCurrent(config, dims);
}

/** El operario confirmó que la etiqueta de prueba salió bien (medidas, giro, márgenes): se guarda la firma vigente. */
export function approvePrintTest(config: StationConfig, dims: VacuumLabelDims, nowIso: string): StationConfig {
  return { ...config, print: { ...config.print, testPassedSignature: printSignature(dims, config.print.rotation), testPassedAt: nowIso } };
}

/** Activa o desactiva la impresión automática; sin una prueba vigente no se puede activar. */
export function setAutoPrint(config: StationConfig, dims: VacuumLabelDims, auto: boolean): StationConfig {
  return { ...config, print: { ...config.print, auto: auto && isPrintTestCurrent(config, dims) } };
}

/** Cambiar el giro invalida la prueba anterior (y apaga la impresión automática hasta repetirla). */
export function setRotation(config: StationConfig, rotation: LabelRotation): StationConfig {
  const changed = rotation !== config.print.rotation;
  return { ...config, print: { ...config.print, rotation, ...(changed ? { auto: false, testPassedSignature: null, testPassedAt: null } : {}) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Almacenamiento (siempre defensivo: puede no existir, estar bloqueado o venir vacío)
// ---------------------------------------------------------------------------------------------------------------------

export interface StationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadStationConfig(storage: StationStorage | null): StationConfig {
  if (storage === null) return DEFAULT_STATION_CONFIG;
  try {
    const raw = storage.getItem(STATION_CONFIG_KEY);
    return raw === null ? DEFAULT_STATION_CONFIG : normalizeStationConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_STATION_CONFIG;
  }
}

/** Devuelve false si no se pudo guardar (el navegador bloqueó el almacenamiento): la pantalla lo avisa y sigue funcionando con lo que tiene en memoria. */
export function saveStationConfig(storage: StationStorage | null, config: StationConfig): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(STATION_CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

export function browserStorage(): StationStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
