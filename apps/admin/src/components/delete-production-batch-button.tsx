"use client";

import { deleteProductionBatchAction } from "../app/admin/actions";

export function DeleteProductionBatchButton({ batchId }: { batchId: string }) {
  return <form
    action={deleteProductionBatchAction}
    onSubmit={(event) => {
      if (!window.confirm("¿Eliminar este desposte? Esta acción no se puede deshacer.")) event.preventDefault();
    }}
  >
    <input name="batch_id" type="hidden" value={batchId} />
    <button className="text-sm font-bold text-red-700 hover:underline" type="submit">Eliminar desposte</button>
  </form>;
}
