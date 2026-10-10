"use client";

import { formatBasisPointsPercent, type QuantityTier } from "@carnicerias/business-logic";
import { useState } from "react";

import { parseQuantityTierRows, type QuantityTierRow } from "../lib/pricing-config";

const cell = "w-24 rounded-lg border border-stone-300 bg-white px-3 py-2 text-right text-sm";
const linkButton = "text-sm font-bold text-rose-800 hover:underline disabled:opacity-50";

/** Una fila del editor: lo escrito más si se está editando (sin ordenar hasta confirmar la fila). */
export interface TierEditorRow extends QuantityTierRow {
  key: string;
  editing: boolean;
}

export function rowsFromTiers(tiers: readonly QuantityTier[]): TierEditorRow[] {
  return [...tiers].sort((a, b) => a.minimumUnits - b.minimumUnits).map((tier) => ({
    key: `tier-${String(tier.minimumUnits)}`, units: String(tier.minimumUnits), percent: formatBasisPointsPercent(tier.discountBps), editing: false
  }));
}

/** Lo que viaja en el campo oculto `quantity_tiers`: sólo lo escrito (el servidor vuelve a parsear y validar todo). */
export function serializeTierRows(rows: readonly TierEditorRow[]): string {
  return JSON.stringify(rows.map((row) => ({ units: row.units, percent: row.percent })));
}

/** Error de validación de las filas (null = válidas), con la misma regla del servidor. */
export function tierRowsError(rows: readonly TierEditorRow[]): string | null {
  const parsed = parseQuantityTierRows(rows);
  return parsed.ok ? null : parsed.error;
}

let counter = 0;
const nextKey = () => `new-${String(++counter)}`;

/**
 * «Descuentos por cantidad» (D-083): la lista de escalones «desde N unidades, X %» de TODA la organización (reemplaza el único «Dto llevando 3u»).
 * Se aplica el MAYOR escalón alcanzado, nunca se suman. Cada fila se edita o se elimina; «Agregar escalón» suma una fila nueva. Las filas se
 * ordenan solas por cantidad al confirmarlas. El porcentaje se escribe con hasta 2 decimales y viaja como texto: el servidor lo convierte a
 * basis points enteros. Cambiar los escalones sólo afecta ventas FUTURAS (las hechas conservan el escalón con el que se cobraron).
 */
export function QuantityTiersField({ rows, onChange }: { rows: TierEditorRow[]; onChange: (rows: TierEditorRow[]) => void }) {
  const [draftError, setDraftError] = useState<string | null>(null);
  const error = tierRowsError(rows);
  const update = (key: string, patch: Partial<TierEditorRow>) => onChange(rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const finish = (key: string) => {
    const next = rows.map((row) => row.key === key ? { ...row, editing: false } : row);
    const parsed = parseQuantityTierRows(next);
    if (!parsed.ok) { setDraftError(parsed.error); return; }
    setDraftError(null);
    onChange(rowsFromTiers(parsed.tiers).map((row) => {
      const previous = next.find((candidate) => candidate.units.trim() === row.units);
      return { ...row, key: previous?.key ?? row.key };
    }));
  };
  const remove = (key: string) => { setDraftError(null); onChange(rows.filter((row) => row.key !== key)); };
  const add = () => { setDraftError(null); onChange([...rows, { key: nextKey(), units: "", percent: "", editing: true }]); };
  const shown = draftError ?? (rows.some((row) => row.editing) ? null : error);

  return <fieldset className="grid gap-2 rounded-lg border border-stone-200 p-3 sm:col-span-2" data-testid="quantity-tiers-field">
    <legend className="px-1 text-sm font-medium">Descuentos por cantidad</legend>
    <input name="quantity_tiers" type="hidden" value={serializeTierRows(rows)} />
    <p className="text-xs text-stone-500">Llevando N o más unidades del mismo producto, todas llevan el descuento. Se aplica el mayor escalón alcanzado (no se suman). Sólo para productos por unidad.</p>
    {rows.length ? <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white" data-testid="quantity-tiers-list">
      {rows.map((row) => <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2" key={row.key}>
        {row.editing ? <>
          <label className="flex items-center gap-2 text-sm"><span className="sr-only">Cantidad mínima</span>
            <input aria-label="Cantidad mínima" className={cell} inputMode="numeric" onChange={(event) => update(row.key, { units: event.target.value })} placeholder="3" value={row.units} /> unidades</label>
          <label className="flex items-center gap-2 text-sm"><span className="sr-only">Descuento</span>
            <input aria-label="Descuento" className={cell} inputMode="decimal" onChange={(event) => update(row.key, { percent: event.target.value })} placeholder="15" value={row.percent} /> %</label>
          <button className={linkButton} onClick={() => finish(row.key)} type="button">Listo</button>
          <button className={linkButton} onClick={() => remove(row.key)} type="button">Eliminar</button>
        </> : <>
          <span className="w-28 text-sm font-bold">{row.units} unidades</span>
          <span className="w-20 text-right text-sm font-bold">{row.percent} %</span>
          <button aria-label={`Editar escalón de ${row.units} unidades`} className={linkButton} onClick={() => update(row.key, { editing: true })} type="button">Editar</button>
          <button aria-label={`Eliminar escalón de ${row.units} unidades`} className={linkButton} onClick={() => remove(row.key)} type="button">Eliminar</button>
        </>}
      </li>)}
    </ul> : <p className="text-sm text-stone-500">Sin descuentos por cantidad: ninguna venta lleva descuento por llevar más unidades.</p>}
    <div><button className={linkButton} onClick={add} type="button">+ Agregar escalón</button></div>
    {shown ? <p className="text-sm text-red-700" data-testid="quantity-tiers-error" role="alert">{shown}</p> : null}
  </fieldset>;
}
