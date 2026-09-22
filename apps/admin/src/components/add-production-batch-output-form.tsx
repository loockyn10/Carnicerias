"use client";

import { useActionState, useEffect, useRef } from "react";

import { setProductionBatchOutputFormAction, type ProductionBatchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export function AddProductionBatchOutputForm({ batchId, products }: { batchId: string; products: { id: string; name: string }[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(setProductionBatchOutputFormAction, {} as ProductionBatchFormState);

  useEffect(() => {
    if (state.batchId && !state.error) {
      formRef.current?.reset();
    }
  }, [state.batchId, state.error]);

  return <form action={action} className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-stone-300 p-3" ref={formRef}>
    <input name="batch_id" type="hidden" value={batchId} />
    <label className="grid gap-1 text-sm font-bold">Producto
      <select className={input} name="product_id" required>
        <option value="">Elegí un producto…</option>
        {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </select>
    </label>
    <label className="grid gap-1 text-sm font-bold">Peso obtenido (kg)
      <input className={`${input} w-32`} min="0.001" name="output_weight_kg" required step="0.001" type="number" />
    </label>
    <button className="rounded-lg bg-stone-900 px-4 py-2 font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Agregando…" : "+ Agregar producto"}</button>
    {state.error ? <p className="w-full rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
  </form>;
}
