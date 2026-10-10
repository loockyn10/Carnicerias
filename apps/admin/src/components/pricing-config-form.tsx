"use client";

import { calculateListPriceFromMargin, formatCurrency, type QuantityTier } from "@carnicerias/business-logic";
import { useActionState, useMemo, useState, useTransition } from "react";

import { closeBranchPriceOverridesAction, savePricingConfigAction, type CloseOverridesState, type PricingConfigState } from "../app/admin/actions";
import { QuantityTiersField, rowsFromTiers, tierRowsError, type TierEditorRow } from "./quantity-tiers-field";
import { describePricingConfigOutcome, describePricingConfigPreview, describePricingConfigPreviewNotes, describePricingConfigSample } from "../lib/pricing-config";

const input = "w-28 rounded-lg border border-stone-300 bg-white px-3 py-2 text-right text-sm";

/** Valores vigentes en basis points (null = todavía sin configurar). */
export interface PricingConfigValues {
  marginBps: number | null;
  /** Espejo histórico del escalón más bajo (null = todavía sin configurar los descuentos por cantidad). */
  unitBulkDiscountBps: number | null;
  /** Escalones vigentes del descuento por cantidad (D-083). */
  quantityTiers?: QuantityTier[];
  packDiscountBps: number | null;
  cardSurchargeBps: number;
}

function bpsToField(bps: number | null): string {
  return bps === null ? "" : String(bps / 100);
}

function previewPrice(marginField: string): string | null {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(marginField.trim());
  if (!match) return null;
  const bps = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (bps < 1n || bps > 9_999n) return null;
  return formatCurrency(calculateListPriceFromMargin(1_000_000n, bps));
}

/**
 * Configuración GLOBAL de precios de la organización (D-068): margen de ganancia sobre el precio de venta, descuentos por cantidad con
 * escalones (D-083), descuento por pack y recargo por tarjeta. Cambiar el margen recalcula los precios de lista de todos los productos con costo, así
 * que primero muestra una vista previa (cuántos precios cambian, cuántos productos no tienen costo) y pide confirmar.
 */
