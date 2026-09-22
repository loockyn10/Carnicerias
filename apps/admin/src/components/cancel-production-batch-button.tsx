"use client";

import { cancelProductionBatchAction } from "../app/admin/actions";

export function CancelProductionBatchButton({ batchId }: { batchId: string }) {
  return <form
    action={cancelProductionBatchAction}
    onSubmit={(event) => {
      if (!window.confirm("¿Cancelar este borrador de desposte?")) event.preventDefault();
    }}
  >
    <input name="batch_id" type="hidden" value={batchId} />
    <button className="rounded-lg border border-red-800 px-4 py-2 text-sm font-bold text-red-800 hover:bg-red-50" type="submit">Cancelar borrador</button>
  </form>;
}
