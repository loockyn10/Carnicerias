"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { confirmSettlementFormAction, type SettlementFormState } from "../app/admin/actions";
import { parsePesosToCents, settlementDifference } from "../lib/settlements";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export function SettlementConfirmationForm({ branchId, branchName, periodStart, periodEnd, expectedCashCents }: {
  branchId: string;
  branchName: string;
  periodStart: string;
  periodEnd: string;
  expectedCashCents: number;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(confirmSettlementFormAction, {} as SettlementFormState);
  const [received, setReceived] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [localError, setLocalError] = useState("");
  let receivedCents: number | null = null;
  try { receivedCents = received ? parsePesosToCents(received) : null; } catch { receivedCents = null; }
  const difference = receivedCents === null ? null : settlementDifference(expectedCashCents, receivedCents);

  useEffect(() => {
    if (state.settlementId) router.replace(`/admin/settlements?settlement=${state.settlementId}`);
    if (state.error) setReviewing(false);
  }, [router, state.error, state.settlementId]);

  const review = () => {
    if (receivedCents === null) { setLocalError("Ingresá un importe válido, incluso si es 0."); return; }
    setLocalError("");
    setReviewing(true);
  };

  return <form action={action} className="rounded-2xl border bg-white p-5 shadow-sm">
    <input name="branch_id" type="hidden" value={branchId} />
    <input name="period_start" type="hidden" value={periodStart} />
    <input name="period_end" type="hidden" value={periodEnd} />
    <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-stone-950 p-4 text-white"><p className="text-sm text-stone-300">Efectivo esperado</p><strong className="mt-1 block text-2xl">{formatCurrency(BigInt(expectedCashCents))}</strong></div><label className="grid gap-1 rounded-xl bg-stone-50 p-4 text-sm font-bold">Efectivo recibido<input className={input} inputMode="decimal" name="received_cash" onChange={(event) => setReceived(event.target.value)} placeholder="$ 0" required value={received} /></label><div className={`rounded-xl p-4 ${difference === 0 ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}><p className="text-sm">Diferencia de rendición</p><strong className="mt-1 block text-2xl">{difference === null ? "—" : formatCurrency(BigInt(difference))}</strong></div></div>
    <label className="mt-4 grid gap-1 text-sm font-bold">Observación opcional<textarea className={input} maxLength={500} name="notes" placeholder="Ej.: Quedaron $3.000 para cambio" rows={3} /></label>
    {localError || state.error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{localError || state.error}</p> : null}
    <button className="mt-4 w-full rounded-lg bg-rose-800 px-4 py-3 font-black text-white hover:bg-rose-700" onClick={review} type="button">Revisar rendición</button>

    {reviewing && receivedCents !== null && difference !== null ? <div aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-stone-950/55 p-4" role="dialog"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><p className="text-xs font-black uppercase tracking-wide text-rose-800">Confirmar rendición</p><h2 className="mt-1 text-xl font-black">{branchName}</h2><p className="mt-1 text-sm text-stone-500">{periodStart.replace("T", " ")} → {periodEnd.replace("T", " ")}</p><dl className="mt-5 space-y-3"><div className="flex justify-between"><dt>Esperado en efectivo</dt><dd className="font-black">{formatCurrency(BigInt(expectedCashCents))}</dd></div><div className="flex justify-between"><dt>Recibido</dt><dd className="font-black">{formatCurrency(BigInt(receivedCents))}</dd></div><div className="flex justify-between border-t pt-3"><dt>Diferencia</dt><dd className="font-black">{formatCurrency(BigInt(difference))}</dd></div></dl><div className="mt-6 grid grid-cols-2 gap-3"><button className="rounded-lg border px-4 py-2 font-bold" onClick={() => setReviewing(false)} type="button">Cancelar</button><button className="rounded-lg bg-rose-800 px-4 py-2 font-black text-white disabled:opacity-60" disabled={pending}>{pending ? "Confirmando…" : "Confirmar"}</button></div></div></div> : null}
  </form>;
}
