"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { setProductionBatchOutputFormAction, type ProductionBatchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

interface OutputProduct { id: string; name: string; unit_type: "WEIGHT" | "UNIT"; approx_weight_grams: number | null }

export function AddProductionBatchOutputForm({ batchId, products }: { batchId: string; products: OutputProduct[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [productId, setProductId] = useState("");
  const [state, action, pending] = useActionState(setProductionBatchOutputFormAction, {} as ProductionBatchFormState);
  const selected = products.find((product) => product.id === productId) ?? null;

  useEffect(() => {
    if (state.batchId && !state.error) {
      formRef.current?.reset();
      setProductId("");
    }
  }, [state.batchId, state.error]);

  return <form action={action} className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-stone-300 p-3" ref={formRef}>
    <input name="batch_id" type="hidden" value={batchId} />
    <label className="grid gap-1 text-sm font-bold">Producto
      <select className={input} name="product_id" onChange={(event) => setProductId(event.target.value)} required value={productId}>
        <option value="">Elegí un producto…</option>
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select>
    </label>
    <label className="grid gap-1 text-sm font-bold">{selected?.unit_type === "UNIT" ? "Peso real obtenido (kg)" : "Peso obtenido (kg)"}
      <input className={`${input} w-32`} min="0.001" name="output_weight_kg" required step="0.001" type="number" />
    </label>
    {selected?.unit_type === "UNIT" ? <label className="grid gap-1 text-sm font-bold">Cantidad de unidades obtenidas
      <input className={`${input} w-32`} min="1" name="output_quantity_units" required step="1" type="number" />
    </label> : null}
    {selected?.unit_type === "UNIT" && selected.approx_weight_grams ? <p className="w-full text-xs text-stone-500">Referencia: ~{(selected.approx_weight_grams / 1000).toLocaleString("es-AR")} kg por unidad (informativo). El peso real de esta producción se carga arriba y sí cuenta para la merma; la cantidad de unidades es lo que define el valor comercial y el costo por unidad.</p> : null}
    <button className="rounded-lg bg-stone-900 px-4 py-2 font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Agregando…" : "+ Agregar producto"}</button>
    {state.error ? <p className="w-full rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
  </form>;
}
