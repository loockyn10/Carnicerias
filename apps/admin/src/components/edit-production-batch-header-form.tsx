"use client";

import { useActionState } from "react";

import { updateProductionBatchHeaderFormAction, type ProductionBatchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export function EditProductionBatchHeaderForm({ batch, products }: {
  batch: {
    id: string;
    sourceProductId: string;
    description: string | null;
    inputWeightGrams: number;
    costPerKgCents: number;
    notes: string | null;
  };
  products: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(updateProductionBatchHeaderFormAction, {} as ProductionBatchFormState);

  return <form
    action={action}
    className="mt-4 grid gap-3"
    key={`${batch.sourceProductId}-${String(batch.inputWeightGrams)}-${String(batch.costPerKgCents)}-${batch.description ?? ""}-${batch.notes ?? ""}`}
  >
    <input name="batch_id" type="hidden" value={batch.id} />
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold">Producto / insumo de origen
        <select className={input} defaultValue={batch.sourceProductId} name="source_product_id" required>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Descripción (opcional)
        <input className={input} defaultValue={batch.description ?? ""} maxLength={200} name="description" />
      </label>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold">Peso de entrada (kg)
        <input className={input} defaultValue={batch.inputWeightGrams / 1_000} min="0.001" name="input_weight_kg" required step="0.001" type="number" />
      </label>
      <label className="grid gap-1 text-sm font-bold">Costo de compra por kg
        <input className={input} defaultValue={(batch.costPerKgCents / 100).toString()} inputMode="decimal" name="cost_per_kg" required />
      </label>
    </div>
    <label className="grid gap-1 text-sm font-bold">Notas (opcional)
      <textarea className={input} defaultValue={batch.notes ?? ""} maxLength={1000} name="notes" rows={2} />
    </label>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    {!state.error && state.batchId ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Cambios guardados.</p> : null}
    <button className="rounded-lg border border-rose-800 px-4 py-2 font-bold text-rose-800 disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar cambios"}</button>
  </form>;
}
