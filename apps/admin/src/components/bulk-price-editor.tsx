"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useActionState, useEffect, useMemo, useState } from "react";

import { bulkSetProductPricesAction, type BulkPriceState } from "../app/admin/actions";
import { normalizeSearchText } from "../lib/text-search";

const input = "w-32 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";

export interface BulkPriceRow {
  id: string;
  name: string;
  categoryName: string;
  unitType: "WEIGHT" | "UNIT";
  currentPriceCents: number | null;
}

function parseCents(value: string): number | null {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

/**
 * Carga masiva y rápida de precios de venta (precio global, todas las sucursales): una fila por
 * producto, sólo se envían al guardar las filas que realmente cambiaron. No reemplaza los
 * overrides por sucursal existentes (siguen editables uno por uno desde setPriceAction).
 */
export function BulkPriceEditor({ rows }: { rows: BulkPriceRow[] }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [state, action, pending] = useActionState(bulkSetProductPricesAction, {} as BulkPriceState);

  useEffect(() => {
    if (state.successToken) setEdits({});
  }, [state.successToken]);

  const changedItems = useMemo(() => {
    const items: { productId: string; priceCents: number }[] = [];
    for (const row of rows) {
      const raw = edits[row.id];
      if (raw === undefined || raw === "") continue;
      const priceCents = parseCents(raw);
      if (priceCents !== null && priceCents !== row.currentPriceCents) items.push({ productId: row.id, priceCents });
    }
    return items;
  }, [edits, rows]);

  // Filtra en el navegador sobre las filas ya cargadas (sin otro roundtrip). `edits` sigue
  // indexado por row.id, así que ocultar una fila filtrada nunca pierde un cambio pendiente en
  // ella — sólo cambia qué se muestra, no el estado de edición.
  const visibleRows = useMemo(() => {
    const normalized = normalizeSearchText(search);
    if (!normalized) return rows;
    return rows.filter((row) => normalizeSearchText(`${row.name} ${row.categoryName}`).includes(normalized));
  }, [rows, search]);

  return <form action={action} className="mt-4">
    <input name="items" type="hidden" value={JSON.stringify(changedItems)} />
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
            <th className="p-3">Precio actual</th><th className="p-3">Nuevo precio</th>
          </tr></thead>
          <tbody>{visibleRows.map((row) => {
            const suffix = row.unitType === "WEIGHT" ? "/kg" : "/u";
            const raw = edits[row.id] ?? "";
            const isDirty = changedItems.some((item) => item.productId === row.id);
            return <tr className={`border-t ${isDirty ? "bg-amber-50" : ""}`} key={row.id}>
              <td className="p-3 font-bold">{row.name}</td>
              <td className="p-3 text-stone-600">{row.categoryName}</td>
              <td className="p-3 text-stone-600">{row.unitType === "WEIGHT" ? "Peso" : "Unidad"}</td>
              <td className="p-3">{row.currentPriceCents !== null ? `${formatCurrency(BigInt(row.currentPriceCents))} ${suffix}` : "SIN PRECIO"}</td>
              <td className="p-3">
                <input
                  className={input}
                  min="0.01"
                  onChange={(event) => setEdits((current) => ({ ...current, [row.id]: event.target.value }))}
                  placeholder={row.currentPriceCents !== null ? String(row.currentPriceCents / 100) : "0.00"}
                  step="0.01"
                  type="number"
                  value={raw}
                />
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!visibleRows.length ? <p className="p-8 text-center text-stone-500">{rows.length ? "Ningún producto coincide con la búsqueda." : "No hay productos de venta para cargar precio."}</p> : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-500">{changedItems.length > 0 ? `${String(changedItems.length)} precio(s) modificado(s)` : "Sin cambios"}</p>
      {state.error ? <p className="text-sm font-bold text-red-800">{state.error}</p> : null}
      {state.successToken ? <p className="text-sm font-bold text-emerald-700">Guardado ({state.applied ?? 0} precio(s))</p> : null}
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={pending || changedItems.length === 0} type="submit">
        {pending ? "Guardando…" : "Guardar cambios"}
      </button>
    </div>
  </form>;
}
