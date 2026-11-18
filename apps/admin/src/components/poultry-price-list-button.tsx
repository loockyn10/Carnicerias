"use client";

import { useRef, useState } from "react";

/**
 * Pollos → «Lista de precios» (D-100): UN clic genera en el servidor el PNG con todos los productos activos por cajón y su precio General
 * vigente y lo entrega al dispositivo. Hay UN generador (`/api/poultry/price-list`) y UNA lógica de descarga (`usePoultryPriceListDownload`):
 * el botón del Admin y el del Inicio del celular (D-102) piden exactamente lo mismo, así con los mismos datos sale el mismo PNG.
 *
 * Consumo: nada se pide al abrir la pantalla; la única solicitud es el POST al tocar el botón (sin polling ni precarga) y la respuesta es
 * `no-store`, así nunca se reusa una lista con precios viejos. Mientras se genera, un segundo toque no hace nada.
 */

export const PRICE_LIST_ENDPOINT = "/api/poultry/price-list";
const FALLBACK_FILENAME = "Carnicerias_Fran_Lista_Pollos.png";

export type PriceListStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; notes: string[] }
  /** iPhone/iPad: el sistema no dejó abrir la hoja de compartir sola (la generación tardó); un toque más la abre con el PNG ya generado. */
  | { kind: "ready"; file: File; notes: string[] }
  | { kind: "error"; message: string };

export function filenameFrom(disposition: string | null): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? FALLBACK_FILENAME;
}

function count(response: Response, header: string): number {
  const value = Number(response.headers.get(header) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

/** Avisos (sin interacción) de lo que la lista no pudo mostrar con un precio por cajón. */
export function priceListNotes(omittedByWeight: number, missingPrice: number, missingLogo = false): string[] {
  const notes: string[] = [];
  if (missingLogo) notes.push("La lista salió sin logo: cargalo en «Imágenes de la lista».");
  if (omittedByWeight > 0) notes.push(`${String(omittedByWeight)} producto${omittedByWeight === 1 ? " se vende" : "s se venden"} por kg y no ${omittedByWeight === 1 ? "entra" : "entran"} en la lista por cajón.`);
  if (missingPrice > 0) notes.push(`${String(missingPrice)} producto${missingPrice === 1 ? "" : "s"} sin precio General: ${missingPrice === 1 ? "figura" : "figuran"} como «Consultar».`);
  return notes;
}

export interface ShareNavigator {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[] }) => Promise<void>;
}

/** iPhone / iPad (los iPad nuevos se presentan como «MacIntel» con pantalla táctil). */
export function isAppleMobile(nav: Pick<ShareNavigator, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
}

/**
 * Cómo se entrega el PNG. En iPhone/iPad (Safari y la app instalada en la pantalla de inicio) una descarga de un archivo generado no llega
 * a Fotos y, en la app instalada, puede abrirse sin forma de volver: ahí se abre la hoja de compartir del sistema con el archivo
 * («Guardar imagen», WhatsApp…). En el resto (Android con Chrome, la app instalada en Android, computadoras) se descarga directo.
 */
export function deliveryMethod(nav: ShareNavigator, file: File): "share" | "download" {
  if (!isAppleMobile(nav) || typeof nav.share !== "function" || typeof nav.canShare !== "function") return "download";
  try {
    return nav.canShare({ files: [file] }) ? "share" : "download";
  } catch {
    return "download";
  }
}

/**
 * Descarga directa (Android con Chrome, la app instalada en Android, computadoras): el archivo va a Descargas y la galería lo muestra.
 * La URL temporal se libera después de `revokeAfterMs`: una descarga que el navegador deja en espera (p. ej. mientras pregunta si permite
 * descargar varios archivos, D-103) necesita que siga viva hasta que arranque.
 */
export function saveWithLink(file: File, revokeAfterMs = 10_000) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, revokeAfterMs);
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
}

