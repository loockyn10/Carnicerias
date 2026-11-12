"use client";

import type { Json } from "@carnicerias/database";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { createVacuumPackageAction, searchVacuumProductsAction } from "../app/admin/vacuum/actions";
import {
  buildPackageDraft, defaultExpiry, formatIsoDate, moneyText, parseVacuumPackage, parseVacuumProducts, parseVacuumSettings, vacuumDims, weightText,
  type VacuumPackage, type VacuumPrintKind, type VacuumProductOption
} from "../lib/vacuum";
import { buildInfoLabelLayout, buildPriceLabelLayout, packageToLabelData, type VacuumLabelData } from "../lib/vacuum-label-layout";
import { openPdfBlob, printPackageLabels, printPdfBlob, requestVacuumPdf } from "../lib/vacuum-print-client";
import { VacuumLabelPreview } from "./vacuum-label-preview";
import { VacuumReprintButtons } from "./vacuum-reprint-buttons";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export interface VacuumWorkspaceProps {
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  /** Respuesta cruda de search_vacuum_products para la sucursal inicial (se parsea acá). */
  initialProducts: Json;
  /** Respuesta cruda de get_vacuum_settings. */
  settings: Json;
  today: string;
}

/**
 * Pantalla rápida de envasado: corte → peso → precio calculado → vencimiento → vista previa de las DOS etiquetas → imprimir. El importe, el EAN-13
 * y las etiquetas se recalculan en cada tecla. Al registrar, el servidor congela el paquete (precio/kg, textos, esquema EAN) y asigna el lote; desde
 * ahí las etiquetas se arman SIEMPRE desde ese registro. «Nuevo paquete del mismo corte» conserva corte, vencimiento y elaboración.
 */
