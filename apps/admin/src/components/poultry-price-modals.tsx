"use client";

import { useState } from "react";

import { formatCurrency } from "@carnicerias/business-logic";

import { getPoultryPriceHistoryAction, savePoultryPriceListAction, savePoultryPricesAction } from "../app/admin/poultry/actions";
import { formatKg, parsePriceHistory, pesosInput, type PoultryPriceHistory, type PoultryPriceList, type PoultryProductRow } from "../lib/poultry";
import { fieldInput, fieldLabel, FormModal, optionalHint } from "./form-modal";

/** Costo y precios de un producto (uno por lista) con vigencia opcional. Cada valor que cambia abre una versión nueva: la historia no se pisa. */
export function PoultryPricesModal({ product, lists }: { product: PoultryProductRow; lists: PoultryPriceList[] }) {
  const unit = product.saleUnit === "WEIGHT" ? "por kg" : "por cajón";
  return <FormModal
    action={savePoultryPricesAction}
    description={`Valores ${unit}. Dejá vacío lo que no cambia; el valor anterior queda en el historial con su vigencia.`}
    submitLabel="Guardar valores"
    title={`Costo y precios — ${product.name}`}
    triggerLabel="Costo y precios"
    wide
  >
    <input name="product_id" type="hidden" value={product.id} />
    <label className={fieldLabel}>Costo {unit} ($)<input className={fieldInput} defaultValue={pesosInput(product.costCents)} inputMode="decimal" name="cost" placeholder="45000" /></label>
    <div className="grid gap-3 sm:grid-cols-2">
      {lists.filter((list) => list.active).map((list) => (
        <label className={fieldLabel} key={list.id}>Precio {list.name} ($){list.isDefault ? <span className={optionalHint}> · lista general</span> : null}
          <input className={fieldInput} defaultValue={pesosInput(product.prices[list.id]?.cents ?? null)} inputMode="decimal" name={`price_${list.id}`} />
        </label>
      ))}
    </div>
    <label className={fieldLabel}>Vigente desde <span className={optionalHint}>opcional · vacío = ahora · una fecha futura queda programada</span><input className={fieldInput} name="effective_from" type="datetime-local" /></label>
  </FormModal>;
}

export function PoultryPriceListModal({ list }: { list?: PoultryPriceList }) {
  return <FormModal
    action={savePoultryPriceListAction}
    description="Una lista de precios por tipo de cliente (Mayorista, Clientes especiales…). Cada cliente puede tener una asignada."
    submitLabel={list ? "Guardar cambios" : "Crear lista"}
    title={list ? `Editar lista — ${list.name}` : "Nueva lista de precios"}
    triggerClassName={list ? "rounded-lg border px-2 py-1 text-xs font-bold" : "rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50"}
    triggerLabel={list ? "Editar" : "+ Nueva lista"}
  >
    {list ? <input name="price_list_id" type="hidden" value={list.id} /> : null}
    <label className={fieldLabel}>Nombre<input autoFocus className={fieldInput} defaultValue={list?.name ?? ""} maxLength={80} name="name" placeholder="Mayorista" required /></label>
    <label className={fieldLabel}>Notas <span className={optionalHint}>opcional</span><textarea className={fieldInput} defaultValue={list?.notes ?? ""} maxLength={500} name="notes" rows={2} /></label>
    {list?.isDefault ? <p className="text-sm text-stone-600">La lista General es el respaldo de todos los clientes: no se puede desactivar.</p>
      : <label className="flex items-center gap-2 text-sm"><input defaultChecked={list?.active ?? true} name="active" type="checkbox" /> Lista activa</label>}
  </FormModal>;
}

/** Historia de costos y precios de un producto (se lee al abrir; nunca se reescribe). */
export function PoultryPriceHistory({ productId, productName, timeZone }: { productId: string; productName: string; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<PoultryPriceHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) => new Date(iso).toLocaleString("es-AR", { timeZone, dateStyle: "short", timeStyle: "short" });
  const range = (from: string, to: string | null) => `${date(from)} → ${to ? date(to) : "vigente"}`;

  async function show() {
    setOpen(true);
    setError(null);
    const result = await getPoultryPriceHistoryAction(productId);
    if ("error" in result) setError(result.error); else setHistory(parsePriceHistory(result.data));
  }

  return <>
    <button className="rounded-lg border px-3 py-2 text-sm font-bold" onClick={() => { void show(); }} type="button">Historial</button>
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}>
      <section aria-modal="true" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 text-left shadow-xl" role="dialog">
        <div className="flex items-start justify-between gap-3"><h2 className="text-xl font-black">Historial — {productName}</h2><button aria-label="Cerrar" className="text-xl text-stone-500" onClick={() => { setOpen(false); }} type="button">×</button></div>
        {error ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
        {!history && !error ? <p className="mt-4 text-sm text-stone-500">Cargando…</p> : null}
        {history ? <div className="mt-4 grid gap-5 text-sm">
          <HistoryTable empty="Sin costos cargados." rows={history.costs.map((row) => ({ label: "Costo", value: formatCurrency(row.cents), range: range(row.from, row.to) }))} title="Costos" />
          <HistoryTable empty="Sin precios de lista." rows={history.listPrices.map((row) => ({ label: row.listName, value: formatCurrency(row.cents), range: range(row.from, row.to) }))} title="Precios por lista" />
          <HistoryTable empty="Sin precios especiales." rows={history.customerPrices.map((row) => ({ label: row.customerName, value: formatCurrency(row.cents), range: range(row.from, row.to) }))} title="Precios por cliente" />
          <p className="text-xs text-stone-500">Los pedidos conservan el precio con el que se tomaron y el costo de cuando se entregaron: estos cambios no los modifican.</p>
        </div> : null}
      </section>
    </div> : null}
  </>;
}

function HistoryTable({ title, rows, empty }: { title: string; rows: { label: string; value: string; range: string }[]; empty: string }) {
  return <div>
    <h3 className="font-black">{title}</h3>
    {rows.length === 0 ? <p className="mt-1 text-stone-500">{empty}</p> : <table className="mt-1 w-full text-left"><tbody>{rows.map((row, index) => (
      <tr className="border-b border-stone-100" key={`${row.label}-${String(index)}`}><td className="py-1.5 pr-3 font-semibold">{row.label}</td><td className="py-1.5 pr-3 font-bold">{row.value}</td><td className="py-1.5 text-xs text-stone-500">{row.range}</td></tr>
    ))}</tbody></table>}
  </div>;
}

export function referenceWeightText(product: Pick<PoultryProductRow, "referenceWeightGrams">): string | null {
  return product.referenceWeightGrams ? formatKg(product.referenceWeightGrams) : null;
}