/** Entrega el archivo. Devuelve "blocked" si el sistema exige otro toque para compartir (iPhone, cuando generar tardó). */
export async function deliverPriceList(file: File, nav: ShareNavigator = navigator, save: (file: File) => void = saveWithLink): Promise<"delivered" | "blocked"> {
  if (deliveryMethod(nav, file) === "download") {
    save(file);
    return "delivered";
  }
  try {
    await nav.share?.({ files: [file] });
    return "delivered";
  } catch (error) {
    const name = errorName(error);
    if (name === "AbortError") return "delivered"; // Cerró la hoja de compartir: no es un error.
    if (name === "NotAllowedError") return "blocked";
    save(file); // Cualquier otra falla del compartir: la descarga común.
    return "delivered";
  }
}

export type PriceListFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Pide el PNG actualizado (siempre un POST nuevo, sin caché) y lo devuelve como archivo con su nombre y los avisos de la lista. */
export async function requestPriceList(fetchImpl: PriceListFetch): Promise<{ file: File; notes: string[] } | { error: string }> {
  const response = await fetchImpl(PRICE_LIST_ENDPOINT, { method: "POST", cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { error: body?.error ?? "No se pudo generar la lista de precios." };
  }
  const file = new File([await response.blob()], filenameFrom(response.headers.get("Content-Disposition")), { type: "image/png" });
  const notes = priceListNotes(count(response, "X-Price-List-Omitted-Weight"), count(response, "X-Price-List-Missing-Price"), response.headers.get("X-Price-List-Missing-Logo") === "1");
  return { file, notes };
}

/** La lógica única de los dos botones: pedir el PNG actualizado, entregarlo y evitar pedidos duplicados por toques repetidos. */
export function usePoultryPriceListDownload() {
  const [status, setStatus] = useState<PriceListStatus>({ kind: "idle" });
  // El estado de React se actualiza después del render: el ref corta un segundo toque inmediato antes de que el botón se deshabilite.
  const busy = useRef(false);

  async function download() {
    if (busy.current) return;
    busy.current = true;
    setStatus({ kind: "working" });
    try {
      const result = await requestPriceList((input, init) => fetch(input, init));
      if ("error" in result) { setStatus({ kind: "error", message: result.error }); return; }
      const { file, notes } = result;
      setStatus((await deliverPriceList(file)) === "blocked" ? { kind: "ready", file, notes } : { kind: "done", notes });
    } catch {
      setStatus({ kind: "error", message: "No se pudo generar la lista de precios. Revisá tu conexión y probá de nuevo." });
    } finally {
      busy.current = false;
    }
  }

  /** Segundo toque en iPhone: comparte el PNG ya generado (no vuelve a pedirlo). */
  async function deliverReady() {
    if (status.kind !== "ready" || busy.current) return;
    const { file, notes } = status;
    if ((await deliverPriceList(file)) === "delivered") setStatus({ kind: "done", notes });
  }

  return { status, working: status.kind === "working", download, deliverReady };
}

export function PoultryPriceListButton() {
  const { status, working, download, deliverReady } = usePoultryPriceListDownload();
  const ready = status.kind === "ready";

  return <div className="relative">
    <button
      aria-busy={working} className="inline-flex items-center gap-2 rounded-lg border border-rose-800 bg-white px-4 py-2.5 text-sm font-bold text-rose-800 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-70"
      data-testid="poultry-price-list-button" disabled={working} onClick={() => { void (ready ? deliverReady() : download()); }} type="button"
    >
      {working ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-rose-800 border-t-transparent" /> : null}
      {working ? "Generando lista…" : ready ? "Guardar la lista" : "Lista de precios"}
    </button>
    {status.kind === "error" ? <p className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg bg-red-50 p-3 text-sm text-red-800 shadow-sm" data-testid="poultry-price-list-error" role="alert">{status.message} Tocá «Lista de precios» para reintentar.</p> : null}
    {status.kind === "done" && status.notes.length > 0 ? <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 shadow-sm" data-testid="poultry-price-list-notes" role="status">
      {status.notes.map((note) => <p key={note}>{note}</p>)}
    </div> : null}
  </div>;
}
