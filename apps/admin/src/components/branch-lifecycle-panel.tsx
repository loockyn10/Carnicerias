"use client";

import { useActionState } from "react";

import { deleteBranchFormAction, setBranchActiveFormAction, type BranchFormState } from "../app/admin/actions";

export function BranchLifecyclePanel({ branchId, active }: { branchId: string; active: boolean }) {
  const [toggleState, toggleAction, togglePending] = useActionState(setBranchActiveFormAction, {} as BranchFormState);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteBranchFormAction, {} as BranchFormState);

  return <div className="grid gap-3">
    <form
      action={toggleAction}
      onSubmit={(event) => {
        const message = active
          ? "¿Desactivar esta sucursal? Deja de operar pero conserva todo su historial."
          : "¿Reactivar esta sucursal?";
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      <input name="branch_id" type="hidden" value={branchId} />
      <input name="active" type="hidden" value={active ? "" : "on"} />
      <button
        className="w-full rounded-lg border px-4 py-3 font-bold hover:border-rose-300 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={togglePending}
        type="submit"
      >
        {togglePending ? "Guardando…" : active ? "Desactivar sucursal" : "Reactivar sucursal"}
      </button>
    </form>
    {toggleState.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{toggleState.error}</p> : null}

    <form
      action={deleteAction}
      onSubmit={(event) => {
        if (!window.confirm("¿Eliminar esta sucursal definitivamente? Sólo es posible si nunca tuvo ventas, stock, turnos, dispositivos ni otro historial. Esta acción no se puede deshacer.")) {
          event.preventDefault();
        }
      }}
    >
      <input name="branch_id" type="hidden" value={branchId} />
      <button
        className="w-full rounded-lg border border-red-300 px-4 py-3 font-bold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={deletePending}
        type="submit"
      >
        {deletePending ? "Eliminando…" : "Eliminar sucursal (sólo sin historial)"}
      </button>
    </form>
    {deleteState.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{deleteState.error}</p> : null}
  </div>;
}
