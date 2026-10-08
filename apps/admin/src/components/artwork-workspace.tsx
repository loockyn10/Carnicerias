"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { loadArtworkAction, type ArtworkLoadResult } from "../app/admin/products/artwork/actions";
import type { ProductOption } from "../app/admin/actions";
import { buildOfferArtworkModel, normalizeHeadline } from "../lib/artwork";
import {
  ARTWORK_FORMATS, ARTWORK_FORMAT_ORDER, DEFAULT_HEADLINE, HEADLINE_PRESETS, MAX_HEADLINE_LENGTH, isExportableFormat, type ArtworkFormat, type ExportableArtworkFormat
} from "../lib/artwork-tokens";
import { ArtworkPreview } from "./artwork/artwork-preview";
import { ProductPicker } from "./product-picker";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const chip = "rounded-full border px-3 py-1 text-xs font-bold";

export interface ArtworkBranchOption { id: string; name: string; active: boolean }

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: Extract<ArtworkLoadResult, { kind: "ok" }> }
  | { status: "error"; message: string };

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

/**
 * Cartelería → pieza «Producto protagonista» (D-074). Producto + sucursal + titular definen UNA pieza; los botones TV / Feed / Story
 * sólo cambian la composición. El precio y la promoción los trae el servidor (`loadArtworkAction`); acá no se escribe ningún precio.
 */
