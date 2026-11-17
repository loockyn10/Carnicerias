"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { removePriceListBackgroundAction, setPriceListLogoSourceAction, type PriceListImageResult } from "../app/admin/poultry/price-list/actions";
import { uploadPriceListImage } from "../lib/poultry-price-list-images-client";
import { PRICE_LIST_LOGO_LABELS, PRICE_LIST_LOGO_SOURCES, type PriceListImageKind, type PriceListLogoSource } from "../lib/poultry-price-list-images";
import { StatusBadge } from "./admin-ui";

export interface PriceListImageView { url: string | null; widthPx: number; heightPx: number }

export interface PriceListImagesPanelProps {
  logoUsed: PriceListLogoSource | null;
  logos: Partial<Record<PriceListLogoSource, PriceListImageView>>;
  background: PriceListImageView | null;
}

const CHECKER = "repeating-conic-gradient(#e7e5e4 0% 25%, #ffffff 0% 50%) 50% / 16px 16px";

function Thumb({ image, alt, tall = false }: { image: PriceListImageView; alt: string; tall?: boolean }) {
  return <div className={`grid place-items-center overflow-hidden rounded-lg border border-stone-200 ${tall ? "h-40" : "h-24"}`} style={{ background: CHECKER }}>
    {/* URL firmada temporal del bucket privado. */}
    {image.url ? <img alt={alt} className="max-h-full max-w-full object-contain" src={image.url} /> : <span className="text-xs text-stone-500">No se pudo mostrar</span>}
  </div>;
}

/**
 * Pollos → Imágenes de la lista (D-100): qué logo y qué foto de fondo usa la «Lista de precios». Se configura una vez; el botón de descarga
 * las usa sin preguntar. Los logos que la aplicación ya guarda (Cartelería) se ofrecen primero; si ninguno sirve, se sube uno propio.
 */
export function PoultryPriceListImagesPanel({ logoUsed, logos, background }: PriceListImagesPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const available = PRICE_LIST_LOGO_SOURCES.filter((source) => logos[source]);
  const working = pending || busy !== null;

  async function run(key: string, task: () => Promise<PriceListImageResult>) {
    setBusy(key);
    setError(null);
    try {
      const result = await task();
      if (result.error) { setError(result.error); return; }
      startTransition(() => { router.refresh(); });
    } finally {
      setBusy(null);
    }
  }

  function upload(kind: PriceListImageKind, file: File | undefined) {
    if (!file) return;
    void run(kind, () => uploadPriceListImage(kind, file));
  }

  return <div className="mt-6 grid gap-5 lg:grid-cols-2">
    {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800 lg:col-span-2" data-testid="price-list-images-error" role="alert">{error}</p> : null}

    <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="price-list-logo-section">
      <h2 className="text-lg font-black">Logo</h2>
      <p className="mt-1 text-sm text-stone-600">Va en la franja amarilla de arriba, como en la lista de SUPER OFERTAS. Primero se ofrecen los logos que ya están cargados en la aplicación.</p>
      {available.length === 0 ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="price-list-no-logo">No hay ningún logo cargado en la aplicación. Subí el logo de SUPER OFERTAS (PNG con fondo transparente, preferentemente).</p> : null}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {available.map((source) => {
          const image = logos[source];
          if (!image) return null;
          const inUse = logoUsed === source;
          return <li className={`grid gap-2 rounded-xl border p-3 ${inUse ? "border-emerald-600 ring-1 ring-emerald-600" : "border-stone-200"}`} data-testid={`price-list-logo-${source.toLowerCase()}`} key={source}>
            <Thumb alt={PRICE_LIST_LOGO_LABELS[source].title} image={image} />
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1"><p className="text-sm font-bold">{PRICE_LIST_LOGO_LABELS[source].title}</p><p className="text-xs text-stone-500">{PRICE_LIST_LOGO_LABELS[source].detail}</p></div>
              {inUse ? <StatusBadge tone="success">En uso</StatusBadge> : <button className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-bold hover:bg-stone-50 disabled:opacity-60" disabled={working} onClick={() => { void run(`use-${source}`, () => setPriceListLogoSourceAction(source)); }} type="button">{busy === `use-${source}` ? "Guardando…" : "Usar este"}</button>}
            </div>
          </li>;
        })}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="price-list-logo-input" onChange={(event) => { upload("LOGO", event.target.files?.[0]); event.target.value = ""; }} ref={logoInput} type="file" />
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-60" disabled={working} onClick={() => logoInput.current?.click()} type="button">{busy === "LOGO" ? "Subiendo logo…" : logos.CUSTOM ? "Reemplazar logo propio" : "Subir otro logo"}</button>
        <span className="text-xs text-stone-500">PNG, JPG o WebP · hasta 5 MB. El que subas queda en uso.</span>
      </div>
    </section>

    <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="price-list-background-section">
      <h2 className="text-lg font-black">Foto de fondo</h2>
      <p className="mt-1 text-sm text-stone-600">Se ve a los costados de la tabla. Usá una foto de productos avícolas <strong>sin textos ni precios</strong>; se recorta sola para cubrir el fondo.</p>
      <div className="mt-4">
        {background ? <Thumb alt="Foto de fondo" image={background} tall /> : <p className="grid h-40 place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 text-center text-sm text-stone-500" data-testid="price-list-no-background">Sin foto: la lista usa un fondo neutro claro.</p>}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="price-list-background-input" onChange={(event) => { upload("BACKGROUND", event.target.files?.[0]); event.target.value = ""; }} ref={backgroundInput} type="file" />
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50 disabled:opacity-60" disabled={working} onClick={() => backgroundInput.current?.click()} type="button">{busy === "BACKGROUND" ? "Subiendo foto…" : background ? "Reemplazar foto" : "Subir foto de fondo"}</button>
        {background ? <button className="rounded-lg px-3 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-60" disabled={working} onClick={() => { void run("remove-background", removePriceListBackgroundAction); }} type="button">{busy === "remove-background" ? "Quitando…" : "Quitar foto"}</button> : null}
      </div>
    </section>
  </div>;
}
