"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

import { calculateCarryPlanAction } from "../app/admin/actions";
import { initialCarryInputs, type CarryPlanReport } from "../lib/carry-plan";
import { CarryPlanReportView } from "./carry-plan-report";
import { OverlayDialog } from "./overlay-dialog";

/**
 * «Qué llevar a <sucursal>» en un modal del Resumen. Es el MISMO informe que el panel de Sucursales
 * (`get_branch_carry_plan` → `CarryPlanReportView`): se calcula al abrir y se puede recalcular; las cantidades «A llevar
 * ahora» son editables y viven sólo en la pantalla (no crea transferencias ni movimientos).
 */
export function CarryPlanModal({ branchId, branchName, timeZone, onClose }: { branchId: string; branchName: string; timeZone: string; onClose: () => void }) {
  const [report, setReport] = useState<CarryPlanReport | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const calculate = useCallback(() => {
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
  }, [branchId]);

  useEffect(() => { calculate(); }, [calculate]);

  return <OverlayDialog onClose={onClose} subtitle={`${branchName} · últimos 7 días, según lo vendido y lo que queda hoy`} title="Qué llevar ahora" wide>
    <div className="mt-4 flex items-center justify-between gap-3">
      <p className="text-sm text-stone-600">Cuánto convendría llevar desde la sucursal productiva.</p>
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending} onClick={calculate} type="button">{pending ? "Calculando…" : "Recalcular"}</button>
    </div>
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {!report && !error ? <p className="mt-6 text-center text-stone-500" role="status">Calculando…</p> : null}
    {report ? <CarryPlanReportView branchName={branchName} inputs={inputs} onInput={(key, value) => setInputs((current) => ({ ...current, [key]: value }))} onReset={() => setInputs(initialCarryInputs(report.rows))} onShowAll={setShowAll} report={report} showAll={showAll} single timeZone={timeZone} /> : null}
  </OverlayDialog>;
}
