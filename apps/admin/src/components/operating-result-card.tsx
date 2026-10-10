"use client";

import { formatBasisPointsPercent } from "@carnicerias/business-logic";
import { useState } from "react";

import { formatResult, LABOR_RATE_MISSING_NOTE, LABOR_REFRESH_MS, NO_COSTS_NOTE, PARTIAL_NOTE, type OperatingResult } from "../lib/operating-costs";
import { AutoRefresh } from "./auto-refresh";
import { OperatingCostsModal } from "./operating-costs-modal";

/**
 * Tarjeta «Resultado operativo» del Resumen de sucursal (D-082): ganancia bruta menos los costos operativos imputables al período. Es UNA
 * sola tarjeta (no hay una de «costos»): los costos se consultan y se cargan desde «Configurar costos», un modal. No se llama «ganancia
 * neta» porque todavía no es un resultado contable/impositivo. Un resultado negativo se ve en rojo; si faltan costos de mercadería en
 * alguna venta el resultado es PARCIAL y la tarjeta lo dice (no se hace pasar por exacto).
 */
export function OperatingResultCard({ result, branchId, branchName, from, to }: { result: OperatingResult; branchId: string; branchName: string; from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const negative = result.resultCents < 0;
  return <>
    <article className={`rounded-xl px-4 py-3 shadow-sm ${negative ? "border border-red-200 bg-red-50" : "bg-white"}`} data-testid="operating-result-card">
      <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Resultado operativo</p>
      <p className={`mt-1 text-2xl font-black ${negative ? "text-red-700" : "text-stone-900"}`} data-testid="operating-result-value">{formatResult(result.resultCents)}</p>
      {result.partial ? <p className="mt-1 text-xs font-bold text-amber-800" data-testid="operating-result-partial">⚠ {PARTIAL_NOTE}</p> : null}
      {result.laborRateMissing ? <p className="mt-1 text-xs font-bold text-amber-800" data-testid="operating-result-labor-rate-missing">⚠ {LABOR_RATE_MISSING_NOTE}</p> : null}
      {/* Una fichada abierta sigue sumando costo de personal: mientras exista se vuelve a pedir el resultado cada tanto. */}
      {result.laborOpenShifts > 0 ? <AutoRefresh intervalMs={LABOR_REFRESH_MS} /> : null}
      <p className="mt-1 text-xs text-stone-500">
        {result.operatingCostCents === 0 ? NO_COSTS_NOTE : `Ganancia bruta − ${formatResult(result.operatingCostCents)} de costos operativos`}
        {result.marginBps !== null ? ` · ${formatBasisPointsPercent(result.marginBps)} % de las ventas` : ""}
      </p>
      <button aria-haspopup="dialog" className="mt-2 text-sm font-bold text-rose-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800" onClick={() => setOpen(true)} type="button">Configurar costos</button>
    </article>
    {open ? <OperatingCostsModal branchId={branchId} branchName={branchName} from={from} onClose={() => setOpen(false)} to={to} /> : null}
  </>;
}