export function PricingConfigForm({ values, branchOverrides = 0, categories = [], excludedCategoryIds = [] }: {
  values: PricingConfigValues; /** Precios VIGENTES por sucursal de la organización (en el POS le ganan al precio global). */ branchOverrides?: number;
  /** Categorías que se pueden excluir del margen automático (id + nombre). */ categories?: { id: string; name: string }[];
  /** Categorías hoy excluidas (ids guardados). */ excludedCategoryIds?: string[];
}) {
  const [excluded, setExcluded] = useState<string[]>(() => [...excludedCategoryIds].sort());
  const categoryNames = useMemo(() => Object.fromEntries(categories.map((category) => [category.id, category.name])), [categories]);
  const toggleExcluded = (id: string) => setExcluded((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id].sort()));
  const [closing, startClosing] = useTransition();
  const [closeResult, setCloseResult] = useState<CloseOverridesState | null>(null);
  const closeOverrides = () => {
    if (!window.confirm("¿Cerrar todos los precios por sucursal? Pasa a valer el precio global en todas las sucursales. Los precios por sucursal quedan en el historial (no se borran).")) return;
    startClosing(async () => { setCloseResult(await closeBranchPriceOverridesAction()); });
  };
  const [fields, setFields] = useState({
    margin: bpsToField(values.marginBps),
    pack: bpsToField(values.packDiscountBps), card: bpsToField(values.cardSurchargeBps)
  });
  const [tierRows, setTierRows] = useState<TierEditorRow[]>(() => rowsFromTiers(values.quantityTiers ?? (values.unitBulkDiscountBps ? [{ minimumUnits: 3, discountBps: values.unitBulkDiscountBps }] : [])));
  const tiersInvalid = tierRowsError(tierRows) !== null || tierRows.some((row) => row.editing);
  const [state, action, pending] = useActionState(savePricingConfigAction, {} as PricingConfigState);
  // Cancelar descarta ESA respuesta del servidor (por identidad): el próximo guardado trae un estado nuevo y vuelve a mostrar su vista previa.
  const [dismissed, setDismissed] = useState<PricingConfigState | null>(null);
  const set = (key: keyof typeof fields) => (event: { target: { value: string } }) => setFields((current) => ({ ...current, [key]: event.target.value }));

  // La vista previa sólo vale para los valores con los que se pidió: si se edita un campo después, hay que volver a guardar.
  const signature = JSON.stringify({ ...fields, excluded, tiers: tierRows.map((row) => [row.units.trim(), row.percent.trim()]) });
  const preview = state.preview && state.signature === signature && dismissed !== state ? state.preview : null;
  const saved = state.successToken && state.result && state.signature === signature ? state.result : null;
  const example = useMemo(() => previewPrice(fields.margin), [fields.margin]);
  const marginChanged = state.result ? state.result.previousMarginBps !== state.result.marginBps : false;
  const resultLines = saved && state.result ? describePricingConfigOutcome(state.result, marginChanged) : [];

  return <form action={action} className="mt-4 grid gap-4" data-testid="pricing-config-form">
    <input name="signature" type="hidden" value={signature} />
    {values.marginBps === null ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">
      Todavía no hay un margen configurado: cambiar un costo no modifica el precio de venta. Al guardar el margen se recalculan los precios de los productos que tienen costo.
    </p> : null}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">Margen de ganancia
        <span className="flex items-center gap-2"><input className={input} inputMode="decimal" max="99.99" min="0.01" name="margin" onChange={set("margin")} required step="0.01" type="number" value={fields.margin} /> %</span>
        <span className="text-xs font-normal text-stone-500">Porcentaje de ganancia sobre el precio de venta (no sobre el costo). Margen automático: sólo para los productos con pricing automático (no para las categorías excluidas).{example ? ` Ejemplo: costo $ 10.000 con margen ${fields.margin.trim().replace(".", ",")}% → venta ${example}.` : ""}</span>
      </label>
      <label className="grid gap-1 text-sm font-medium">Dto por pack
        <span className="flex items-center gap-2"><input className={input} inputMode="decimal" max="99.99" min="0" name="pack" onChange={set("pack")} required step="0.01" type="number" value={fields.pack} /> %</span>
        <span className="text-xs font-normal text-stone-500">Se aplica a los productos que tengan unidades por pack configuradas. 0 = el pack sigue existiendo, sin descuento.</span>
      </label>
      <label className="grid gap-1 text-sm font-medium">Recargo por tarjeta
        <span className="flex items-center gap-2"><input className={input} inputMode="decimal" max="99.99" min="0" name="card" onChange={set("card")} required step="0.01" type="number" value={fields.card} /> %</span>
        <span className="text-xs font-normal text-stone-500">Se suma al precio base cuando el pago es con tarjeta (débito o crédito). Efectivo y transferencia no tienen ajuste.</span>
      </label>
    </div>
    <QuantityTiersField onChange={setTierRows} rows={tierRows} />
    <fieldset className="grid gap-2 rounded-lg border border-stone-200 p-3" data-testid="excluded-categories">
      <legend className="px-1 text-sm font-medium">Categorías excluidas del margen automático</legend>
      <input name="excluded_sent" type="hidden" value="1" />
      <p className="text-xs text-stone-500">El margen automático se aplica a los productos habilitados para pricing automático. Los productos de las categorías marcadas (por ejemplo, carnicería) conservan su precio: se escribe a mano y un costo nuevo sólo se guarda (sigue sirviendo para la rentabilidad). Un producto sin categoría es automático.</p>
      {categories.length ? <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {categories.map((category) => <label className="flex items-center gap-2" key={category.id}>
          <input checked={excluded.includes(category.id)} name="excluded_category" onChange={() => toggleExcluded(category.id)} type="checkbox" value={category.id} /> {category.name}
        </label>)}
      </div> : <p className="text-sm text-stone-500">No hay categorías cargadas.</p>}
      <p className="text-xs text-stone-500">{excluded.length ? `Excluidas: ${excluded.map((id) => categoryNames[id] ?? "Categoría").join(" · ")}. Agregar una categoría no cambia ningún precio; sacarla pide confirmación y recién ahí se recalculan sus productos.` : "Ninguna categoría excluida: el margen se aplica a todos los productos con costo."}</p>
    </fieldset>
    {branchOverrides > 0 || closeResult?.successToken ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="branch-overrides-notice" role="status">
      {closeResult?.successToken
        ? <p>Se cerraron {String(closeResult.closed ?? 0)} precio(s) por sucursal: ahora vale el precio global. Quedan en el historial.</p>
        : <>
          <p><strong>{branchOverrides.toLocaleString("es-AR")} precio(s) por sucursal vigente(s).</strong> Un precio de sucursal le gana al precio global en el POS de esa sucursal, así que ese producto no refleja el costo ni el margen. Ninguna pantalla vigente los crea.</p>
          <button className="mt-2 rounded-lg border border-amber-700 px-3 py-1.5 text-sm font-bold disabled:opacity-60" disabled={closing} onClick={closeOverrides} type="button">{closing ? "Cerrando…" : "Cerrar precios por sucursal"}</button>
        </>}
      {closeResult?.error ? <p className="mt-2 font-bold text-red-800" role="alert">{closeResult.error}</p> : null}
    </div> : null}
    <p className="text-xs text-stone-500">Valen para toda la organización. Cambiar el descuento por pack o los descuentos por cantidad no modifica ningún precio de lista; las ventas ya hechas conservan lo que tenían.</p>

    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
    {preview ? <div className="grid gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alertdialog">
      <p className="font-bold">{preview.marginChanged ? "¿Recalcular los precios con el nuevo margen?" : "¿Pasar estas categorías a pricing automático y recalcular sus precios?"}</p>
      <ul className="grid gap-0.5" data-testid="pricing-preview">{describePricingConfigPreview(preview, categoryNames).map((line) => <li key={line}>{line}</li>)}</ul>
      {preview.sample.length ? <div data-testid="pricing-preview-sample">
        <p className="font-bold">Algunos precios que cambian:</p>
        <ul className="list-disc pl-5">{describePricingConfigSample(preview).map((line) => <li key={line}>{line}</li>)}</ul>
      </div> : null}
      <ul className="grid gap-1 text-xs">{describePricingConfigPreviewNotes(preview).map((note) => <li key={note}>{note}</li>)}</ul>
      {preview.branchOverrides > 0 ? <label className="flex items-start gap-2 font-bold" data-testid="close-overrides-option">
        <input defaultChecked name="close_overrides" type="checkbox" />
        <span>Cerrar los {preview.branchOverrides.toLocaleString("es-AR")} precio(s) por sucursal de estos productos para que valga el precio global (se conservan en el historial).</span>
      </label> : null}
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending} name="confirm" type="submit" value="1">{pending ? "Guardando…" : "Confirmar y recalcular"}</button>
        <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold disabled:opacity-60" disabled={pending} onClick={() => setDismissed(state)} type="button">Cancelar</button>
        <span className="self-center text-xs text-stone-600">Todavía no se escribió nada.</span>
      </div>
    </div> : null}
    {saved ? <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900" role="status">
      <p className="font-bold">{marginChanged ? "Margen actualizado." : "Configuración guardada."}</p>
      {resultLines.length ? <ul className="mt-1 list-disc pl-5">{resultLines.map((line) => <li key={line}>{line}</li>)}</ul> : null}
    </div> : null}

    {!preview ? <div className="flex justify-end">
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending || tiersInvalid} type="submit">{pending ? "Guardando…" : "Guardar configuración"}</button>
    </div> : null}
  </form>;
}
