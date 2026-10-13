"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { removeButcherLogoAction, saveOfferLogoVariantAction } from "../app/admin/products/labels/offers-actions";
import { uploadButcherLogo } from "../lib/artwork-photo-client";
import {
  filterSigns, MAX_OFFER_SIGNS, OFFER_LOGO_VARIANTS, OFFER_SIGN_FORMATS, paginateSigns, signPageCount, signValidityText, type OfferLogoVariant, type OfferSign, type OfferSignFormat
} from "../lib/offer-sign";
import { buildSignPage } from "../lib/offer-sign-layout";
import { OfferSignPagePreview } from "./offer-sign-preview";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primaryButton = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const secondaryButton = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold disabled:opacity-40";

export interface OfferBranchOption { id: string; name: string }

export interface OfferSignListing {
  branchId: string;
  branchName: string;
  businessName: string;
  signs: OfferSign[];
  /** Cada logo ya convertido a blanco y negro (data-URL PNG); null = no hay. Cambiar de logo no vuelve al servidor. */
  logos: Record<OfferLogoVariant, string | null>;
  /** Logo guardado como elegido la última vez. */
  logoVariant: OfferLogoVariant;
}

const number = (value: number) => value.toLocaleString("es-AR");

function filenameFrom(disposition: string | null): string {
  const match = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return match?.[1] ?? "carteles-ofertas.pdf";
}

/**
 * Productos → Etiquetas → Carteles de ofertas (D-087): se eligen promociones manuales vigentes de una sucursal, se ve cómo sale cada hoja A4 y se
 * baja UN PDF con todas. No guarda nada: la selección sólo sirve para generar el PDF.
 */