export function VacuumWorkspace({ branches, defaultBranchId, initialProducts, settings: rawSettings, today }: VacuumWorkspaceProps) {
  const settings = useMemo(() => parseVacuumSettings(rawSettings), [rawSettings]);
  const dims = useMemo(() => vacuumDims(settings), [settings]);
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [options, setOptions] = useState<VacuumProductOption[]>(() => parseVacuumProducts(initialProducts));
  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<VacuumProductOption | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [packedOn, setPackedOn] = useState(today);
  const [expiresOn, setExpiresOn] = useState("");
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [lot, setLot] = useState("");
  const [saved, setSaved] = useState<VacuumPackage | null>(null);
  const [busy, setBusy] = useState<VacuumPrintKind | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fallback, setFallback] = useState<Blob | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const weightRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  // Vencimiento por defecto: elaboración + vida útil del corte, mientras el operador no lo haya corregido a mano.
  const effectiveExpiry = expiryTouched ? expiresOn : (defaultExpiry(packedOn, product?.shelfLifeDays ?? null) ?? expiresOn);

  // Búsqueda con espera corta: la lista inicial ya está cargada; escribir consulta al servidor (nombre, SKU, código de barras o PLU).
  useEffect(() => {
    const sequence = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      void searchVacuumProductsAction(branchId, query).then((result) => {
        if (sequence !== searchSeq.current) return;
        if ("error" in result) { setError(result.error); return; }
        const found = parseVacuumProducts(result.data);
        setOptions(found);
        // El precio del corte elegido puede cambiar al cambiar de sucursal: se vuelve a leer.
        setProduct((current) => current ? found.find((candidate) => candidate.productId === current.productId) ?? current : current);
      });
    }, query === "" ? 0 : 180);
    return () => { window.clearTimeout(timer); };
  }, [branchId, query]);

  const draft = useMemo(() => buildPackageDraft({ product, weightText: weightInput, packedOn, expiresOn: effectiveExpiry, settings }), [product, weightInput, packedOn, effectiveExpiry, settings]);

  const draftData: VacuumLabelData | null = useMemo(() => product && draft.weightGrams !== null && draft.totalCents !== null && product.pricePerKgCents !== null ? {
    productName: product.name, weightGrams: draft.weightGrams, pricePerKgCents: product.pricePerKgCents, totalCents: draft.totalCents, packedOn, expiresOn: effectiveExpiry,
    lot: lot.trim() || null, ean13: draft.ean?.ok ? draft.ean.ean13 : null, logisticCode: null, conservationText: product.conservationText ?? settings.defaultConservationText,
    businessName: settings.businessName, address: settings.address, establishmentInfo: settings.establishmentInfo, extraText: settings.extraText
  } : null, [product, draft, packedOn, effectiveExpiry, lot, settings]);

  const previewData: VacuumLabelData | null = saved ? packageToLabelData(saved) : draftData;
  const infoLayout = useMemo(() => previewData ? buildInfoLabelLayout(previewData, saved ? vacuumDims({ labelWidthMm: saved.dims.widthMm, infoHeightMm: saved.dims.infoHeightMm, priceHeightMm: saved.dims.priceHeightMm }) : dims) : null, [previewData, saved, dims]);
  const priceLayout = useMemo(() => previewData ? buildPriceLabelLayout(previewData, saved ? vacuumDims({ labelWidthMm: saved.dims.widthMm, infoHeightMm: saved.dims.infoHeightMm, priceHeightMm: saved.dims.priceHeightMm }) : dims) : null, [previewData, saved, dims]);

  function pick(option: VacuumProductOption) {
    setProduct(option);
    setSaved(null); setError(null); setNotice(null); setFallback(null);
    if (!expiryTouched) setExpiresOn(defaultExpiry(packedOn, option.shelfLifeDays) ?? "");
    window.setTimeout(() => { weightRef.current?.focus(); }, 0);
  }

  async function printSaved(pkg: VacuumPackage, kind: VacuumPrintKind) {
    // Primero la impresión con el tamaño exacto del papel (la que usa la estación); si falla, el PDF de siempre.
    const exact = await printPackageLabels(pkg.id, kind, pkg);
    if (exact.ok) {
      setNotice(`Lote ${pkg.lot} registrado · ${kind === "BOTH" ? "ambas etiquetas" : kind === "INFO" ? "etiqueta informativa" : "etiqueta de precio"} enviada a imprimir.`);
      return;
    }
    const result = await requestVacuumPdf(pkg.id, kind);
    if (!result.ok) { setError(`El paquete quedó registrado (lote ${pkg.lot}) pero la impresión falló: ${result.error}`); return; }
    const printed = await printPdfBlob(result.blob);
    if (!printed) setFallback(result.blob);
    setNotice(`Lote ${pkg.lot} registrado · ${kind === "BOTH" ? "ambas etiquetas" : kind === "INFO" ? "etiqueta informativa" : "etiqueta de precio"} enviada${printed ? " a imprimir" : ""}.`);
  }

  async function register(kind: VacuumPrintKind) {
    if (!product || draft.weightGrams === null) return;
    setBusy(kind); setError(null); setNotice(null); setFallback(null);
    const result = await createVacuumPackageAction({
      branchId, productId: product.productId, weightGrams: draft.weightGrams, packedOn, expiresOn: effectiveExpiry || null, lot: lot.trim() || null, requestKey: requestKey.current
    });
    if (!result.ok) { setError(result.error); setBusy(null); return; }
    const pkg = parseVacuumPackage(result.data);
    if (!pkg) { setError("No se pudo leer el paquete registrado"); setBusy(null); return; }
    setSaved(pkg);
    await printSaved(pkg, kind);
    setBusy(null);
  }

  /** «Nuevo paquete del mismo corte»: se conserva corte, elaboración y vencimiento; se limpia el peso y el lote (EAN y lote nuevos). */
  function nextPackage() {
    requestKey.current = crypto.randomUUID();
    setSaved(null); setWeightInput(""); setLot(""); setError(null); setNotice(null); setFallback(null);
    window.setTimeout(() => { weightRef.current?.focus(); }, 0);
  }

  function changeProduct() {
    nextPackage();
    setProduct(null); setQuery("");
  }

  const eanMissing = !settings.ean;
  const blockers = draft.problems.filter((problem) => !(weightInput.trim() === "" && problem === "Ingresá el peso"));
  const canRegister = Boolean(product) && draft.weightGrams !== null && draft.problems.length === 0 && busy === null && !saved;
  const hasNothing = !product;

  return <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]" data-testid="vacuum-workspace">
    <section className="grid content-start gap-4 rounded-xl bg-white p-5 shadow-sm">
      {eanMissing ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="alert" data-testid="ean-missing-banner">
        Falta configurar el esquema EAN-13: sin él no se pueden registrar paquetes. <Link className="font-bold underline" href="/admin/vacuum/settings">Configurar ahora</Link>
      </p> : null}

      <label className="grid gap-1 text-sm font-bold">Sucursal
        <select className={`${input} font-normal`} disabled={busy !== null || Boolean(saved)} onChange={(event) => { setBranchId(event.target.value); }} value={branchId}>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>

      {product ? <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
        <div className="flex items-start justify-between gap-2">
          <div><p className="text-xs font-bold uppercase tracking-wider text-stone-500">Corte</p><p className="text-lg font-black" data-testid="selected-cut">{product.name}</p>
            <p className="text-xs text-stone-500">{product.sku ? `SKU ${product.sku} · ` : ""}{product.plu ? `PLU ${product.plu}` : "sin PLU"}</p></div>
          <button className="text-xs font-bold text-rose-800 underline disabled:opacity-50" disabled={busy !== null} onClick={changeProduct} type="button">Cambiar</button>
        </div>
        <p className="mt-2 text-sm">Precio / kg: <strong data-testid="price-per-kg">{product.pricePerKgCents !== null ? moneyText(product.pricePerKgCents) : "sin precio vigente"}</strong></p>
      </div> : <div className="grid gap-2">
        <label className="grid gap-1 text-sm font-bold" htmlFor="vacuum-search">Corte
          <input autoComplete="off" autoFocus className={`${input} font-normal`} id="vacuum-search" onChange={(event) => { setQuery(event.target.value); }}
            onKeyDown={(event) => { if (event.key === "Enter" && options[0]) { event.preventDefault(); pick(options[0]); } }}
            placeholder="Buscar por nombre, SKU, código de barras o PLU…" value={query} />
        </label>
        <ul className="grid max-h-64 gap-1 overflow-y-auto" data-testid="cut-options">
          {options.map((option) => <li key={option.productId}><button className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 text-left text-sm hover:border-rose-400 hover:bg-rose-50" onClick={() => { pick(option); }} type="button">
            <span><strong>{option.name}</strong>{option.sku ? <span className="ml-2 text-xs text-stone-500">{option.sku}</span> : null}</span>
            <span className="text-xs text-stone-600">{option.pricePerKgCents !== null ? `${moneyText(option.pricePerKgCents)}/kg` : "sin precio"}</span>
          </button></li>)}
          {options.length === 0 ? <li className="rounded-lg bg-stone-50 p-3 text-sm text-stone-500">{query ? "Ningún corte habilitado coincide." : "No hay cortes habilitados para envasar."} <Link className="font-bold text-rose-800 underline" href="/admin/vacuum/settings">Habilitar cortes</Link></li> : null}
        </ul>
      </div>}

      <label className="grid gap-1 text-sm font-bold">Peso (kg)
        <input autoComplete="off" className={`${input} text-2xl font-black`} disabled={hasNothing || busy !== null || Boolean(saved)} inputMode="decimal" onChange={(event) => { setWeightInput(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (canRegister) void register("BOTH"); } }} placeholder="1,245" ref={weightRef} value={weightInput} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm font-bold">Elaboración
          <input className={`${input} font-normal`} disabled={busy !== null || Boolean(saved)} onChange={(event) => { setPackedOn(event.target.value); }} required type="date" value={packedOn} />
        </label>
        <label className="grid gap-1 text-sm font-bold">Vencimiento
          <input className={`${input} font-normal`} disabled={busy !== null || Boolean(saved)} onChange={(event) => { setExpiresOn(event.target.value); setExpiryTouched(true); }} required type="date" value={effectiveExpiry} />
        </label>
      </div>
      {product?.shelfLifeDays !== null && product?.shelfLifeDays !== undefined
        ? <p className="-mt-2 text-xs text-stone-500">Vida útil configurada: {product.shelfLifeDays} días. Corregir el vencimiento requiere permiso.</p>
        : product ? <p className="-mt-2 text-xs text-amber-700">Este corte no tiene vida útil configurada: cargá el vencimiento a mano.</p> : null}

      <label className="grid gap-1 text-sm font-bold">Lote <span className="text-xs font-normal text-stone-500">automático · editable</span>
        <input className={`${input} font-normal`} disabled={busy !== null || Boolean(saved)} maxLength={40} onChange={(event) => { setLot(event.target.value); }} placeholder={saved ? saved.lot : "Se asigna al registrar"} value={saved ? saved.lot : lot} />
      </label>

      <div className="rounded-lg bg-stone-50 p-3">
        <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Precio final</p>
        <p className="text-4xl font-black text-rose-800" data-testid="final-price">{draft.totalCents !== null ? moneyText(draft.totalCents) : "—"}</p>
        {draft.weightGrams !== null && product?.pricePerKgCents ? <p className="text-xs text-stone-500">{weightText(draft.weightGrams)} × {moneyText(product.pricePerKgCents)}/kg</p> : null}
        <p className="mt-1 text-xs text-stone-500" data-testid="ean-line">EAN-13: {saved ? saved.ean13 : draft.ean?.ok ? draft.ean.ean13 : "—"}</p>
      </div>

      {blockers.length > 0 && !saved && (product || weightInput.trim() !== "") ? <ul className="grid gap-0.5 text-xs text-amber-800" data-testid="draft-problems">{blockers.map((problem) => <li key={problem}>• {problem}</li>)}</ul> : null}
      {draft.warnings.length > 0 && !saved ? <ul className="grid gap-0.5 text-xs text-stone-500">{draft.warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul> : null}
      {error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{notice}</p> : null}
      {fallback ? <button className="w-fit text-sm font-bold text-rose-800 underline" onClick={() => { openPdfBlob(fallback); }} type="button">El navegador no abrió la impresión: abrir el PDF</button> : null}

      {saved ? <div className="grid gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3" data-testid="saved-package">
        <p className="text-sm font-bold text-emerald-900">Paquete registrado · lote {saved.lot}</p>
        <VacuumReprintButtons packageId={saved.id} />
        <button className="rounded-lg bg-stone-900 px-4 py-3 text-sm font-black text-white hover:bg-stone-800" onClick={nextPackage} type="button">Nuevo paquete del mismo corte</button>
        <button className="w-fit text-xs font-bold text-stone-600 underline" onClick={changeProduct} type="button">Elegir otro corte</button>
      </div> : <div className="grid gap-2">
        <button className="rounded-lg bg-rose-800 px-4 py-3 text-base font-black text-white hover:bg-rose-900 disabled:opacity-50" disabled={!canRegister} onClick={() => { void register("BOTH"); }} type="button">{busy === "BOTH" ? "Registrando…" : "Imprimir ambas"}</button>
        <div className="grid grid-cols-2 gap-2">
          <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold hover:bg-stone-50 disabled:opacity-50" disabled={!canRegister} onClick={() => { void register("INFO"); }} type="button">Imprimir informativa</button>
          <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-bold hover:bg-stone-50 disabled:opacity-50" disabled={!canRegister} onClick={() => { void register("PRICE"); }} type="button">Imprimir precio</button>
        </div>
        <p className="text-xs text-stone-500">Registra el paquete y abre la impresión de la computadora. Enter en el peso imprime ambas.</p>
      </div>}
    </section>

    <section className="grid content-start gap-4" data-testid="vacuum-previews">
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black">Vista previa</h2>
        <p className="mt-1 text-sm text-stone-600">Controlá corte, peso, precio, vencimiento y código antes de imprimir. Se actualiza al escribir.</p>
        {infoLayout && priceLayout ? <div className="mt-4 grid gap-5 md:grid-cols-2">
          <VacuumLabelPreview layout={priceLayout} title="Etiqueta de precio / caja" />
          <VacuumLabelPreview layout={infoLayout} title="Etiqueta informativa / elaboración" />
        </div> : <p className="mt-4 rounded-lg bg-stone-50 p-6 text-center text-sm text-stone-500">Elegí un corte e ingresá el peso para ver las etiquetas.</p>}
        {previewData && !saved ? <p className="mt-3 text-xs text-stone-500">Elaboración {formatIsoDate(packedOn)} · vencimiento {effectiveExpiry ? formatIsoDate(effectiveExpiry) : "—"}</p> : null}
      </div>
    </section>
  </div>;
}
