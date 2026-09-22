"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { createProductionBatchFormAction, type ProductionBatchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export function CreateProductionBatchForm({ products, productionBranchName }: {
  products: { id: string; name: string }[];
  productionBranchName: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(createProductionBatchFormAction, {} as ProductionBatchFormState);

  useEffect(() => {
    if (state.batchId) router.replace(`/admin/production?batch=${state.batchId}`);
  }, [router, state.batchId]);

  return <form action={action} className="mt-4 grid gap-3 rounded-2xl border bg-white p-5 shadow-sm">
    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Stock generado en: <span className="text-stone-700">{productionBranchName}</span></p>
    <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
      <label className="grid gap-1 text-sm font-bold">Producto / insumo de origen
        <select className={input} name="source_product_id" required>
          <option value="">Elegí un producto…</option>
          {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Cantidad de unidades (opcional)
        <input className={input} min="1" name="input_unit_count" placeholder="5" step="1" type="number" />
      </label>
    </div>
    <label className="grid gap-1 text-sm font-bold">Descripción (opcional)
      <input className={input} maxLength={200} name="description" placeholder="Media res de cerdo #1" />
    </label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold">Peso de entrada total (kg)
        <input className={input} min="0.001" name="input_weight_kg" placeholder="20" required step="0.001" type="number" />
      </label>
      <label className="grid gap-1 text-sm font-bold">Costo de compra por kg
        <input className={input} inputMode="decimal" name="cost_per_kg" placeholder="4.200" required />
      </label>
    </div>
    <label className="grid gap-1 text-sm font-bold">Notas (opcional)
      <textarea className={input} maxLength={1000} name="notes" rows={2} />
    </label>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    <button className="rounded-lg bg-rose-800 px-4 py-3 font-black text-white disabled:opacity-60" disabled={pending}>{pending ? "Creando…" : "Crear desposte"}</button>
  </form>;
}
