"use client";

import { calculateListPriceFromMargin, formatCurrency } from "@carnicerias/business-logic";
import { useActionState, useEffect, useMemo, useState } from "react";

import { bulkSetProductCostsAction, type BulkCostState } from "../app/admin/actions";
import { changedBulkItems, costPlaceholder, displayedMarginBps, marginChange, parseCostCents, parseMarginBps, type RowEdit } from "../lib/bulk-costs";
import { bpsToPercentField, type MarginRule } from "../lib/product-margin";
import { normalizeSearchText } from "../lib/text-search";

const input = "w-32 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";
const marginInput = "w-20 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";

export interface BulkCostRow {
  id: string;
  name: string;
  categoryName: string;
  unitType: "WEIGHT" | "UNIT";
  /** Costo vigente en centavos (null = sin costo). Sólo se usa como referencia (placeholder) y para detectar cambios. */
  currentCostCents: number | null;
  /** Precio de lista vigente en centavos (null = sin precio). Dato de referencia: acá nunca se edita. */
  currentPriceCents: number | null;
  /** Categoría excluida del margen automático (D-069) y sin margen propio: el costo se guarda pero el precio NO se recalcula (precio manual). */
  manualPrice: boolean;
  /** La categoría está excluida del margen automático, tenga o no margen propio: define a qué vuelve «Usar global» / «Usar precio manual». */
  excludedCategory?: boolean;
  /** Regla de margen que aplica el servidor a este producto (D-070): propio > precio manual > global. */
  marginRule?: MarginRule;
}

/**
 * Carga masiva de COSTOS y MARGEN (D-068 / D-070): una fila por producto; Fran escribe los costos de una factura y, si quiere, un margen
 * propio para ese producto. El input de margen MUESTRA el margen efectivo (propio o global) pero sólo se guarda un override cuando el valor
 * cambia. Costo + margen en la misma fila viajan juntos: el servidor guarda el margen sin repreciar y el costo forma el precio una sola vez.
 * Sólo se envían las filas que realmente cambiaron. La fórmula del precio vive en el servidor; acá sólo se proyecta para mostrar.
 */
