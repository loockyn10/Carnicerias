"use client";

import { formatCurrency, formatBasisPointsPercent } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { completeMissingCostsAction, loadMissingCostsAction } from "../app/admin/actions";
import { centsToField, parseCostCents } from "../lib/bulk-costs";
import { formatIsoDate, formatLocalDateTime } from "../lib/date-range";
import {
  costUnitSuffix, defaultAlsoSetCurrentCost, describeOutcome, formatCostPerMeasure, formatMissingQuantity, productCostTotalCents,
  type MissingCostProduct, type MissingCostsReport
} from "../lib/missing-costs";
import { OverlayDialog } from "./overlay-dialog";

const money = (cents: number) => formatCurrency(BigInt(cents));
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
const columns = "sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.6fr)]";

export interface MissingCostsPanelProps {
  report: MissingCostsReport;
  timeZone: string;
  inputs: Record<string, string>;
  /** Casilla «Guardar también como costo actual» elegida por el usuario; sin elección usa el valor por defecto de cada producto. */
  alsoSet: Record<string, boolean>;
  expanded: ReadonlySet<string>;
  savingProductId: string | null;
  rowErrors: Record<string, string>;
  /** Confirmaciones de lo ya completado en esta sesión del modal. */
  done: string[];
  onInput: (productId: string, value: string) => void;
  onAlsoSet: (productId: string, checked: boolean) => void;
  onToggleLines: (productId: string) => void;
  onSave: (product: MissingCostProduct) => void;
}

/** Vista pura del modal (sin estado ni acciones): la tabla agrupada por producto, el detalle de líneas y la advertencia de precio. */
export function MissingCostsPanel({ report, timeZone, inputs, alsoSet, expanded, savingProductId, rowErrors, done, onInput, onAlsoSet, onToggleLines, onSave }: MissingCostsPanelProps) {
  return <div className="mt-4">
    {done.map((message) => <p className="mb-2 rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-800" key={message} role="status">✓ {message}</p>)}
    {report.truncated ? <p className="mb-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">Hay {String(report.totalLines)} líneas sin costo y acá se muestran las primeras {String(report.products.reduce((sum, product) => sum + product.lineCount, 0))}: completá estas y volvé a abrir para seguir con el resto.</p> : null}
    {!report.canRepair ? <p className="mb-2 rounded-lg bg-stone-100 p-3 text-sm text-stone-700" role="status">Podés ver qué falta, pero completar costos requiere permiso para editar precios y costos.</p> : null}
    {report.products.length === 0 ? <p className="rounded-xl bg-white p-5 text-center text-sm text-emerald-700 shadow-sm" role="status">No quedan líneas sin costo en este período.</p> : <>
      <p className="mb-2 text-sm text-stone-600">Cargá el costo por kg o por unidad. Sólo se completan las líneas sin costo: las que ya tienen uno no se modifican.</p>
      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        <div className={`hidden gap-3 border-b border-stone-200 px-4 py-2 text-xs font-bold uppercase tracking-wider text-stone-500 sm:grid ${columns}`}><span>Producto</span><span className="text-right">Cantidad</span><span className="text-right">Líneas</span><span className="text-right">Facturación</span><span>Costo</span></div>
        <ul className="divide-y divide-stone-100">{report.products.map((product) => <ProductRow alsoSet={alsoSet[product.productId] ?? defaultAlsoSetCurrentCost(product)} canRepair={report.canRepair} error={rowErrors[product.productId] ?? null} expanded={expanded.has(product.productId)} input={inputs[product.productId] ?? ""} key={product.productId} onAlsoSet={onAlsoSet} onInput={onInput} onSave={onSave} onToggleLines={onToggleLines} product={product} saving={savingProductId === product.productId} savingAny={savingProductId !== null} timeZone={timeZone} />)}</ul>
      </div>
    </>}
  </div>;
}

