"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { type SettlementFormState, voidSettlementFormAction } from "../app/admin/actions";

export function VoidSettlementForm({ settlementId }: { settlementId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(voidSettlementFormAction, {} as SettlementFormState);
  useEffect(() => {
    if (state.settlementId) { router.replace("/admin/settlements"); router.refresh(); }
  }, [router, state.settlementId]);
  return <details className="mt-6 border-t pt-4"><summary className="cursor-pointer text-sm font-bold text-red-800">Anular rendición</summary><form action={action} className="mt-3 flex flex-col gap-2 sm:flex-row"><input name="settlement_id" type="hidden" value={settlementId} /><input className="min-w-0 flex-1 rounded-lg border px-3 py-2" maxLength={500} minLength={3} name="reason" placeholder="Motivo obligatorio" required /><button className="rounded-lg border border-red-200 px-4 py-2 font-bold text-red-800 disabled:opacity-60" disabled={pending}>{pending ? "Anulando…" : "Confirmar anulación"}</button></form>{state.error ? <p className="mt-2 text-sm text-red-700">{state.error}</p> : null}</details>;
}
