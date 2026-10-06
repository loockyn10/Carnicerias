"use client";

import { calculateListPriceFromMargin, formatCurrency } from "@carnicerias/business-logic";
import { useActionState, useMemo, useState, useTransition } from "react";

import { closeBranchPriceOverridesAction, savePricingConfigAction, type CloseOverridesState, type PricingConfigState } from "../app/admin/actions";
import { describePricingConfigOutcome, describePricingConfigPreview } from "../lib/pricing-config";

const input = "w-28 rounded-lg border border-stone-300 bg-white px-3 py-2 text-right text-sm";

/** Valores vigentes en basis points (null = todavía sin configurar). */
export interface PricingConfigValues {
  marginBps: number | null;
  unitBulkDiscountBps: number | null;
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
 * Configuración GLOBAL de precios de la organización (D-068): margen de ganancia sobre el precio de venta, descuento llevando 3u,
 * descuento por pack y recargo por tarjeta. Cambiar el margen recalcula los precios de lista de todos los productos con costo, así
 * que primero muestra una vista previa (cuántos precios cambian, cuántos productos no tienen costo) y pide confirmar.
 */
export function PricingConfigForm({ values, branchOverrides = 0 }: { values: PricingConfigValues; /** Precios VIGENTES por sucursal de la organización (en el POS le ganan al precio global). */ branchOverrides?: number }) {
  const [closing, startClosing] = useTransition();
  const [closeResult, setCloseResult] = useState<CloseOverridesState | null>(null);
  const closeOverrides = () => {
    if (!window.confirm("¿Cerrar todos los precios por sucursal? Pasa a valer el precio global en todas las sucursales. Los precios por sucursal quedan en el historial (no se borran).")) return;
    startClosing(async () => { setCloseResult(await closeBranchPriceOverridesAction()); });
  };
  const [fields, setFields] = useState({
    margin: bpsToField(values.marginBps), unit_bulk: bpsToField(values.unitBulkDiscountBps),
    pack: bpsToField(values.packDiscountBps), card: bpsToField(values.cardSurchargeBps)
  });
  const [state, action, pending] = useActionState(savePricingConfigAction, {} as PricingConfigState);
  // Cancelar descarta ESA respuesta del servidor (por identidad): el próximo guardado trae un estado nuevo y vuelve a mostrar su vista previa.
  const [dismissed, setDismissed] = useState<PricingConfigState | null>(null);
  const set = (key: keyof typeof fields) => (event: { target: { value: string } }) => setFields((current) => ({ ...current, [key]: event.target.value }));

  // La vista previa sólo vale para los valores con los que se pidió: si se edita un campo después, hay que volver a guardar.
  const signature = JSON.stringify(fields);
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
        <span className="text-xs font-normal text-stone-500">Porcentaje de ganancia sobre el precio de venta (no sobre el costo).{example ? ` Ejemplo: costo $ 10.000 con margen ${fields.margin.trim().replace(".", ",")}% → venta ${example}.` : ""}</span>
      </label>
      <label className="grid gap-1 text-sm font-medium">Dto llevando 3u
        <span className="flex items-center gap-2"><input className={input} inputMode="decimal" max="99.99" min="0" name="unit_bulk" onChange={set("unit_bulk")} required step="0.01" type="number" value={fields.unit_bulk} /> %</span>
        <span className="text-xs font-normal text-stone-500">Se aplica desde 3 unidades del mismo producto, a todas sus unidades. 0 = sin promoción.</span>
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
    {branchOverrides > 0 || closeResult?.successToken ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="branch-overrides-notice" role="status">
      {closeResult?.successToken
        ? <p>Se cerraron {String(closeResult.closed ?? 0)} precio(s) por sucursal: ahora vale el precio global. Quedan en el historial.</p>
        : <>
          <p><strong>{branchOverrides.toLocaleString("es-AR")} precio(s) por sucursal vigente(s).</strong> Un precio de sucursal le gana al precio global en el POS de esa sucursal, así que ese producto no refleja el costo ni el margen. Ninguna pantalla vigente los crea.</p>
          <button className="mt-2 rounded-lg border border-amber-700 px-3 py-1.5 text-sm font-bold disabled:opacity-60" disabled={closing} onClick={closeOverrides} type="button">{closing ? "Cerrando…" : "Cerrar precios por sucursal"}</button>
        </>}
      {closeResult?.error ? <p className="mt-2 font-bold text-red-800" role="alert">{closeResult.error}</p> : null}
    </div> : null}
    <p className="text-xs text-stone-500">Valen para toda la organización. Cambiar el descuento por pack o llevando 3u no modifica ningún precio de lista; las ventas ya hechas conservan lo que tenían.</p>

    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
    {preview ? <div className="grid gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alertdialog">
      <p className="font-bold">¿Recalcular los precios con el nuevo margen?</p>
      <p>{describePricingConfigPreview(preview)}</p>
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
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending} type="submit">{pending ? "Guardando…" : "Guardar configuración"}</button>
    </div> : null}
  </form>;
}