function ProductRow({ product, canRepair, input, alsoSet, expanded, saving, savingAny, error, timeZone, onInput, onAlsoSet, onToggleLines, onSave }: {
  product: MissingCostProduct; canRepair: boolean; input: string; alsoSet: boolean; expanded: boolean; saving: boolean; savingAny: boolean; error: string | null; timeZone: string;
  onInput: MissingCostsPanelProps["onInput"]; onAlsoSet: MissingCostsPanelProps["onAlsoSet"]; onToggleLines: MissingCostsPanelProps["onToggleLines"]; onSave: MissingCostsPanelProps["onSave"];
}) {
  const suffix = costUnitSuffix(product.unitType);
  const unitWord = product.unitType === "WEIGHT" ? "kg" : "unidad";
  const typed = input.trim() === "" ? null : parseCostCents(input);
  const invalid = input.trim() !== "" && typed === null;
  const reprices = product.repricesOnCostChange;
  const detailId = `missing-lines-${product.productId}`;
  const currentCost = product.currentCostCents;
  return <li className="px-4 py-3">
    <div className={`grid items-center gap-x-3 gap-y-2 ${columns}`}>
      <strong className="min-w-0 truncate">{product.productName}</strong>
      <span className="text-sm sm:text-right"><span className="text-stone-500 sm:hidden">Cantidad: </span>{formatMissingQuantity(product.unitType, product.quantity)}</span>
      <span className="text-sm sm:text-right"><span className="text-stone-500 sm:hidden">Líneas: </span>{String(product.lineCount)}</span>
      <span className="text-sm sm:text-right"><span className="text-stone-500 sm:hidden">Facturación: </span>{money(product.revenueCents)}</span>
      {canRepair ? <label className="flex items-center gap-1 text-sm"><span className="sr-only">Costo de {product.productName} por {unitWord}</span><span className="text-stone-500">$</span>
        <input aria-invalid={invalid} className={`w-full min-w-0 rounded-lg border px-2 py-1.5 text-right ${invalid ? "border-red-400" : "border-stone-300"}`} disabled={savingAny} inputMode="decimal" onChange={(event) => onInput(product.productId, event.target.value)} placeholder="0" type="text" value={input} />
        <span className="shrink-0 text-stone-500">{suffix}</span></label> : <span className="text-sm text-stone-500">—</span>}
    </div>

    {canRepair ? <div className="mt-2 space-y-1.5 text-sm">
      {currentCost !== null ? <p className="flex flex-wrap items-center gap-2 text-stone-600">Costo actual: <strong>{formatCostPerMeasure(currentCost, product.unitType)}</strong>
        <button className="rounded-md border border-stone-300 px-2 py-0.5 text-xs font-bold text-rose-800 hover:bg-stone-50 disabled:opacity-60" disabled={savingAny} onClick={() => onInput(product.productId, centsToField(currentCost))} type="button">Usar {money(currentCost)}</button>
        <span className="text-xs text-stone-500">sólo sugerencia: confirmá que era el costo de esas ventas</span></p> : null}
      {invalid ? <p className="text-red-700" role="alert">Escribí un importe, por ejemplo 3800 o 3800,50.</p> : null}
      {typed !== null ? <p className="text-stone-600">Costo de estas líneas: <strong>{money(productCostTotalCents(product, typed))}</strong> sobre {money(product.revenueCents)} vendidos.</p> : null}
      <label className="flex items-start gap-2"><input checked={alsoSet} className="mt-1" disabled={savingAny} onChange={(event) => onAlsoSet(product.productId, event.target.checked)} type="checkbox" /><span>Guardar también como costo actual del producto</span></label>
      {reprices ? <p className={`rounded-lg p-2 ${alsoSet ? "bg-amber-50 text-amber-900" : "bg-stone-50 text-stone-600"}`} role={alsoSet ? "alert" : undefined}>{alsoSet
        ? <>⚠ Esto también recalcula el precio de venta{product.marginBps !== null ? ` (margen ${formatBasisPointsPercent(product.marginBps)} %)` : ""}{product.currentPriceCents !== null ? `; hoy está en ${money(product.currentPriceCents)}${product.unitType === "WEIGHT" ? "/kg" : ""}` : ""}.</>
        : <>No viene tildado porque cambiaría el precio de venta{product.currentPriceCents !== null ? ` (hoy ${money(product.currentPriceCents)}${product.unitType === "WEIGHT" ? "/kg" : ""})` : ""}. Sólo se completa el costo histórico.</>}</p> : null}
      {error ? <p className="rounded-lg bg-red-50 p-2 text-red-800" role="alert">{error}</p> : null}
    </div> : null}

    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <button aria-controls={detailId} aria-expanded={expanded} className="text-sm font-bold text-rose-800 hover:underline" onClick={() => onToggleLines(product.productId)} type="button">{expanded ? "Ocultar líneas" : "Ver líneas"}</button>
      {canRepair ? <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50" disabled={typed === null || savingAny} onClick={() => onSave(product)} type="button">
        {saving ? "Guardando…" : alsoSet ? (reprices ? "Completar y actualizar costo y precio" : "Completar y guardar costo actual") : "Completar costo histórico"}</button> : null}
    </div>

    {expanded ? <ul className="mt-2 divide-y divide-stone-100 rounded-lg bg-stone-50 text-sm" id={detailId}>{product.lines.map((line) => <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3 py-2" key={line.lineId}>
      <span>{formatLocalDateTime(line.soldAt, timeZone)}</span>
      <span>{formatMissingQuantity(product.unitType, line.quantity)}</span>
      <span className="font-mono text-xs text-stone-500">Venta #{line.saleId.slice(0, 8)}</span>
      <span>Importe: <strong>{money(line.revenueCents)}</strong></span>
    </li>)}</ul> : null}
  </li>;
}

