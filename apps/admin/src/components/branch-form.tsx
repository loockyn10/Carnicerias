"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { saveBranchFormAction, type BranchFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

interface BranchFormProps {
  branch?: { id: string; name: string; code: string; address: string | null; active: boolean };
}

export function BranchForm({ branch }: BranchFormProps) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveBranchFormAction, {} as BranchFormState);

  useEffect(() => {
    if (!state.branchId || state.error || branch) return;
    router.push(`/admin/branches/${state.branchId}`);
  }, [branch, router, state.branchId, state.error]);

  return <form action={action} className="grid gap-4">
    {branch ? <input name="branch_id" type="hidden" value={branch.id} /> : null}
    <label className="grid gap-1 text-sm font-bold">Nombre
      <input className={input} defaultValue={branch?.name} maxLength={120} minLength={2} name="name" required />
    </label>
    <label className="grid gap-1 text-sm font-bold">Código
      <input
        className={`${input} uppercase`}
        defaultValue={branch?.code}
        maxLength={20}
        minLength={2}
        name="code"
        pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,19}"
        placeholder="p. ej. CENTRAL"
        required
        title="Sólo letras, números, guiones o guión bajo, empezando con letra o número"
      />
      <span className="font-normal text-stone-500">Identificador corto y único para esta sucursal. No se usa como nombre visible.</span>
    </label>
    <label className="grid gap-1 text-sm font-bold">Dirección <span className="font-normal text-stone-500">(opcional)</span>
      <input className={input} defaultValue={branch?.address ?? ""} maxLength={200} name="address" />
    </label>
    <label className="flex items-center gap-2 text-sm font-bold">
      <input defaultChecked={branch?.active ?? true} name="active" type="checkbox" /> Activa
    </label>
    {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
    <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending} type="submit">
      {pending ? "Guardando…" : branch ? "Guardar cambios" : "Crear sucursal"}
    </button>
  </form>;
}
