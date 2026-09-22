"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { createStockTransferFormAction, type StockTransferFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface Row { key: string; productId: string; quantityKg: string }

function newRow(productId = "", quantityKg = ""): Row {
  return { key: crypto.randomUUID(), productId, quantityKg };
}

export function TransferForm({ branches, products, initialSourceBranchId, initialItems }: {
  branches: { id: string; name: string }[];
  products: { id: string; name: string }[];
  initialSourceBranchId?: string | undefined;
  initialItems?: { productId: string; weightGrams: number }[] | undefined;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(createStockTransferFormAction, {} as StockTransferFormState);
  const [rows, setRows] = useState<Row[]>(() =>
    initialItems?.length
      ? initialItems.map((item) => newRow(item.productId, (item.weightGrams / 1_000).toString()))
      : [newRow()]
  );

  useEffect(() => {
    if (state.transferId && !state.error) {
      formRef.current?.reset();
      setRows([newRow()]);
    }
  }, [state.error, state.transferId]);

  const addRow = () => setRows((current) => [...current, newRow()]);
  const removeRow = (key: string) => setRows((current) => (current.length > 1 ? current.filter((row) => row.key !== key) : current));

  return <form action={action} className="mt-4 grid gap-3 rounded-2xl border bg-white p-5 shadow-sm" ref={formRef}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-bold">Origen
        <select className={input} defaultValue={initialSourceBranchId ?? ""} name="source_branch_id" required>
          <option value="">Elegí una sucursal…</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Destino
        <select className={input} name="destination_branch_id" required>
          <option value="">Elegí una sucursal…</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
    </div>

    <div className="grid gap-2">
      <p className="text-sm font-bold">Productos</p>
      {rows.map((row) => <div className="flex flex-wrap items-end gap-2" key={row.key}>
        <label className="grid flex-1 gap-1 text-xs font-medium text-stone-500">Producto
          <select className={input} defaultValue={row.productId} name="product_id" required>
            <option value="">Elegí un producto…</option>
            {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-stone-500">Peso (kg)
          <input className={`${input} w-28`} defaultValue={row.quantityKg} min="0.001" name="quantity_kg" required step="0.001" type="number" />
        </label>
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-bold text-stone-500 disabled:opacity-40"
          disabled={rows.length <= 1}
          onClick={() => removeRow(row.key)}
          type="button"
        >Quitar</button>
      </div>)}
      <button className="mt-1 w-fit rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm font-bold text-stone-600 hover:bg-stone-50" onClick={addRow} type="button">+ Agregar línea</button>
    </div>

    <label className="grid gap-1 text-sm font-bold">Notas (opcional)
      <textarea className={input} maxLength={500} name="notes" rows={2} />
    </label>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    {state.transferId && !state.error ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Transferencia registrada.</p> : null}
    <button className="rounded-lg bg-rose-800 px-4 py-3 font-black text-white disabled:opacity-60" disabled={pending}>{pending ? "Confirmando…" : "Confirmar transferencia"}</button>
  </form>;
}