export function OfferSignWorkspace({ branches, listing, error }: { branches: OfferBranchOption[]; listing: OfferSignListing | null; error: string | null }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<OfferSignFormat>("MEDIUM");
  const [logoVariant, setLogoVariant] = useState<OfferLogoVariant>(listing?.logoVariant ?? "GENERAL");
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const signs = useMemo(() => listing?.signs ?? [], [listing]);
  const shown = useMemo(() => filterSigns(signs, query), [signs, query]);
  // En el orden de la lista (no del clic): así el PDF y el preview siempre coinciden.
  const chosen = useMemo(() => signs.filter((sign) => selected.has(sign.promotionId)), [signs, selected]);
  const logoDataUrl = listing?.logos[logoVariant] ?? null;
  const hasButcherLogo = listing?.logos.BUTCHER != null;
  const brand = useMemo(() => ({ hasLogo: logoDataUrl !== null, name: listing?.businessName ?? "" }), [logoDataUrl, listing]);
  const pages = useMemo(() => paginateSigns(chosen, format).map((group) => buildSignPage(group, format, brand)), [chosen, format, brand]);
  const pageCount = signPageCount(format, chosen.length);
  const current = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const overLimit = chosen.length > MAX_OFFER_SIGNS;
  const canGenerate = !generating && listing !== null && chosen.length > 0 && !overLimit;

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
    setNotice(null);
  }

  /** El preview cambia al instante; la elección se guarda para la próxima vez (sólo afecta a estos carteles). */
  async function chooseLogo(variant: OfferLogoVariant) {
    setLogoVariant(variant);
    setNotice(null);
    const result = await saveOfferLogoVariantAction(variant);
    setFailure(result.error ?? null);
  }

  async function onLogoFile(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true);
    setFailure(null);
    const result = await uploadButcherLogo(file);
    setLogoBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (result.error) { setFailure(result.error); return; }
    setLogoVariant("BUTCHER");
    setNotice("Logo de la carnicería guardado y elegido para los carteles.");
    router.refresh();
  }

  async function removeButcherLogo() {
    if (!window.confirm("¿Quitar el logo de la carnicería? Los carteles vuelven a usar el logo general.")) return;
    setLogoBusy(true);
    const result = await removeButcherLogoAction();
    setLogoBusy(false);
    if (result.error) { setFailure(result.error); return; }
    setLogoVariant("GENERAL");
    router.refresh();
  }

  async function generate() {
    if (!listing) return;
    setFailure(null);
    setNotice(null);
    setGenerating(true);
    try {
      const response = await fetch("/api/labels/offers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: listing.branchId, format, logoVariant, promotionIds: chosen.map((sign) => sign.promotionId) })
      });
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/pdf")) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFailure(body?.error ?? "No se pudo generar el PDF");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response.headers.get("Content-Disposition"));
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
      const sheets = Number(response.headers.get("X-Sign-Pages") ?? pageCount);
      setNotice(`PDF generado: ${number(chosen.length)} ${chosen.length === 1 ? "cartel" : "carteles"} en ${number(sheets)} ${sheets === 1 ? "hoja" : "hojas"} A4 apaisadas. Imprimilo al 100 % (tamaño real, sin «ajustar a la página»).`);
    } catch {
      setFailure("No se pudo generar el PDF. Revisá la conexión y reintentá.");
    } finally {
      setGenerating(false);
    }
  }

  return <div className="mt-6 grid gap-6" data-testid="offer-sign-workspace">
    <div>
      <h2 className="text-xl font-black">Carteles de ofertas</h2>
      <p className="mt-1 text-sm text-stone-600">Elegí las promociones cargadas en Promociones y descargá un PDF A4 apaisado en blanco y negro para colgar sobre las heladeras. Los precios salen siempre de la promoción vigente: acá no se escribe ninguno.</p>
    </div>
    {error ? <p className="rounded-lg bg-red-50 p-4 text-red-800" role="alert">{error}</p> : null}

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
      <section className="min-w-0 rounded-xl bg-white p-5 shadow-sm" data-testid="offer-sign-picker">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-bold" htmlFor="offer-sign-branch">Sucursal
            <select
              className={`${input} min-w-52 font-normal`} disabled={!branches.length} id="offer-sign-branch" value={listing?.branchId ?? ""}
              onChange={(event) => { router.push(`/admin/products/labels?mode=offers&branch=${event.target.value}`); }}
            >
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </label>
          <label className="grid min-w-52 flex-1 gap-1 text-sm font-bold" htmlFor="offer-sign-search">Buscar promoción
            <input className={`${input} font-normal`} id="offer-sign-search" onChange={(event) => { setQuery(event.target.value); }} placeholder="Choricito, desde 2 kg, pack…" type="search" value={query} />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={secondaryButton} disabled={!shown.length} onClick={() => { setSelected((previous) => new Set([...previous, ...shown.map((sign) => sign.promotionId)])); setNotice(null); }} type="button">Seleccionar {query.trim() ? "los que se ven" : "todas"} ({shown.length})</button>
          <button className={secondaryButton} disabled={!selected.size} onClick={() => { setSelected(new Set()); setNotice(null); }} type="button">Limpiar</button>
          <span className="text-sm text-stone-600">{number(chosen.length)} {chosen.length === 1 ? "elegida" : "elegidas"}</span>
        </div>

        <ul className="mt-3 max-h-[28rem] divide-y divide-stone-100 overflow-y-auto rounded-lg border border-stone-200" data-testid="offer-sign-list">
          {shown.map((sign) => <li key={sign.promotionId}>
            <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-stone-50">
              <input aria-label={`Elegir ${sign.name}`} checked={selected.has(sign.promotionId)} className="mt-1" onChange={(event) => { toggle(sign.promotionId, event.target.checked); }} type="checkbox" />
              <span className="min-w-0">
                <span className="block text-sm font-bold">{sign.name}</span>
                <span className="block text-sm text-stone-700">{sign.summary}</span>
                <span className="block text-xs text-stone-500">{signValidityText(sign)}</span>
              </span>
            </label>
          </li>)}
          {!shown.length ? <li className="px-3 py-4 text-sm text-stone-500">
            {signs.length ? "Ninguna promoción coincide con la búsqueda." : "Esta sucursal no tiene promociones vigentes para imprimir. Se cargan en Productos → Promociones."}
          </li> : null}
        </ul>
        <p className="mt-2 text-xs text-stone-500">Sólo aparecen promociones activas hoy, de productos activos, que aplican a {listing?.branchName ?? "la sucursal"} y que de verdad bajan el precio.</p>
      </section>

      <section className="min-w-0 self-start rounded-xl bg-white p-5 shadow-sm" data-testid="offer-sign-preview">
        <fieldset>
          <legend className="text-sm font-bold">Formato</legend>
          <div className="mt-2 grid gap-2">
            {OFFER_SIGN_FORMATS.map((option) => <label className="flex items-center gap-2 text-sm" key={option.id}>
              <input checked={format === option.id} name="offer-sign-format" onChange={() => { setFormat(option.id); setPageIndex(0); setNotice(null); }} type="radio" value={option.id} />
              {option.label}
            </label>)}
          </div>
        </fieldset>

        <div className="mt-4 grid gap-2" data-testid="offer-sign-logo-picker">
          <label className="grid gap-1 text-sm font-bold" htmlFor="offer-sign-logo">Logo
            <select className={`${input} font-normal`} disabled={logoBusy} id="offer-sign-logo" onChange={(event) => { void chooseLogo(event.target.value === "BUTCHER" ? "BUTCHER" : "GENERAL"); }} value={logoVariant}>
              {OFFER_LOGO_VARIANTS.map((option) => <option disabled={option.id === "BUTCHER" && !hasButcherLogo} key={option.id} value={option.id}>{option.label}{option.id === "BUTCHER" && !hasButcherLogo ? " (sin cargar)" : ""}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input accept="image/png,image/jpeg,image/webp" className="hidden" data-testid="offer-sign-logo-input" onChange={(event) => { void onLogoFile(event.target.files?.[0]); }} ref={fileRef} type="file" />
            <button className={secondaryButton} disabled={logoBusy || listing === null} onClick={() => { fileRef.current?.click(); }} type="button">{logoBusy ? "Guardando…" : hasButcherLogo ? "Cambiar logo de la carnicería" : "Subir logo de la carnicería"}</button>
            {hasButcherLogo ? <button className={`${secondaryButton} text-red-700`} disabled={logoBusy} onClick={() => { void removeButcherLogo(); }} type="button">Quitar</button> : null}
          </div>
          <p className="text-xs text-stone-500">Sólo cambia estos carteles: el logo general, Instagram, TV y las etiquetas siguen igual.</p>
        </div>

        <h3 className="mt-5 text-lg font-black">Vista previa</h3>
        {pages.length ? <>
          <div className="mt-2"><OfferSignPagePreview label={`Hoja ${String(current + 1)} de ${String(pageCount)}`} logoDataUrl={logoDataUrl} page={pages[current] ?? pages[0] ?? { panels: [], rules: [] }} /></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button className={secondaryButton} disabled={current === 0} onClick={() => { setPageIndex(current - 1); }} type="button">Anterior</button>
            <span className="text-sm font-bold" data-testid="offer-sign-page-label">Hoja {current + 1} de {pageCount}</span>
            <button className={secondaryButton} disabled={current >= pageCount - 1} onClick={() => { setPageIndex(current + 1); }} type="button">Siguiente</button>
          </div>
          {pageCount > 1 ? <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Hojas">
            {pages.map((_, index) => <button aria-current={index === current} aria-label={`Ir a la hoja ${String(index + 1)}`} className={`h-8 min-w-8 rounded border px-2 text-xs font-bold ${index === current ? "border-rose-800 bg-rose-800 text-white" : "border-stone-300 bg-white"}`} key={index} onClick={() => { setPageIndex(index); }} type="button">{index + 1}</button>)}
          </div> : null}
        </> : <p className="mt-2 rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">Elegí al menos una promoción para ver cómo sale la hoja.</p>}

        <div className="mt-4 grid gap-2">
          <p className="text-sm text-stone-600" data-testid="offer-sign-summary">
            <strong>{number(chosen.length)}</strong> {chosen.length === 1 ? "cartel" : "carteles"} · {number(pageCount)} {pageCount === 1 ? "hoja" : "hojas"} A4 apaisadas
            {overLimit ? <span className="ml-2 font-bold text-amber-700">Máximo {MAX_OFFER_SIGNS} carteles por PDF.</span> : null}
          </p>
          <button className={primaryButton} data-testid="offer-sign-generate" disabled={!canGenerate} onClick={() => { void generate(); }} type="button">{generating ? "Generando…" : "Generar PDF A4"}</button>
          <p className="text-xs text-stone-500">Imprimí al 100 % (tamaño real, sin «ajustar a la página»). En la tira, cortá por el medio de cada separación.</p>
        </div>
        {failure ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{failure}</p> : null}
        {notice ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
      </section>
    </div>
  </div>;
}
