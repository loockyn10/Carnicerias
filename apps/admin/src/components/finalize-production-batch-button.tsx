"use client";

import { useActionState } from "react";

import { completeProductionBatchFormAction, type ProductionBatchFormState } from "../app/admin/actions";

export function FinalizeProductionBatchButton({ batchId, disabled }: { batchId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(completeProductionBatchFormAction, {} as ProductionBatchFormState);

  return <form
    action={action}
    onSubmit={(event) => {
      if (!window.confirm("¿Finalizar este desposte? Una vez finalizado no podrá modificarse.")) event.preventDefault();
    }}
  >
    <input name="batch_id" type="hidden" value={batchId} />
    {state.error ? <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    <button
      className="w-full rounded-lg bg-emerald-700 px-4 py-3 font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled || pending}
      type="submit"
    >
      {pending ? "Finalizando…" : "Finalizar desposte"}
    </button>
  </form>;
}
