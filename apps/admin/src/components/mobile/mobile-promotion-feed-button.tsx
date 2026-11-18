"use client";

import { useRef, useState } from "react";

import {
  listFeed, recordFeed, renderFeed, runFeedQueue, type FeedFetch, type FeedProgress, type FeedQueueResult, type RecordEntry
} from "../../lib/promotion-feed-queue";
import { saveWithLink } from "../poultry-price-list-button";

/**
 * Inicio del celular → «Descargar promociones Feed (N)» (D-103). UN toque: el servidor dice qué promociones cambiaron (o son nuevas) desde
 * su última descarga y la cola las pide de a una y las baja a la galería, sin ZIP, sin elegir nada y sin editor. «Repetir la última tanda»
 * vuelve a bajar lo último descargado (por si Chrome bloqueó descargas o falta alguna en la galería), registrándolo en esa misma tanda.
 *
 * N llega calculado del servidor al abrir el Inicio (sin pedidos desde el celular); el botón no consulta nada solo ni hace polling.
 */

/** La URL temporal de cada imagen vive 3 minutos: si Chrome pregunta «¿Permitir descargar varios archivos?», las descargas esperan esa respuesta. */
const FEED_FILE_LIFETIME_MS = 180_000;

export type FeedRunMode = "pending" | "last";

export type FeedStatus =
  | { kind: "idle" }
  | { kind: "listing"; mode: FeedRunMode }
  | { kind: "running"; mode: FeedRunMode; progress: FeedProgress }
  | { kind: "done"; mode: FeedRunMode; result: FeedQueueResult; skipped: number }
  | { kind: "uptodate"; skipped: number }
  | { kind: "error"; message: string };

