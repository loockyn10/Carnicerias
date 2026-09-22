"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { setProductionBranchFormAction, type ProductionBranchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export function SetProductionBranchForm({ branches, currentBranchId }: {
  branches: { id: string; name: string }[];
  currentBranchId: string | null;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(setProductionBranchFormAction, {} as ProductionBranchFormState);

  useEffect(() => {
    if (state.successToken) router.refresh();
  }, [router, state.successToken]);

  return <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
    <label className="grid gap-1 text-sm font-bold">Sucursal
      <select className={input} defaultValue={currentBranchId ?? ""} name="branch_id" required>
        <option disabled value="">Elegí una sucursal…</option>
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select>
    </label>
    <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
    {state.error ? <p className="w-full rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
  </form>;
}
