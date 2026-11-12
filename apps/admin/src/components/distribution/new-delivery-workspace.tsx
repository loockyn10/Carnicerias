"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addDeliveryByQuantityAction, addDeliveryPackageByCodeAction, addDeliveryPackagesAction, cancelDeliveryAction, confirmDeliveryAction, createDeliveryAction,
  getAvailableSummaryAction, getSiteReferenceAction, listDistributablePackagesAction, removeDeliveryPackagesAction, type ActionResult
} from "../../app/admin/vacuum/distribution/actions";
import { daysUntil, groupItemsByProduct, nextRestockDate, suggestReplenishment } from "../../lib/distribution/logic";
import {
  COMMERCIAL_MODE_HINTS, COMMERCIAL_MODE_LABELS, parseAvailableSummary, parseDelivery, parseDistributablePage, parseReferenceDelivery, WEEKDAY_LABELS,
  type AvailableProduct, type CommercialMode, type Delivery, type DistributablePackage, type ReferenceDelivery
} from "../../lib/distribution/model";
import { formatIsoDate, moneyText, weightText } from "../../lib/vacuum";
import { Notice, inputClass, primaryButton, secondaryButton } from "./ui";

export interface SiteOption {
  id: string;
  clientName: string;
  siteName: string;
  mode: CommercialMode;
  restockWeekday: number | null;
  draftId: string | null;
  lastDelivery: { id: string; numberLabel: string; deliveryDate: string; packageCount: number } | null;
}