export function ArtworkWorkspace({ branches, defaultBranchId }: { branches: ArtworkBranchOption[]; defaultBranchId: string }) {
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [format, setFormat] = useState<ArtworkFormat>("feed");
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const [download, setDownload] = useState<{ format: ExportableArtworkFormat | null; error: string | null }>({ format: null, error: null });
  const requestRef = useRef(0);

  useEffect(() => {
    if (!product) { setLoad({ status: "idle" }); return; }
    const requestId = ++requestRef.current;
    setLoad({ status: "loading" });
    loadArtworkAction(product.id, branchId || null)
      .then((result) => {
        if (requestRef.current !== requestId) return;
        if (result.kind === "ok") setLoad({ status: "ready", result });
        else setLoad({ status: "error", message: result.kind === "error" ? result.message : "No se encontró el producto" });
      })
      .catch(() => { if (requestRef.current === requestId) setLoad({ status: "error", message: "No se pudo cargar la pieza" }); });
  }, [product, branchId]);

  const ready = load.status === "ready" ? load.result : null;
  const model = useMemo(
    () => (ready ? buildOfferArtworkModel(ready.facts, { headline, imageUrl: ready.photoUrl }) : null),
    [ready, headline]
  );
  const photoProblem = ready?.facts.photo && !ready.photoUrl;

  async function downloadPng(target: ExportableArtworkFormat) {
    if (!product) return;
    setDownload({ format: target, error: null });
    try {
      const response = await fetch("/api/artwork/png", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sólo ids, titular y formato: el precio y la promoción los resuelve el servidor.
        body: JSON.stringify({ productId: product.id, branchId: branchId || null, headline: normalizeHeadline(headline), format: target })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setDownload({ format: null, error: body?.error ?? "No se pudo generar la imagen" });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response.headers.get("Content-Disposition"), `super-ofertas-${target}.png`);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      setDownload({ format: null, error: null });
    } catch {
      setDownload({ format: null, error: "No se pudo generar la imagen. Revisá tu conexión y probá de nuevo." });
    }
  }

  const canDownload = Boolean(model) && download.format === null;

  return <div className="mt-5 grid gap-6 lg:grid-cols-[22rem_1fr]" data-testid="artwork-workspace">
    <section className="grid min-w-0 content-start gap-4 rounded-xl bg-white p-5 shadow-sm">
      <div className="grid min-w-0 gap-1 text-sm font-bold">
        <span>Producto</span>
        {/* Con sucursal elegida sólo se ofrecen los productos que esa sucursal vende. */}
        <ProductPicker branchId={branchId || null} name="artwork_product" onChange={setProduct} placeholder="Buscar producto…" />
      </div>
      <label className="grid min-w-0 gap-1 text-sm font-bold" htmlFor="artwork-branch">Sucursal
        <select className={`${input} w-full font-normal`} id="artwork-branch" onChange={(event) => { setBranchId(event.target.value); }} value={branchId}>
          <option value="">Precio general (sin sucursal)</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.active ? "" : " (inactiva)"}</option>)}
        </select>
        <span className="text-xs font-normal text-stone-500">La pieza muestra el mismo precio y promoción que el POS de esa sucursal.</span>
      </label>
      <div className="grid min-w-0 gap-2 text-sm font-bold">
        <label htmlFor="artwork-headline">Titular</label>
        <input className={`${input} w-full font-normal uppercase`} id="artwork-headline" maxLength={MAX_HEADLINE_LENGTH} onChange={(event) => { setHeadline(event.target.value); }} placeholder={DEFAULT_HEADLINE} value={headline} />
        <div className="flex flex-wrap gap-2" data-testid="artwork-headline-presets">
          {HEADLINE_PRESETS.map((preset) => <button
            aria-pressed={normalizeHeadline(headline) === preset}
            className={`${chip} ${normalizeHeadline(headline) === preset ? "border-rose-800 bg-rose-50 text-rose-800" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"}`}
            key={preset} onClick={() => { setHeadline(preset); }} type="button"
          >{preset}</button>)}
        </div>
        <span className="text-xs font-normal text-stone-500">Corto (hasta {MAX_HEADLINE_LENGTH} letras). El precio no se escribe a mano: sale del sistema.</span>
      </div>
      <div className="grid gap-2 border-t pt-4">
        <p className="text-sm font-bold">Descargar</p>
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="download-feed" disabled={!canDownload} onClick={() => { void downloadPng("feed"); }} type="button">
          {download.format === "feed" ? "Generando…" : "Descargar Feed PNG"}
        </button>
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" data-testid="download-story" disabled={!canDownload} onClick={() => { void downloadPng("story"); }} type="button">
          {download.format === "story" ? "Generando…" : "Descargar Story PNG"}
        </button>
        <p className="text-xs text-stone-500">Feed {ARTWORK_FORMATS.feed.width} × {ARTWORK_FORMATS.feed.height} · Story / WhatsApp Estado {ARTWORK_FORMATS.story.width} × {ARTWORK_FORMATS.story.height}.</p>
        {download.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{download.error}</p> : null}
      </div>
    </section>

    <section className="min-w-0">
      <div aria-label="Formato" className="flex flex-wrap gap-2" role="group">
        {ARTWORK_FORMAT_ORDER.map((id) => <button
          aria-pressed={format === id}
          className={`rounded-lg border px-4 py-2 text-sm font-bold ${format === id ? "border-rose-800 bg-rose-800 text-white" : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"}`}
          data-testid={`format-${id}`} key={id} onClick={() => { setFormat(id); }} type="button"
        >{ARTWORK_FORMATS[id].label.split(" ")[0]}<span className="ml-1 font-normal opacity-80">{ARTWORK_FORMATS[id].label.split(" ")[1]}</span>
          {isExportableFormat(id) ? null : <span className="ml-1 text-xs font-normal opacity-70">(vista previa)</span>}
        </button>)}
      </div>
      <div className="mt-4">
        {!product ? <p className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500" data-testid="artwork-empty">Elegí un producto para ver su pieza.</p> : null}
        {product && load.status === "loading" && !model ? <p className="rounded-xl bg-white p-10 text-center text-stone-500" role="status">Cargando la pieza…</p> : null}
        {load.status === "error" ? <p className="rounded-lg bg-red-50 p-4 text-red-800" role="alert">{load.message}</p> : null}
        {ready && !model ? <p className="rounded-lg bg-amber-50 p-4 text-amber-900" data-testid="artwork-unavailable" role="alert">{ready.unavailableMessage}</p> : null}
        {model ? <div style={{ opacity: load.status === "loading" ? 0.5 : 1 }}>
          <ArtworkPreview format={format} model={model} />
          {!ready?.facts.photo ? <p className="mt-3 text-sm text-stone-600" data-testid="artwork-no-photo">Este producto no tiene foto: la pieza usa un panel de reemplazo. Subila desde <strong>Administrar producto → Foto para cartelería</strong>.</p> : null}
          {photoProblem ? <p className="mt-3 text-sm text-amber-800" role="alert">No se pudo cargar la foto del producto. Probá de nuevo en unos segundos.</p> : null}
        </div> : null}
      </div>
    </section>
  </div>;
}
