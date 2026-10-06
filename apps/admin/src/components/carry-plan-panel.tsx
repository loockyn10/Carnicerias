"use client";

import { useState, useTransition } from "react";

import { calculateCarryPlanAction } from "../app/admin/actions";
import { initialCarryInputs, type CarryPlanReport } from "../lib/carry-plan";
import { CarryPlanReportView } from "./carry-plan-report";

/**
 * Informe operativo "Qué llevar ahora", bajo demanda. `branchId` = una sucursal; null = todas las
 * sucursales no productivas (la sucursal productiva es el origen, nunca un destino). Sólo lee:
 * "A llevar ahora" es estado de la pantalla (no se guarda ni crea movimientos ni transferencias).
 */
export function CarryPlanPanel({ branchId, branchName, timeZone }: { branchId: string | null; branchName?: string; timeZone: string }) {
  const [report, setReport] = useState<CarryPlanReport | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const single = branchId !== null;

  function calculate() {
    startTransition(async () => {
      try {
        const result = await calculateCarryPlanAction(branchId);
        if (result.error !== undefined) { setError(result.error); return; }
        setError(null);
        setReport(result.report);
        setInputs(initialCarryInputs(result.report.rows));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "No se pudo calcular el informe.");
      }
    });
  }

  return <section aria-label={single ? "Qué llevar ahora" : "Carga de sucursales"} className="mt-5 rounded-xl border bg-white p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-black">{single ? "Qué llevar ahora" : "Carga de sucursales"}</h2>
        <p className="text-sm text-stone-500">{single ? "Cuánto convendría llevar desde la sucursal productiva, según lo vendido en los últimos 7 días y lo que queda hoy." : "Cuánto convendría llevar a cada sucursal, según lo vendido en los últimos 7 días y lo que queda hoy."}</p>
      </div>
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending} onClick={calculate} type="button">
        {pending ? "Calculando…" : report ? "Recalcular" : single ? "Calcular qué llevar ahora" : "Calcular carga de sucursales"}
      </button>
    </div>
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {report ? <CarryPlanReportView branchName={branchName} inputs={inputs} onInput={(key, value) => setInputs((current) => ({ ...current, [key]: value }))} onReset={() => setInputs(initialCarryInputs(report.rows))} onShowAll={setShowAll} report={report} showAll={showAll} single={single} timeZone={timeZone} /> : null}
  </section>;
}
