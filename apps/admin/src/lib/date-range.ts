/**
 * Rango de fechas del filtro de ventas de Sucursales.
 *
 * Todo son DÍAS CALENDARIO de la organización ("YYYY-MM-DD" en su zona horaria): el navegador y el
 * servidor de Next nunca deciden qué es "hoy" en UTC. El servidor SQL (`get_branch_sales_summary`)
 * convierte esas fechas a instantes con la misma zona de la organización.
 */

export type SalesRangePreset = "today" | "yesterday" | "7d" | "30d";

export const SALES_RANGE_PRESETS: readonly { key: SalesRangePreset; label: string }[] = [
  { key: "today", label: "Hoy" },
  { key: "yesterday", label: "Ayer" },
  { key: "7d", label: "7 días" },
  { key: "30d", label: "30 días" }
];

/** Mismo tope que `get_branch_sales_summary`. */
export const MAX_RANGE_DAYS = 366;

export interface SalesRange {
  from: string;
  to: string;
  /** El preset cuyo rango coincide exactamente con from/to, o "custom". */
  preset: SalesRangePreset | "custom";
}

export interface ResolvedSalesRange extends SalesRange {
  /** Mensaje para el usuario cuando lo pedido era inválido (el rango devuelto es "hoy"). */
  error?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

/** "Hoy" como fecha calendario de la zona horaria dada (nunca la fecha UTC). */
export function localDateString(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Suma días a una fecha calendario. Opera al mediodía UTC: ningún cambio horario la corre de día. */
export function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Cantidad de días del rango, inclusivos ambos extremos. */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

function presetRange(preset: SalesRangePreset, today: string): { from: string; to: string } {
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const day = shiftIsoDate(today, -1); return { from: day, to: day }; }
    case "7d": return { from: shiftIsoDate(today, -6), to: today };
    case "30d": return { from: shiftIsoDate(today, -29), to: today };
  }
}

function matchingPreset(from: string, to: string, today: string): SalesRange["preset"] {
  return SALES_RANGE_PRESETS.find(({ key }) => {
    const range = presetRange(key, today);
    return range.from === from && range.to === to;
  })?.key ?? "custom";
}

const isPreset = (value: string): value is SalesRangePreset => SALES_RANGE_PRESETS.some(({ key }) => key === value);

/**
 * Interpreta los parámetros de la URL. Un preset gana sobre Desde/Hasta (los botones de preset viajan
 * en el mismo formulario que las fechas ya cargadas). Sin nada → hoy. Un rango inválido no rompe la
 * pantalla: vuelve a "hoy" y devuelve `error`.
 */
export function resolveSalesRange(
  input: { preset?: string | undefined; from?: string | undefined; to?: string | undefined },
  timeZone: string,
  now: Date = new Date()
): ResolvedSalesRange {
  const today = localDateString(timeZone, now);
  const fallback = (error?: string): ResolvedSalesRange => ({ from: today, to: today, preset: "today", ...(error ? { error } : {}) });
  const preset = (input.preset ?? "").trim();
  if (preset) {
    if (!isPreset(preset)) return fallback("El período elegido no es válido.");
    const range = presetRange(preset, today);
    return { ...range, preset };
  }
  const from = (input.from ?? "").trim();
  const to = (input.to ?? "").trim();
  if (!from && !to) return fallback();
  if (!from || !to) return fallback("Elegí las dos fechas: Desde y Hasta.");
  if (!isIsoDate(from) || !isIsoDate(to)) return fallback("Alguna de las fechas no es válida.");
  if (from > to) return fallback("La fecha Desde no puede ser posterior a Hasta.");
  if (rangeDays(from, to) > MAX_RANGE_DAYS) return fallback(`El rango no puede superar ${String(MAX_RANGE_DAYS)} días.`);
  return { from, to, preset: matchingPreset(from, to, today) };
}

/** dd/mm/aaaa */
export function formatIsoDate(iso: string): string {
  const [year = "", month = "", day = ""] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** dd/mm/aaaa HH:mm en la zona horaria de la organización (24 h). */
export function formatLocalDateTime(instant: string | Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return `${String(parts.day)}/${String(parts.month)}/${String(parts.year)} ${String(parts.hour)}:${String(parts.minute)}`;
}

/** Cómo se llama el período en los títulos de las métricas ("Ventas hoy", "Ventas 7 días"…). */
export function periodLabel(range: SalesRange): string {
  switch (range.preset) {
    case "today": return "hoy";
    case "yesterday": return "ayer";
    case "7d": return "7 días";
    case "30d": return "30 días";
    case "custom": return range.from === range.to ? formatIsoDate(range.from) : `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
  }
}

/** Contra qué se compara: el período inmediatamente anterior de la misma cantidad de días. */
export function comparisonLabel(range: SalesRange): string {
  if (range.from !== range.to) return "período anterior";
  if (range.preset === "today") return "ayer";
  if (range.preset === "yesterday") return "anteayer";
  return "día anterior";
}

/** Query string que conserva el rango al navegar a otra pantalla. */
export function rangeQuery(range: SalesRange): string {
  return `from=${range.from}&to=${range.to}`;
}