export function feedButtonTitle(pending: number | null): string {
  if (pending === 0) return "Promociones actualizadas";
  return pending === null ? "Descargar promociones Feed" : `Descargar promociones Feed (${String(pending)})`;
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

/** Lo que pasó, sin exagerar: «enviada» = la descarga se inició (el navegador no confirma que quedó en la galería). */
export function feedResultLines(result: FeedQueueResult, skipped: number): { tone: "ok" | "warn"; text: string }[] {
  const lines: { tone: "ok" | "warn"; text: string }[] = [];
  if (result.saved > 0) lines.push({ tone: "ok", text: `${plural(result.saved, "imagen enviada", "imágenes enviadas")} a Descargas (galería).` });
  if (result.failed.length > 0) {
    const names = result.failed.slice(0, 5).map((failure) => failure.name).join(", ");
    lines.push({ tone: "warn", text: `${plural(result.failed.length, "no se pudo generar", "no se pudieron generar")}: ${names}${result.failed.length > 5 ? "…" : ""}. ${result.failed.length === 1 ? "Sigue pendiente" : "Siguen pendientes"}.` });
  }
  if (result.stopped) lines.push({ tone: "warn", text: `Se frenó: ${result.stopped}` });
  if (result.unrecorded > 0) lines.push({ tone: "warn", text: `${plural(result.unrecorded, "imagen bajó", "imágenes bajaron")} pero no se pudo registrar: ${result.unrecorded === 1 ? "va a volver" : "van a volver"} a aparecer como pendiente${result.unrecorded === 1 ? "" : "s"}.` });
  if (skipped > 0) lines.push({ tone: "warn", text: `${plural(skipped, "promoción no se genera", "promociones no se generan")} hoy (sin precio, inactiva o no se vende en la sucursal).` });
  if (result.saved > 0) lines.push({ tone: "warn", text: "¿Falta alguna en la galería? Tocá «Repetir la última tanda»." });
  return lines;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

interface WakeLockSentinelLike { release: () => Promise<void> }

/** Que la pantalla no se apague a mitad de las descargas (Chrome en Android); si no se puede, se sigue igual. */
async function keepScreenOn(): Promise<WakeLockSentinelLike | null> {
  try {
    return "wakeLock" in navigator ? await navigator.wakeLock.request("screen") : null;
  } catch {
    return null;
  }
}

export function usePromotionFeedDownload(initialPending: number | null, initialLastBatch: number | null, fetchImpl: FeedFetch = (input, init) => fetch(input, init)) {
  const [status, setStatus] = useState<FeedStatus>({ kind: "idle" });
  const [pending, setPending] = useState(initialPending);
  const [lastBatch, setLastBatch] = useState(initialLastBatch);
  const busy = useRef(false);

  async function run(mode: FeedRunMode) {
    if (busy.current) return;
    busy.current = true;
    setStatus({ kind: "listing", mode });
    let lock: WakeLockSentinelLike | null = null;
    try {
      const list = await listFeed(fetchImpl, mode);
      if ("error" in list) { setStatus({ kind: "error", message: list.error }); return; }
      if (mode === "pending") setPending(list.items.length);
      const batchId = list.batchId;
      if (!list.items.length || !batchId) {
        setStatus(mode === "pending" ? { kind: "uptodate", skipped: list.skipped.length } : { kind: "error", message: "No hay una tanda anterior para repetir." });
        return;
      }
      lock = await keepScreenOn();
      setStatus({ kind: "running", mode, progress: { total: list.items.length, done: 0, saved: 0, failed: 0 } });
      const result = await runFeedQueue(list.items, {
        render: (job) => renderFeed(fetchImpl, job),
        save: (file) => { saveWithLink(file, FEED_FILE_LIFETIME_MS); },
        record: (entries: RecordEntry[]) => recordFeed(fetchImpl, batchId, entries),
        wait,
        onProgress: (progress) => { setStatus({ kind: "running", mode, progress }); }
      });
      if (mode === "pending") {
        setPending(Math.max(0, list.items.length - result.recorded));
        if (result.recorded > 0) setLastBatch(result.recorded);
      }
      setStatus({ kind: "done", mode, result, skipped: list.skipped.length });
    } catch {
      setStatus({ kind: "error", message: "No se pudieron descargar las promociones. Probá de nuevo." });
    } finally {
      void lock?.release().catch(() => undefined);
      busy.current = false;
    }
  }

  const working = status.kind === "listing" || status.kind === "running";
  return { status, pending, lastBatch, working, run };
}

export function MobilePromotionFeedButton({ pending: initialPending, lastBatch: initialLastBatch }: { pending: number | null; lastBatch: number | null }) {
  const { status, pending, lastBatch, working, run } = usePromotionFeedDownload(initialPending, initialLastBatch);
  const upToDate = pending === 0 && !working;
  const progress = status.kind === "running" ? status.progress : null;
  const title = working ? (status.kind === "running" && status.mode === "last") || (status.kind === "listing" && status.mode === "last") ? "Repitiendo la última tanda…" : "Descargando promociones…" : feedButtonTitle(pending);
  const description = progress
    ? `${String(progress.saved)} de ${String(progress.total)} enviadas${progress.failed ? ` · ${String(progress.failed)} con error` : ""}`
    : working ? "Buscando las promociones que cambiaron…" : upToDate ? "No hay precios nuevos para descargar" : "Imágenes para Instagram, directo a la galería";

  return <div className="grid gap-2">
    <button
      aria-busy={working}
      className={`flex min-h-24 w-full items-center gap-4 rounded-2xl border bg-white p-4 text-left shadow-sm disabled:cursor-wait disabled:opacity-80 ${upToDate ? "border-emerald-200 active:bg-emerald-50" : "border-amber-200 active:bg-amber-50"}`}
      data-testid="mobile-promotion-feed-button" disabled={working} onClick={() => { void run("pending"); }} type="button"
    >
      <span aria-hidden="true" className={`grid size-16 shrink-0 place-items-center rounded-2xl text-3xl ${upToDate ? "bg-emerald-100" : "bg-amber-100"}`}>
        {working ? <span className="size-7 animate-spin rounded-full border-[3px] border-amber-800 border-t-transparent" /> : upToDate ? "✅" : "📣"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-black leading-tight">{title}</span>
        <span className="mt-1 block text-base leading-snug text-stone-600">{description}</span>
        {progress ? <span className="mt-2 block h-2 overflow-hidden rounded-full bg-amber-100"><span className="block h-full rounded-full bg-amber-500 transition-[width]" style={{ width: `${String(Math.round(progress.total ? (progress.done / progress.total) * 100 : 0))}%` }} /></span> : null}
      </span>
    </button>
    {working ? <p className="rounded-xl bg-sky-50 p-3 text-base text-sky-900" data-testid="mobile-promotion-feed-hint" role="status">
      Si Chrome pregunta si permite descargar varios archivos, tocá «Permitir». No cierres la app hasta que termine.
    </p> : null}
    {status.kind === "error" ? <p className="rounded-xl bg-red-50 p-3 text-base text-red-800" data-testid="mobile-promotion-feed-error" role="alert">{status.message}</p> : null}
    {status.kind === "uptodate" ? <p className="rounded-xl bg-emerald-50 p-3 text-base text-emerald-900" data-testid="mobile-promotion-feed-uptodate" role="status">
      Promociones actualizadas: no cambió ningún precio desde la última descarga.{status.skipped > 0 ? ` ${plural(status.skipped, "promoción no se genera", "promociones no se generan")} hoy (sin precio, inactiva o no se vende en la sucursal).` : ""}
    </p> : null}
    {status.kind === "done" ? <div className="grid gap-1 rounded-xl bg-stone-50 p-3 text-base" data-testid="mobile-promotion-feed-result" role="status">
      {feedResultLines(status.result, status.skipped).map((line) => <p className={line.tone === "ok" ? "font-bold text-emerald-800" : "text-amber-900"} key={line.text}>{line.tone === "ok" ? "✓ " : "⚠ "}{line.text}</p>)}
    </div> : null}
    {lastBatch !== null && lastBatch > 0 && !working ? <button
      className="min-h-12 rounded-xl px-4 text-base font-bold text-stone-600 underline-offset-4 active:bg-stone-200"
      data-testid="mobile-promotion-feed-repeat" onClick={() => { void run("last"); }} type="button"
    >Repetir la última tanda ({lastBatch})</button> : null}
  </div>;
}
