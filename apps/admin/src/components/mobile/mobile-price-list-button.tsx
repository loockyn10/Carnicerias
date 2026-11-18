"use client";

import { usePoultryPriceListDownload } from "../poultry-price-list-button";

/**
 * Inicio del celular → «Descargar lista de precios Pollos» (D-102). El mismo pedido y la misma entrega que el botón de Pollos del Admin
 * (`usePoultryPriceListDownload`): un toque genera el PNG actualizado y lo descarga (en iPhone abre la hoja de compartir con el archivo).
 * Sin editor, vista previa ni confirmaciones. Abrir el Inicio no pide nada: la única solicitud sale al tocar.
 */
export function MobilePriceListButton() {
  const { status, working, download, deliverReady } = usePoultryPriceListDownload();
  const ready = status.kind === "ready";
  const description = working
    ? "Generando la lista con los precios de hoy…"
    : ready ? "La lista está lista: tocá para guardarla o enviarla" : "PNG con los precios de hoy, listo para enviar";

  return <div className="grid gap-2">
    <button
      aria-busy={working}
      className="flex min-h-24 w-full items-center gap-4 rounded-2xl border border-rose-200 bg-white p-4 text-left shadow-sm active:bg-rose-50 disabled:cursor-wait disabled:opacity-80"
      data-testid="mobile-price-list-button" disabled={working} onClick={() => { void (ready ? deliverReady() : download()); }} type="button"
    >
      <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-2xl bg-rose-100 text-3xl">
        {working ? <span className="size-7 animate-spin rounded-full border-[3px] border-rose-800 border-t-transparent" /> : "🐔"}
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-black leading-tight">{ready ? "Guardar lista de precios Pollos" : "Descargar lista de precios Pollos"}</span>
        <span className="mt-1 block text-base leading-snug text-stone-600">{description}</span>
      </span>
    </button>
    {status.kind === "error" ? <p className="rounded-xl bg-red-50 p-3 text-base text-red-800" data-testid="mobile-price-list-error" role="alert">{status.message} Tocá el botón para reintentar.</p> : null}
    {status.kind === "done" && status.notes.length > 0 ? <div className="rounded-xl bg-amber-50 p-3 text-base text-amber-900" data-testid="mobile-price-list-notes" role="status">
      {status.notes.map((note) => <p key={note}>{note}</p>)}
    </div> : null}
  </div>;
}