export interface NewDeliveryProps {
  sites: SiteOption[];
  originBranch: { id: string; name: string } | null;
  today: string;
  initialSiteId: string | null;
  initialDraft: Delivery | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Nueva entrega: supermercado y fecha → agregar paquetes (por cantidad, escaneando el identificador logístico o eligiendo de la lista) → revisar el detalle →
 * confirmar el despacho. Una entrega empieza como BORRADOR (los paquetes quedan reservados y no los puede tomar otra entrega ni el POS) y recién al confirmar
 * se mueve la mercadería. La reposición sugerida a partir de la entrega anterior es sólo una propuesta: nada se crea ni se confirma solo.
 */
export function NewDeliveryWorkspace(props: NewDeliveryProps) {
  const { sites, originBranch, today } = props;
  const [siteId, setSiteId] = useState(props.initialDraft?.site.id ?? props.initialSiteId ?? "");
  const site = sites.find((entry) => entry.id === siteId) ?? null;
  const [deliveryDate, setDeliveryDate] = useState(props.initialDraft?.deliveryDate ?? today);
  const [draft, setDraft] = useState<Delivery | null>(props.initialDraft);
  const [summary, setSummary] = useState<AvailableProduct[]>([]);
  const [reference, setReference] = useState<ReferenceDelivery | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<DistributablePackage[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removeSelection, setRemoveSelection] = useState<Set<string>>(new Set());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Delivery | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const codeRef = useRef<HTMLInputElement>(null);
  const isDraft = draft?.status === "DRAFT";
  const effectiveDate = draft?.deliveryDate ?? deliveryDate;

  // Al elegir el supermercado: fecha sugerida por su día habitual de reposición y la entrega anterior como referencia.
  useEffect(() => {
    if (draft !== null || siteId === "") { setReference(null); return; }
    const suggested = nextRestockDate(site?.restockWeekday ?? null, today);
    if (suggested) setDeliveryDate(suggested);
    requestKey.current = crypto.randomUUID();
    let cancelled = false;
    void getSiteReferenceAction(siteId).then((result) => { if (!cancelled && result.ok) setReference(parseReferenceDelivery(result.data)); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [siteId]);

  const refreshAvailability = useCallback(async () => {
    if (originBranch === null) return;
    const [summaryResult, listResult] = await Promise.all([
      getAvailableSummaryAction(originBranch.id, effectiveDate),
      listDistributablePackagesAction({ branchId: originBranch.id, deliveryDate: effectiveDate, productId: productFilter || null, search: filter })
    ]);
    if (summaryResult.ok) setSummary(parseAvailableSummary(summaryResult.data));
    if (listResult.ok) { const page = parseDistributablePage(listResult.data); setRows(page.rows); setRowsTotal(page.total); }
  }, [originBranch, effectiveDate, productFilter, filter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshAvailability(); }, filter === "" ? 0 : 250);
    return () => { window.clearTimeout(timer); };
  }, [refreshAvailability]);

  /** Aplica la respuesta de una operación sobre el borrador (todas devuelven la entrega actualizada). */
  async function run(label: string, action: () => Promise<ActionResult>, onOk?: (data: unknown) => void) {
    setBusy(label); setError(null); setNotice(null);
    try {
      const result = await action();
      if (!result.ok) { setError(result.error); return; }
      const body = record(result.data);
      const next = parseDelivery(body.delivery ?? result.data);
      if (next) setDraft(next);
      onOk?.(result.data);
      await refreshAvailability();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo completar la operación");
    } finally {
      setBusy(null);
    }
  }

  const suggestions = useMemo(() => suggestReplenishment(reference, summary), [reference, summary]);
  const lines = useMemo(() => groupItemsByProduct(draft?.items ?? []), [draft]);

  function createDraft() {
    if (siteId === "") return;
    void run("create", () => createDeliveryAction({ siteId, deliveryDate, requestKey: requestKey.current, referenceDeliveryId: reference?.id ?? null }), () => { setNotice("Borrador creado. Agregá los paquetes."); });
  }

  function addByQuantity(items: { productId: string; quantity: number }[]) {
    if (!draft) return;
    void run("quantity", () => addDeliveryByQuantityAction(draft.id, items), (data) => {
      const missing = asArray(record(data).missing);
      setQuantities({});
      setNotice(missing.length > 0 ? "Se agregó lo disponible: para algunos productos no alcanzaron los paquetes (ver las cantidades)." : "Paquetes agregados por vencimiento más próximo.");
    });
  }

  function addByCode(event: React.SyntheticEvent) {
    event.preventDefault();
    if (!draft || code.trim() === "") return;
    const value = code;
    setCode("");
    void run("code", () => addDeliveryPackageByCodeAction(draft.id, value), (data) => {
      const added = record(data).added === true;
      setNotice(added ? "Paquete agregado." : "Ese paquete ya estaba en la entrega.");
      codeRef.current?.focus();
    });
  }

  const quantityItems = Object.entries(quantities).map(([productId, value]) => ({ productId, quantity: Number.parseInt(value, 10) })).filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
  const expiringSoon = (draft?.items ?? []).filter((item) => daysUntil(item.expiresOn, effectiveDate) <= 3).length;

  if (originBranch === null) return <Notice tone="warn">La organización no tiene una sucursal de producción configurada: configurala en Sucursales para poder preparar entregas.</Notice>;

  if (done) {
    return <section className="grid gap-4 rounded-xl bg-white p-6 shadow-sm" data-testid="delivery-done">
      <h2 className="text-2xl font-black text-emerald-800">Entrega {done.numberLabel} despachada</h2>
      <p className="text-stone-600">{done.packageCount} paquetes ({weightText(done.totalGrams)}) para {done.client.tradeName} · {done.site.name}. La mercadería ya salió del stock de {done.originBranchName}.</p>
      {done.stockShortfalls.length > 0 ? <Notice tone="warn">El stock de {done.originBranchName} quedó negativo en: {done.stockShortfalls.map((entry) => entry.productName).join(", ")}. Revisá si falta cargar la producción de esos cortes.</Notice> : null}
      <div className="flex flex-wrap gap-3">
        <Link className={primaryButton} href={`/admin/vacuum/distribution/deliveries/${done.id}/remito`}>Ver e imprimir el remito</Link>
        <Link className={secondaryButton} href={`/admin/vacuum/distribution/deliveries/${done.id}`}>Ir a la entrega</Link>
        <Link className={secondaryButton} href="/admin/vacuum/distribution/new">Preparar otra</Link>
      </div>
    </section>;
  }

  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]" data-testid="new-delivery">
    <div className="grid content-start gap-5">
      <section className="grid gap-4 rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black">1 · Supermercado y fecha</h2>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <label className="grid gap-1 text-sm font-bold">Supermercado
            <select className={`${inputClass} font-normal`} data-testid="site-select" disabled={draft !== null || busy !== null} onChange={(event) => { setSiteId(event.target.value); }} value={siteId}>
              <option value="">Elegí un establecimiento…</option>
              {sites.map((entry) => <option key={entry.id} value={entry.id}>{entry.clientName} · {entry.siteName}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-bold">Fecha de entrega
            <input className={`${inputClass} font-normal`} data-testid="delivery-date" disabled={draft !== null || busy !== null} onChange={(event) => { setDeliveryDate(event.target.value); requestKey.current = crypto.randomUUID(); }} type="date" value={effectiveDate} />
          </label>
        </div>
        {site ? <p className="text-sm text-stone-600"><strong>{COMMERCIAL_MODE_LABELS[site.mode]}</strong>: {COMMERCIAL_MODE_HINTS[site.mode]}{site.restockWeekday ? ` · Reposición habitual: ${WEEKDAY_LABELS[site.restockWeekday] ?? ""}` : ""}{site.lastDelivery ? ` · Última entrega ${site.lastDelivery.numberLabel} (${formatIsoDate(site.lastDelivery.deliveryDate)})` : " · Sin entregas anteriores"}</p> : null}
        {site?.draftId && draft === null ? <Notice tone="info">Este establecimiento ya tiene un borrador. <Link className="font-bold underline" href={`/admin/vacuum/distribution/new?draft=${site.draftId}`}>Continuarlo</Link></Notice> : null}
        {draft === null ? <div><button className={primaryButton} data-testid="create-draft" disabled={siteId === "" || busy !== null} onClick={createDraft} type="button">{busy === "create" ? "Creando…" : "Crear borrador de entrega"}</button></div>
          : <p className="text-sm"><strong data-testid="draft-number">{draft.numberLabel}</strong> · {draft.status === "DRAFT" ? "borrador (los paquetes quedan reservados)" : draft.status === "CONFIRMED" ? "ya despachada" : "cancelada"} · {draft.client.tradeName} · {draft.site.name}</p>}
        {draft && !isDraft ? <Notice tone="warn">Esta entrega ya no es un borrador. <Link className="font-bold underline" href={`/admin/vacuum/distribution/deliveries/${draft.id}`}>Ver la entrega</Link></Notice> : null}
      </section>

      {isDraft ? <>
        {reference ? <section className="grid gap-3 rounded-xl border border-dashed border-sky-300 bg-sky-50 p-5" data-testid="reference-suggestion">
          <h2 className="text-lg font-black">Reposición: tomar como base la entrega anterior</h2>
          <p className="text-sm text-stone-700">La última vez ({reference.numberLabel}, {formatIsoDate(reference.deliveryDate)}) se entregaron {reference.packageCount} paquetes. Se propone repetir las cantidades con lo que hay disponible; vos revisás y confirmás.</p>
          <ul className="grid gap-1 text-sm">{suggestions.map((entry) => <li className="flex justify-between gap-3" key={entry.productId}><span>{entry.productName}</span><span className="tabular-nums">anterior {entry.previous} · disponibles {entry.available}{entry.missing > 0 ? <strong className="text-amber-800"> · faltan {entry.missing}</strong> : null}</span></li>)}</ul>
          <div><button className={primaryButton} disabled={busy !== null || suggestions.every((entry) => entry.quantity === 0)} onClick={() => { addByQuantity(suggestions.filter((entry) => entry.quantity > 0).map((entry) => ({ productId: entry.productId, quantity: entry.quantity }))); }} type="button">Agregar las cantidades propuestas</button></div>
        </section> : null}

        <section className="grid gap-4 rounded-xl bg-white p-5 shadow-sm" data-testid="add-packages">
          <h2 className="text-lg font-black">2 · Agregar paquetes</h2>
          <form className="flex flex-wrap items-end gap-2" onSubmit={addByCode}>
            <label className="grid flex-1 gap-1 text-sm font-bold">Escanear el identificador logístico<input autoComplete="off" className={`${inputClass} font-mono font-normal`} data-testid="scan-code" onChange={(event) => { setCode(event.target.value); }} placeholder="7K3M-9QX4-S" ref={codeRef} value={code} /></label>
            <button className={secondaryButton} disabled={busy !== null || code.trim() === ""}>Agregar</button>
          </form>
          <p className="-mt-2 text-xs text-stone-500">El código de barras comercial (EAN-13) no identifica un paquete: dos paquetes pueden compartirlo. Usá el identificador logístico de la etiqueta.</p>

          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-stone-500">Por cantidad (primero los que vencen antes)</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="quantity-grid">{summary.map((product) => <label className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm" key={product.productId}>
              <span><strong>{product.productName}</strong><span className="block text-xs text-stone-500">{product.packages} disponibles · {weightText(product.grams)}{product.nextExpiry ? ` · vence ${formatIsoDate(product.nextExpiry)}` : ""}</span></span>
              <input aria-label={`Cantidad de ${product.productName}`} className={`${inputClass} w-20 text-right`} inputMode="numeric" max={product.packages} min={0} onChange={(event) => { setQuantities((current) => ({ ...current, [product.productId]: event.target.value })); }} type="number" value={quantities[product.productId] ?? ""} /></label>)}</div>
            {summary.length === 0 ? <p className="mt-2 rounded-lg bg-stone-50 p-3 text-sm text-stone-500">No hay paquetes disponibles para distribuir en {originBranch.name} con vencimiento posterior a la fecha de entrega.</p> : null}
            <div className="mt-2"><button className={secondaryButton} disabled={busy !== null || quantityItems.length === 0} onClick={() => { addByQuantity(quantityItems); }} type="button">Agregar las cantidades</button></div>
          </div>

          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-stone-500">Elegir de la lista ({rowsTotal} disponibles)</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <input aria-label="Buscar" className={`${inputClass} min-w-0 flex-1`} onChange={(event) => { setFilter(event.target.value); }} placeholder="Buscar por corte, lote o código…" value={filter} />
              <select aria-label="Corte" className={inputClass} onChange={(event) => { setProductFilter(event.target.value); }} value={productFilter}><option value="">Todos los cortes</option>{summary.map((product) => <option key={product.productId} value={product.productId}>{product.productName}</option>)}</select>
            </div>
            <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-stone-200"><table className="w-full min-w-[560px] text-left text-sm" data-testid="available-packages">
              <thead className="sticky top-0 bg-stone-50 text-xs text-stone-500"><tr><th className="p-2"><input aria-label="Seleccionar todos" checked={rows.length > 0 && rows.every((row) => selected.has(row.packageId))} onChange={(event) => { setSelected(event.target.checked ? new Set(rows.map((row) => row.packageId)) : new Set()); }} type="checkbox" /></th><th className="p-2">Código</th><th className="p-2">Corte</th><th className="p-2">Peso</th><th className="p-2">Lote</th><th className="p-2">Vence</th><th className="p-2">Valor</th></tr></thead>
              <tbody>{rows.map((row) => <tr className="border-t border-stone-100" key={row.packageId}>
                <td className="p-2"><input aria-label={`Elegir ${row.lot}`} checked={selected.has(row.packageId)} onChange={(event) => { setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.packageId); else next.delete(row.packageId); return next; }); }} type="checkbox" /></td>
                <td className="p-2 font-mono text-xs">{row.logisticCode ?? "—"}</td><td className="p-2">{row.productName}</td><td className="p-2 tabular-nums">{weightText(row.weightGrams)}</td><td className="p-2 text-xs">{row.lot}</td>
                <td className={`p-2 text-xs ${daysUntil(row.expiresOn, effectiveDate) <= 3 ? "font-bold text-amber-800" : ""}`}>{formatIsoDate(row.expiresOn)}</td><td className="p-2 tabular-nums">{moneyText(row.totalCents)}</td></tr>)}</tbody>
            </table></div>
            <div className="mt-2"><button className={secondaryButton} disabled={busy !== null || selected.size === 0} onClick={() => { void run("select", () => addDeliveryPackagesAction(draft.id, [...selected]), () => { setSelected(new Set()); setNotice("Paquetes agregados."); }); }} type="button">Agregar los {selected.size} elegidos</button></div>
          </div>
        </section>
      </> : null}
    </div>

    <aside className="grid content-start gap-4 rounded-xl bg-white p-5 shadow-sm xl:sticky xl:top-4" data-testid="delivery-review">
      <h2 className="text-lg font-black">3 · Revisar el detalle</h2>
      {draft === null ? <p className="text-sm text-stone-500">Creá el borrador para empezar a agregar paquetes.</p> : <>
        {lines.length === 0 ? <p className="rounded-lg bg-stone-50 p-4 text-sm text-stone-500">Todavía no hay paquetes.</p> : <ul className="grid gap-2 text-sm" data-testid="review-lines">{lines.map((line) => <li className="rounded-lg border border-stone-200 p-3" key={line.productId}>
          <div className="flex justify-between gap-2"><strong>{line.productName}</strong><span className="tabular-nums">{line.packages} paq.</span></div>
          <p className="text-xs text-stone-500">{weightText(line.grams)} · {moneyText(line.cents)} · lotes {line.lots.join(", ")}{line.nextExpiry ? ` · vence desde ${formatIsoDate(line.nextExpiry)}` : ""}</p></li>)}</ul>}
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-3 text-center" data-testid="review-totals">
          <div><p className="text-2xl font-black tabular-nums">{draft.packageCount}</p><p className="text-xs text-stone-500">paquetes</p></div>
          <div><p className="text-2xl font-black tabular-nums">{weightText(draft.totalGrams).replace(" kg", "")}</p><p className="text-xs text-stone-500">kg</p></div>
          <div><p className="text-xl font-black tabular-nums">{moneyText(draft.totalCents)}</p><p className="text-xs text-stone-500">valor comercial</p></div>
        </div>
        {expiringSoon > 0 ? <Notice tone="warn">{expiringSoon} paquete{expiringSoon === 1 ? "" : "s"} vence{expiringSoon === 1 ? "" : "n"} en 3 días o menos desde la entrega.</Notice> : null}
        {isDraft && draft.items.length > 0 ? <details className="text-sm"><summary className="cursor-pointer font-bold">Quitar paquetes ({removeSelection.size} elegidos)</summary>
          <ul className="mt-2 max-h-56 overflow-auto">{draft.items.map((item) => <li className="flex items-center gap-2 border-b border-stone-100 py-1" key={item.packageId}>
            <input aria-label={`Quitar ${item.lot}`} checked={removeSelection.has(item.packageId)} onChange={(event) => { setRemoveSelection((current) => { const next = new Set(current); if (event.target.checked) next.add(item.packageId); else next.delete(item.packageId); return next; }); }} type="checkbox" />
            <span className="flex-1 text-xs"><strong>{item.productName}</strong> · {weightText(item.weightGrams)} · <span className="font-mono">{item.logisticCode ?? item.lot}</span></span></li>)}</ul>
          <button className={`${secondaryButton} mt-2`} disabled={busy !== null || removeSelection.size === 0} onClick={() => { void run("remove", () => removeDeliveryPackagesAction(draft.id, [...removeSelection]), () => { setRemoveSelection(new Set()); }); }} type="button">Quitar los elegidos</button></details> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice tone="ok">{notice}</Notice> : null}
        {isDraft ? <div className="grid gap-2 border-t border-stone-200 pt-4">
          <h3 className="font-black">4 · Confirmar el despacho</h3>
          {!confirming ? <button className={primaryButton} data-testid="start-confirm" disabled={busy !== null || draft.items.length === 0} onClick={() => { setConfirming(true); }} type="button">Revisar y confirmar</button> : <div className="grid gap-2 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
            <p className="text-sm">Se despachan <strong>{draft.packageCount} paquetes ({weightText(draft.totalGrams)})</strong> a <strong>{draft.client.tradeName} · {draft.site.name}</strong> el {formatIsoDate(draft.deliveryDate)}. La mercadería sale del stock de {draft.originBranchName}{draft.commercialMode === "WHOLESALE" ? " y se registra como venta mayorista firme." : "; en consignación todavía no se considera vendida."}</p>
            <div className="flex gap-2"><button className={primaryButton} data-testid="confirm-delivery" disabled={busy !== null} onClick={() => { void run("confirm", () => confirmDeliveryAction(draft.id), (data) => { const result = parseDelivery(data); if (result) setDone(result); }); setConfirming(false); }} type="button">{busy === "confirm" ? "Despachando…" : "Confirmar despacho"}</button>
              <button className={secondaryButton} disabled={busy !== null} onClick={() => { setConfirming(false); }} type="button">Volver</button></div></div>}
          <button className="w-fit text-xs font-bold text-red-700 underline disabled:opacity-50" disabled={busy !== null} onClick={() => { void run("cancel", () => cancelDeliveryAction(draft.id, "Borrador cancelado por el usuario"), () => { setDraft(null); setNotice("Borrador cancelado: los paquetes volvieron a estar disponibles."); requestKey.current = crypto.randomUUID(); }); }} type="button">Cancelar el borrador</button>
        </div> : null}
      </>}
    </aside>
  </div>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
