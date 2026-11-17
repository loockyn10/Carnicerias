"use client";

import { useState } from "react";

type Status = { kind: "idle" } | { kind: "working" } | { kind: "done"; notes: string[] } | { kind: "error"; message: string };

function filenameFrom(disposition: string | null): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? "Carnicerias_Fran_Lista_Pollos.png";
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

/**
 * Pollos → «Lista de precios» (D-100): UN clic genera en el servidor el PNG con todos los productos activos por cajón y su precio General
 * vigente, y lo descarga sin abrir otra pestaña. Sin modales ni pasos intermedios; mientras se genera, el botón muestra el progreso y si
 * falla deja el error a la vista y se puede volver a intentar.
 */
export function PoultryPriceListButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const working = status.kind === "working";

  async function download() {
    if (working) return;
    setStatus({ kind: "working" });
    try {
      const response = await fetch("/api/poultry/price-list", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStatus({ kind: "error", message: body?.error ?? "No se pudo generar la lista de precios." });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response.headers.get("Content-Disposition"));
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      setStatus({ kind: "done", notes: priceListNotes(count(response, "X-Price-List-Omitted-Weight"), count(response, "X-Price-List-Missing-Price"), response.headers.get("X-Price-List-Missing-Logo") === "1") });
    } catch {
      setStatus({ kind: "error", message: "No se pudo generar la lista de precios. Revisá tu conexión y probá de nuevo." });
    }
  }

  return <div className="relative">
    <button
      aria-busy={working} className="inline-flex items-center gap-2 rounded-lg border border-rose-800 bg-white px-4 py-2.5 text-sm font-bold text-rose-800 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-70"
      data-testid="poultry-price-list-button" disabled={working} onClick={() => { void download(); }} type="button"
    >
      {working ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-rose-800 border-t-transparent" /> : null}
      {working ? "Generando lista…" : "Lista de precios"}
    </button>
    {status.kind === "error" ? <p className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg bg-red-50 p-3 text-sm text-red-800 shadow-sm" data-testid="poultry-price-list-error" role="alert">{status.message} Tocá «Lista de precios» para reintentar.</p> : null}
    {status.kind === "done" && status.notes.length > 0 ? <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 shadow-sm" data-testid="poultry-price-list-notes" role="status">
      {status.notes.map((note) => <p key={note}>{note}</p>)}
    </div> : null}
  </div>;
}