/**
 * «Completar costos faltantes»: modal del Resumen de sucursal (sin pantalla ni ruta nuevas). Trae al abrir las líneas sin costo del MISMO
 * período y sucursal del aviso; cada producto se completa con una llamada atómica propia al servidor (que valida permisos, organización,
 * sucursal y que la línea siga sin costo). Después de guardar se recarga la lista y se refresca el Resumen (ganancia, margen y el aviso).
 */
export function MissingCostsModal({ branchId, branchName, from, to, timeZone, onClose }: { branchId: string; branchName: string; from: string; to: string; timeZone: string; onClose: () => void }) {
  const router = useRouter();
  const [report, setReport] = useState<MissingCostsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [alsoSet, setAlsoSet] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [savingProductId, setSavingProductId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  const reload = useCallback(async () => {
    const result = await loadMissingCostsAction(branchId, from, to);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    setReport(result.report);
  }, [branchId, from, to]);

  useEffect(() => { startTransition(async () => { await reload(); }); }, [reload]);

  const save = (product: MissingCostProduct) => {
    const cents = parseCostCents(inputs[product.productId] ?? "");
    if (cents === null || !report) return;
    setSavingProductId(product.productId);
    setRowErrors((current) => without(current, product.productId));
    startTransition(async () => {
      try {
        const result = await completeMissingCostsAction({
          branchId, from, to, productId: product.productId, unitCostCents: cents, lineIds: product.lines.map((line) => line.lineId),
          alsoSetCurrentCost: alsoSet[product.productId] ?? defaultAlsoSetCurrentCost(product)
        });
        if (!result.ok) { setRowErrors((current) => ({ ...current, [product.productId]: result.error })); return; }
        setDone((current) => [...current, describeOutcome(product.productName, product.unitType, result.outcome)]);
        setInputs((current) => without(current, product.productId));
        await reload();
        router.refresh();
      } catch (caught) {
        setRowErrors((current) => ({ ...current, [product.productId]: caught instanceof Error ? caught.message : "No se pudo guardar el costo." }));
      } finally {
        setSavingProductId(null);
      }
    });
  };

  const rangeText = from === to ? formatIsoDate(from) : `${formatIsoDate(from)} – ${formatIsoDate(to)}`;
  return <OverlayDialog onClose={onClose} subtitle={`${branchName} · ${rangeText}`} title="Completar costos faltantes" wide>
    {error ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {!report && !error ? <p className="mt-6 text-center text-stone-500" role="status">Cargando…</p> : null}
    {report ? <MissingCostsPanel alsoSet={alsoSet} done={done} expanded={expanded} inputs={inputs} onAlsoSet={(productId, checked) => setAlsoSet((current) => ({ ...current, [productId]: checked }))}
      onInput={(productId, value) => setInputs((current) => ({ ...current, [productId]: value }))} onSave={save}
      onToggleLines={(productId) => setExpanded((current) => { const next = new Set(current); if (next.has(productId)) next.delete(productId); else next.add(productId); return next; })}
      report={report} rowErrors={rowErrors} savingProductId={savingProductId} timeZone={timeZone} /> : null}
  </OverlayDialog>;
}
