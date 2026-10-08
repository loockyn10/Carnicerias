import { BRAND_COLORS, emptyArtworkBranding, type ArtworkBranding } from "./artwork-branding";
import { clampSlideSeconds, type OfferSlideData, type SignageView } from "./signage";

/**
 * Lógica del reproductor de cartelería, sin React ni timers: un reductor puro (testeable) y el cliente HTTP del televisor.
 *
 *   - La presentación rota en bucle infinito (`ADVANCE`).
 *   - Cada consulta periódica trae la configuración publicada (`REFRESHED`). Un FALLO (red caída, 5xx, timeout) conserva la última
 *     presentación válida en memoria; sólo un «no existe» definitivo (el enlace fue regenerado o la pantalla ya no existe) la retira.
 */

export type SignageLoadResult =
  | { kind: "ok"; view: SignageView }
  /** La base respondió que ese enlace no corresponde a ninguna pantalla (404 definitivo). */
  | { kind: "not_found" }
  /** Falla transitoria (red, timeout, 5xx, respuesta ilegible): se reintenta. */
  | { kind: "error" };

export interface PlayerState {
  /** Última presentación válida; null = todavía no se pudo cargar ninguna. */
  view: SignageView | null;
  /** El enlace ya no es válido: se muestra un cartel neutro. */
  revoked: boolean;
  /** Posición de la oferta visible dentro de `view.slides`. */
  index: number;
  /** La última consulta falló (se conserva lo que había). */
  stale: boolean;
}

export type PlayerAction =
  | { type: "ADVANCE" }
  | { type: "REFRESHED"; result: SignageLoadResult };

export function initialPlayerState(initial: SignageView | null): PlayerState {
  return { view: initial, revoked: false, index: 0, stale: false };
}

/** Siguiente posición del bucle: después de la última vuelve a la primera. */
export function nextSlideIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  return (current + 1) % count;
}

/** Cantidad de ofertas visibles; 0 = pantalla de espera. */
export function visibleSlideCount(state: PlayerState): number {
  return state.revoked ? 0 : state.view?.slides.length ?? 0;
}

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  if (action.type === "ADVANCE") {
    const count = visibleSlideCount(state);
    return count < 2 ? state : { ...state, index: nextSlideIndex(state.index, count) };
  }
  const { result } = action;
  if (result.kind === "error") return state.stale ? state : { ...state, stale: true };
  if (result.kind === "not_found") return { view: null, revoked: true, index: 0, stale: false };

  const next = result.view;
  const currentKey = state.view?.slides[state.index]?.key;
  const sameKeyAt = currentKey === undefined ? -1 : next.slides.findIndex((slide) => slide.key === currentKey);
  // Si la oferta que se estaba mostrando sigue publicada, continúa ahí aunque haya cambiado de lugar; si no, no se pierde el avance.
  const index = sameKeyAt >= 0 ? sameKeyAt : Math.min(state.index, Math.max(next.slides.length - 1, 0));
  const unchanged = state.view !== null && sameView(state.view, next);
  if (!state.revoked && !state.stale && unchanged && index === state.index) return state;
  return { view: unchanged && state.view ? state.view : next, revoked: false, index, stale: false };
}

/** Igualdad estructural de dos presentaciones (para no re-renderizar en cada consulta sin cambios). */
export function sameView(a: SignageView | null, b: SignageView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cliente HTTP del televisor
// ---------------------------------------------------------------------------------------------------------------------

export const SIGNAGE_POLL_MS = 30_000;
export const SIGNAGE_RETRY_MS = 10_000;
export const SIGNAGE_FETCH_TIMEOUT_MS = 10_000;
/** Recarga completa de la página (toma versiones nuevas del código) cada tanto, sólo si hay conexión. */
export const SIGNAGE_RELOAD_MS = 6 * 60 * 60 * 1000;

/** Cuánto esperar hasta la próxima consulta: normal tras un éxito, más corto tras un fallo (para recuperarse pronto de un corte). */
export function nextPollDelay(lastResult: SignageLoadResult["kind"]): number {
  return lastResult === "error" ? SIGNAGE_RETRY_MS : SIGNAGE_POLL_MS;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal; cache?: "no-store" }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/**
 * Consulta la presentación publicada. 200 → vista; 404 → «no existe» definitivo; cualquier otra cosa (incluida una excepción de red o
 * un timeout) → fallo transitorio. Nunca lanza.
 */
export async function fetchSignageView(url: string, fetchImpl: FetchLike, timeoutMs: number = SIGNAGE_FETCH_TIMEOUT_MS): Promise<SignageLoadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    if (response.status === 404) return { kind: "not_found" };
    if (!response.ok) return { kind: "error" };
    const view = buildViewFromResponse(await response.json());
    return view ? { kind: "ok", view } : { kind: "error" };
  } catch {
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** El endpoint del televisor ya entrega la vista resuelta; se revalida su forma antes de usarla (un JSON raro no rompe la pantalla). */
function buildViewFromResponse(body: unknown): SignageView | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.slides)) return null;
  const status = record.status === "ACTIVE" ? "ACTIVE" : "DISABLED";
  const seconds = typeof record.slideDurationSeconds === "number" ? record.slideDurationSeconds : 0;
  const slides = (record.slides as unknown[]).map(readSlide).filter((slide): slide is OfferSlideData => slide !== null);
  return {
    status,
    slideDurationSeconds: clampSlideSeconds(seconds),
    organizationName: typeof record.organizationName === "string" ? record.organizationName : "",
    branding: readBranding(record.branding),
    slides: status === "ACTIVE" ? slides : []
  };
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}

function hasWhole(value: unknown): boolean {
  return typeof asRecord(value)?.whole === "string";
}

/** Las imágenes sólo se piden a las rutas propias del servidor (`/api/...`): nunca a una URL que venga dentro de un JSON. */
function ownImageUrl(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/api/") && !value.startsWith("//") ? value : null;
}

/** Una oferta del JSON del televisor: sólo se aceptan las que traen todo lo que la diapositiva dibuja; la imagen se normaliza. */
function readSlide(value: unknown): OfferSlideData | null {
  const offer = asRecord(value);
  if (!offer) return null;
  const valid = typeof offer.key === "string" && typeof offer.name === "string" && typeof offer.condition === "string"
    && hasWhole(offer.price) && hasWhole(offer.regularPrice) && (offer.unitType === "UNIT" || offer.unitType === "WEIGHT");
  return valid ? { ...(offer as unknown as OfferSlideData), imageUrl: ownImageUrl(offer.imageUrl) } : null;
}

/** La identidad que llega del servidor: colores siempre los de la marca y nunca contacto (el televisor no lo muestra). */
function readBranding(value: unknown): ArtworkBranding {
  const raw = asRecord(value);
  const fallback = emptyArtworkBranding();
  if (!raw) return fallback;
  const logo = asRecord(raw.logo);
  const imageUrl = ownImageUrl(logo?.imageUrl);
  const width = logo?.width;
  const height = logo?.height;
  const validLogo = imageUrl !== null && typeof width === "number" && width > 0 && typeof height === "number" && height > 0;
  return {
    businessName: typeof raw.businessName === "string" && raw.businessName.trim() ? raw.businessName : fallback.businessName,
    logo: validLogo ? { imageUrl, width, height } : null,
    contact: null,
    colors: BRAND_COLORS
  };
}