export function BulkCostEditor({ rows, marginConfigured, marginBps = null }: { rows: BulkCostRow[]; marginConfigured: boolean; /** Margen global en basis points: sólo para mostrar el precio que va a formar el servidor (no se envía). */ marginBps?: number | null }) {
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [search, setSearch] = useState("");
  const [state, action, pending] = useActionState(bulkSetProductCostsAction, {} as BulkCostState);
  const patch = (id: string, change: RowEdit) => setEdits((current) => ({ ...current, [id]: { ...current[id], ...change } }));

  useEffect(() => {
    if (state.successToken) setEdits({});
  }, [state.successToken]);

  // Regla vigente de cada fila (margen propio persistido / global efectivo): de ahí salen el valor mostrado y la detección de cambios.
  const refs = useMemo(() => rows.map((row) => {
    const rule: MarginRule = row.marginRule ?? (row.manualPrice ? { kind: "MANUAL", bps: null } : marginBps !== null ? { kind: "GLOBAL", bps: marginBps } : { kind: "NONE", bps: null });
    return { id: row.id, row, rule, currentCostCents: row.currentCostCents, customMarginBps: rule.kind === "CUSTOM" ? rule.bps : null, globalMarginBps: rule.kind === "GLOBAL" ? rule.bps : null };
  }), [rows, marginBps]);
  const changedItems = useMemo(() => changedBulkItems(refs, edits), [edits, refs]);
  const dirtyIds = useMemo(() => new Set(changedItems.map((item) => item.productId)), [changedItems]);

  // Filtra en el navegador sobre las filas ya cargadas (sin otro roundtrip). `edits` sigue indexado por row.id, así que ocultar una
  // fila filtrada nunca pierde un cambio pendiente en ella — sólo cambia qué se muestra, no el estado de edición.
  const visibleRefs = useMemo(() => {
    const normalized = normalizeSearchText(search);
    if (!normalized) return refs;
    return refs.filter((ref) => normalizeSearchText(`${ref.row.name} ${ref.row.categoryName}`).includes(normalized));
  }, [refs, search]);

  return <form action={action} className="mt-4">
    <input name="items" type="hidden" value={JSON.stringify(changedItems)} />
    {!marginConfigured ? <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">
      Todavía no configuraste el margen de ganancia: los costos se guardan, pero el precio de venta no se recalcula hasta que lo hagas (arriba, en «Configuración de precios») o le pongas un margen propio al producto.
    </p> : null}
    <label className="mb-3 grid max-w-sm gap-1 text-sm font-medium">
      Buscar
      <input
        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Producto o categoría…"
        type="search"
        value={search}
      />
    </label>
    <div className="overflow-hidden rounded-xl border">
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="sticky top-0 bg-stone-50 text-stone-500"><tr>
            <th className="p-3">Producto</th><th className="p-3">Categoría</th><th className="p-3">Tipo de venta</th>
            <th className="p-3">Nuevo costo</th><th className="p-3">Margen</th><th className="p-3">Precio actual</th>
          </tr></thead>
          <tbody>{visibleRefs.map((ref) => {
            const { row, rule } = ref;
            const suffix = row.unitType === "WEIGHT" ? "/kg" : "/u";
            const edit = edits[row.id];
            const rawCost = edit?.cost ?? "";
            const excluded = row.excludedCategory ?? row.manualPrice;
            const change = marginChange(ref, edit);
            const reset = change === null;
            // El input MUESTRA lo escrito; si no, el margen propio o el global efectivo (vacío en precio manual). No es un override hasta que cambia.
            const marginValue = reset ? "" : edit?.margin ?? bpsToPercentField(displayedMarginBps(ref));
            const invalidMargin = !reset && edit?.margin !== undefined && edit.margin.trim() !== "" && parseMarginBps(edit.margin) === null;
            // Margen con el que va a quedar el precio: el escrito; al volver a lo por defecto, el global (o ninguno si la categoría está excluida); si no, el vigente.
            const finalBps = reset ? (excluded ? null : marginBps) : typeof change === "number" ? change : rule.bps;
            const newCost = parseCostCents(rawCost);
            const costChanged = newCost !== null && newCost !== row.currentCostCents;
            const projectedCost = costChanged ? newCost : row.currentCostCents;
            const source = reset ? (excluded ? "Precio manual" : marginBps === null ? "Sin margen" : "Global")
              : typeof change === "number" ? "Propio"
              : rule.kind === "CUSTOM" ? "Propio" : rule.kind === "GLOBAL" ? "Global" : rule.kind === "MANUAL" ? "Precio manual" : "Sin margen";
            const defaultLabel = excluded ? "Usar precio manual" : "Usar global";
            const showProjection = dirtyIds.has(row.id) && finalBps !== null && projectedCost !== null && projectedCost > 0;
            return <tr className={`border-t ${dirtyIds.has(row.id) ? "bg-amber-50" : ""}`} key={row.id}>
              <td className="p-3 font-bold">{row.name}</td>
              <td className="p-3 text-stone-600">{row.categoryName}</td>
              <td className="p-3 text-stone-600">{row.unitType === "WEIGHT" ? "Peso" : "Unidad"}</td>
              <td className="p-3">
                <input
                  aria-label={`Nuevo costo de ${row.name}`}
                  className={input}
                  min="0.01"
                  onChange={(event) => patch(row.id, { cost: event.target.value })}
                  placeholder={costPlaceholder(row.currentCostCents)}
                  step="0.01"
                  type="number"
                  value={rawCost}
                />
              </td>
              <td className="p-3">
                <span className="flex items-center gap-1">
                  <input
                    aria-invalid={invalidMargin}
                    aria-label={`Margen de ${row.name} (%)`}
                    className={`${marginInput} ${invalidMargin ? "border-red-500" : ""}`}
                    inputMode="decimal"
                    onChange={(event) => patch(row.id, { margin: event.target.value, reset: false })}
                    type="text"
                    value={marginValue}
                  />
                  <span>%</span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
                  <span
                    className={`rounded px-1.5 py-0.5 font-bold ${source === "Propio" ? "bg-violet-100 text-violet-900" : source === "Precio manual" ? "bg-sky-100 text-sky-900" : "bg-stone-100 text-stone-700"}`}
                    data-testid="margin-source"
                    title={source === "Precio manual" ? "Categoría excluida del margen automático: el costo se guarda y el precio queda igual" : source === "Propio" ? "Margen personalizado de este producto" : "Margen general de la organización"}
                  >{source}</span>
                  {ref.customMarginBps !== null && !reset
                    ? <button className="font-bold text-rose-800 underline" data-testid="margin-reset" onClick={() => patch(row.id, { reset: true })} type="button">{defaultLabel}</button>
                    : null}
                  {reset ? <button className="font-bold text-stone-600 underline" data-testid="margin-reset-undo" onClick={() => patch(row.id, { reset: false })} type="button">Deshacer</button> : null}
                </span>
                {invalidMargin ? <span className="block text-xs font-bold text-red-800" data-testid="margin-invalid">Entre 0,01 y 99,99</span> : null}
              </td>
              <td className="p-3">
                {row.currentPriceCents !== null ? `${formatCurrency(BigInt(row.currentPriceCents))} ${suffix}` : "SIN PRECIO"}
                {showProjection
                  ? <span className="ml-2 font-bold text-emerald-800" data-testid="projected-price">{`→ ${formatCurrency(calculateListPriceFromMargin(BigInt(projectedCost), BigInt(finalBps)))}`}</span>
                  : null}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!visibleRefs.length ? <p className="p-8 text-center text-stone-500">{rows.length ? "Ningún producto coincide con la búsqueda." : "No hay productos de venta para cargar costos."}</p> : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-500">{changedItems.length > 0 ? `${String(changedItems.length)} producto(s) modificado(s)` : "Sin cambios"}</p>
      {state.error ? <p className="text-sm font-bold text-red-800">{state.error}</p> : null}
      {state.successToken ? <p className="text-sm font-bold text-emerald-700">
        Guardado ({state.applied ?? 0} costo(s){state.marginsChanged ? `, ${String(state.marginsChanged)} margen(es)` : ""}){state.marginConfigured ? `; precios recalculados: ${String(state.repriced ?? 0)}` : "; margen sin configurar: los precios no cambiaron"}
        {state.scheduledPrice ? `; ${String(state.scheduledPrice)} con precio programado (no se tocó)` : ""}
        {state.manualPrice ? `; ${String(state.manualPrice)} con precio manual (sólo se guardó el costo, el precio quedó igual)` : ""}
        {state.branchOverrides ? `. ATENCIÓN: ${String(state.branchOverrides)} producto(s) tienen un precio propio de sucursal que le gana al precio recalculado en el POS (cerralos desde «Configuración de precios»).` : ""}
      </p> : null}
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={pending || changedItems.length === 0} type="submit">
        {pending ? "Guardando…" : "Guardar cambios"}
      </button>
    </div>
  </form>;
}
