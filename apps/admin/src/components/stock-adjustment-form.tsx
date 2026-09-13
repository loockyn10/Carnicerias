"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { recordAdjustmentFormAction, type StockAdjustmentState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export function StockAdjustmentForm({ branches, products }: { branches: { id: string; name: string }[]; products: { id: string; name: string }[] }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [state, action, pending] = useActionState(recordAdjustmentFormAction, {} as StockAdjustmentState);

  useEffect(() => {
    submittingRef.current = false;
    setSubmitting(false);
    if (state.successToken) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [router, state.error, state.successToken]);

  return <form action={action} className="mt-4 grid gap-3" onSubmit={(event) => {
    if (submittingRef.current) {
      event.preventDefault();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
  }} ref={formRef}>
    <select className={input} name="branch_id" required><option value="">Sucursal</option>{branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <select className={input} name="product_id" required><option value="">Producto</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <input className={input} min="0" name="physical_kg" placeholder="Stock físico kg" required step="0.001" type="number" />
    <input className={input} name="note" placeholder="Motivo / observación" required />
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    {state.successToken ? <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Ajuste registrado correctamente.</p> : null}
    <button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white disabled:opacity-60" disabled={submitting || pending}>{submitting || pending ? "Guardando…" : "Registrar ajuste"}</button>
  </form>;
}
