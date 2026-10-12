import { clampSlideSeconds, DEFAULT_SLIDE_SECONDS } from "./signage";

/**
 * Pantallas de TV tal como las muestra Cartelería → Pantallas TV (D-086): cada una con su FUENTE de contenido («todas las promociones
 * activas» o una carpeta), cuántas ofertas reproduce HOY y qué conviene mirar. Puro: de lo que entrega `get_signage_displays_overview`
 * (que usa el mismo payload que el televisor) a texto en lenguaje simple. Ninguna oferta se carga a mano: salen de Promociones.
 */

export type ContentSource = "ALL_PROMOTIONS" | "FOLDER" | "MANUAL";

export interface DisplayOverview {
  id: string;
  name: string;
  enabled: boolean;
  branchId: string | null;
  branchName: string | null;
  slideDurationSeconds: number;
  contentSource: ContentSource;
  folderId: string | null;
  folderName: string | null;
  tokenRotatedAt: string;
  /** Ofertas que se reproducen hoy. */
  playable: number;
  /** Ofertas de la fuente que HOY no se reproducen (producto inactivo, sin precio, promoción vencida…). */
  blocked: number;
  /** De las que se reproducen, cuántas no tienen foto comercial (se dibuja un reemplazo). */
  withoutPhoto: number;
  /** Elementos de la lista anterior (hecha a mano) que esta pantalla todavía conserva. */
  legacyEntries: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const asCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** JSON de `get_signage_displays_overview` → pantallas. Una fila rara se descarta: nunca rompe la página. */
export function parseDisplaysOverview(raw: unknown): DisplayOverview[] {
  if (!Array.isArray(raw)) return [];
  const displays: DisplayOverview[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const name = asString(entry.name);
    if (!id || !name) continue;
    const contentSource: ContentSource = entry.contentSource === "FOLDER" || entry.contentSource === "MANUAL" ? entry.contentSource : "ALL_PROMOTIONS";
    displays.push({
      id, name, enabled: entry.enabled === true, branchId: asString(entry.branchId), branchName: asString(entry.branchName),
      slideDurationSeconds: clampSlideSeconds(typeof entry.slideDurationSeconds === "number" ? entry.slideDurationSeconds : DEFAULT_SLIDE_SECONDS),
      contentSource, folderId: asString(entry.folderId), folderName: asString(entry.folderName), tokenRotatedAt: asString(entry.tokenRotatedAt) ?? "",
      playable: asCount(entry.playable), blocked: asCount(entry.blocked), withoutPhoto: asCount(entry.withoutPhoto), legacyEntries: asCount(entry.legacyEntries)
    });
  }
  return displays;
}

/** «Todas las promociones activas», «Carpeta · Ofertas finde» o la lista anterior. */
export function sourceLabel(display: Pick<DisplayOverview, "contentSource" | "folderName">): string {
  if (display.contentSource === "FOLDER") return `Carpeta · ${display.folderName ?? "sin nombre"}`;
  if (display.contentSource === "MANUAL") return "Lista anterior (armada a mano)";
  return "Todas las promociones activas";
}

/** «12 promociones activas», «1 promoción activa», «Sin promociones para reproducir». */
export function playableLabel(display: Pick<DisplayOverview, "playable" | "contentSource">): string {
  const count = display.playable;
  if (count === 0) return display.contentSource === "FOLDER" ? "La carpeta no tiene nada vigente para reproducir" : "Sin promociones activas para reproducir";
  const noun = display.contentSource === "ALL_PROMOTIONS" ? (count === 1 ? "promoción activa" : "promociones activas") : (count === 1 ? "oferta vigente" : "ofertas vigentes");
  return `${String(count)} ${noun}`;
}

export interface DisplayNote { tone: "ok" | "warn"; text: string }

/** Lo que Fran tiene que mirar de una pantalla: apagada, sin ofertas, ofertas bloqueadas o sin foto. */
export function displayNotes(display: Pick<DisplayOverview, "enabled" | "playable" | "blocked" | "withoutPhoto" | "contentSource" | "legacyEntries">): DisplayNote[] {
  const notes: DisplayNote[] = [];
  if (!display.enabled) notes.push({ tone: "warn", text: "Pantalla desactivada: el televisor muestra el cartel de espera" });
  if (display.contentSource === "MANUAL") {
    notes.push({ tone: "warn", text: `Usa una lista armada a mano (${String(display.legacyEntries)}). Cambiá la fuente a «Todas las promociones activas» y se alimenta sola` });
  }
  if (display.enabled && display.playable === 0) notes.push({ tone: "warn", text: "El televisor muestra «Próximamente nuevas ofertas»" });
  if (display.withoutPhoto > 0) notes.push({ tone: "warn", text: `⚠ Sin foto: ${String(display.withoutPhoto)} ${display.withoutPhoto === 1 ? "se reproduce" : "se reproducen"} con un reemplazo; cargá la foto desde Gráficas` });
  if (display.blocked > 0) notes.push({ tone: "warn", text: `${String(display.blocked)} ${display.blocked === 1 ? "oferta no se reproduce" : "ofertas no se reproducen"} hoy (sin precio, producto inactivo o promoción vencida)` });
  return notes;
}
