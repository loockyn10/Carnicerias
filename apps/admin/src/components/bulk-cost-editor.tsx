"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useActionState, useEffect, useMemo, useState } from "react";

import { bulkSetProductCostsAction, type BulkCostState } from "../app/admin/actions";
import { changedCostItems, costPlaceholder } from "../lib/bulk-costs";
import { normalizeSearchText } from "../lib/text-search";

const input = "w-32 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";

export interface BulkCostRow {
  id: string;
  name: string;
  categoryName: string;
  unitType: "WEIGHT" | "UNIT";
  /** Costo vigente en centavos (null = sin costo). Sólo se usa como referencia (placeholder) y para detectar cambios. */
  currentCostCents: number | null;
  /** Precio de lista vigente en centavos (null = sin precio). Dato de referencia: acá nunca se edita. */
  currentPriceCents: number | null;
}

/**
 * Carga masiva de COSTOS (D-068): una fila por producto; Fran escribe los costos nuevos de una factura y el precio de venta se
 * recalcula en el servidor con el margen global, en la misma operación que guarda cada costo. Sólo se envían las filas cuyo costo
 * realmente cambió. Los precios de lista no se escriben acá (la columna «Precio actual» es de sólo lectura).
 */
export function BulkCostEditor({ rows, marginConfigured }: { rows: BulkCostRow[]; marginConfigured: boolean }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [state, action, pending] = useActionState(bulkSetProductCostsAction, {} as BulkCostState);

  useEffect(() => {
    if (state.successToken) setEdits({});
  }, [state.successToken]);

  const changedItems = useMemo(() => changedCostItems(rows, edits), [edits, rows]);
  const dirtyIds = useMemo(() => new Set(changedItems.map((item) => item.productId)), [changedItems]);

  // Filtra en el navegador sobre las filas ya cargadas (sin otro roundtrip). `edits` sigue indexado por row.id, así que ocultar una
  // fila filtrada nunca pierde un cambio pendiente en ella — sólo cambia qué se muestra, no el estado de edición.
  const visibleRows = useMemo(() => {
    const normalized = normalizeSearchText(search);
    if (!normalized) return rows;
    return rows.filter((row) => normalizeSearchText(`${row.name} ${row.categoryName}`).includes(normalized));
  }, [rows, search]);

  return <form action={action} className="mt-4">
    <input name="items" type="hidden" value={JSON.stringify(changedItems)} />
    {!marginConfigured ? <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">
      Todavía no configuraste el margen de ganancia: los costos se guardan, pero el precio de venta no se recalcula hasta que lo hagas (arriba, en «Configuración de precios»).
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
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="sticky top-0 bg-stone-50 text-stone-500"><tr>
            <th className="p-3">Producto</th><th className="p-3">Categoría</th><th className="p-3">Tipo de venta</th>
            <th className="p-3">Nuevo costo</th><th className="p-3">Precio actual</th>
          </tr></thead>
          <tbody>{visibleRows.map((row) => {
            const suffix = row.unitType === "WEIGHT" ? "/kg" : "/u";
            const raw = edits[row.id] ?? "";
            return <tr className={`border-t ${dirtyIds.has(row.id) ? "bg-amber-50" : ""}`} key={row.id}>
              <td className="p-3 font-bold">{row.name}</td>
              <td className="p-3 text-stone-600">{row.categoryName}</td>
              <td className="p-3 text-stone-600">{row.unitType === "WEIGHT" ? "Peso" : "Unidad"}</td>
              <td className="p-3">
                <input
                  aria-label={`Nuevo costo de ${row.name}`}
                  className={input}
                  min="0.01"
                  onChange={(event) => setEdits((current) => ({ ...current, [row.id]: event.target.value }))}
                  placeholder={costPlaceholder(row.currentCostCents)}
                  step="0.01"
                  type="number"
                  value={raw}
                />
              </td>
              <td className="p-3">{row.currentPriceCents !== null ? `${formatCurrency(BigInt(row.currentPriceCents))} ${suffix}` : "SIN PRECIO"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!visibleRows.length ? <p className="p-8 text-center text-stone-500">{rows.length ? "Ningún producto coincide con la búsqueda." : "No hay productos de venta para cargar costos."}</p> : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-500">{changedItems.length > 0 ? `${String(changedItems.length)} costo(s) modificado(s)` : "Sin cambios"}</p>
      {state.error ? <p className="text-sm font-bold text-red-800">{state.error}</p> : null}
      {state.successToken ? <p className="text-sm font-bold text-emerald-700">
        Guardado ({state.applied ?? 0} costo(s)){state.marginConfigured ? `; precios recalculados: ${String(state.repriced ?? 0)}` : "; margen sin configurar: los precios no cambiaron"}
        {state.scheduledPrice ? `; ${String(state.scheduledPrice)} con precio programado (no se tocó)` : ""}
        {state.branchOverrides ? `. ATENCIÓN: ${String(state.branchOverrides)} producto(s) tienen un precio propio de sucursal que le gana al precio recalculado en el POS (cerralos desde «Configuración de precios»).` : ""}
      </p> : null}
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={pending || changedItems.length === 0} type="submit">
        {pending ? "Guardando…" : "Guardar cambios"}
      </button>
    </div>
  </form>;
}
