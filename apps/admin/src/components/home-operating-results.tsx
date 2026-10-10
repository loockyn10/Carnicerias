import Link from "next/link";

import { SALES_RANGE_PRESETS, rangeQuery, type SalesRange } from "../lib/date-range";
import { formatResult, PARTIAL_NOTE, sumOperatingResults, type OperatingResult } from "../lib/operating-costs";

/**
 * «Resultado operativo» en Inicio (D-082): una tarjeta compacta por sucursal activa y el total de las visibles, para el mismo período
 * (Hoy / Ayer / 7 días / 30 días, por `?preset=`). Son las MISMAS cifras que el Resumen de cada sucursal (la misma RPC): acá no se calcula
 * nada, sólo se suman los resultados que ya calculó el servidor. La Central se trata como cualquier sucursal con ventas propias (la
 * distribución de mercadería no es una venta, así que no se duplica nada) y se identifica con una etiqueta.
 */
export function HomeOperatingResults({ results, range, periodName, productionBranchId }: { results: readonly OperatingResult[]; range: SalesRange; periodName: string; productionBranchId: string | null }) {
  const total = sumOperatingResults(results);
  const chip = (active: boolean) => `rounded-full px-3 py-1.5 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;
  const card = (negative: boolean) => `rounded-xl px-4 py-3 shadow-sm ${negative ? "border border-red-200 bg-red-50" : "border border-stone-200 bg-white"}`;
  return <section className="mt-8" data-testid="home-operating-results">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-rose-800">Rentabilidad</p>
        <h2 className="mt-1 text-xl font-black">Resultado operativo · {periodName}</h2>
        <p className="mt-0.5 text-sm text-stone-600">Ganancia bruta menos los costos operativos de cada sucursal.</p>
      </div>
      <nav aria-label="Período del resultado operativo" className="flex flex-wrap gap-2">
        {SALES_RANGE_PRESETS.map(({ key, label }) => <Link aria-current={range.preset === key ? "true" : undefined} className={chip(range.preset === key)} href={`/admin?preset=${key}`} key={key}>{label}</Link>)}
      </nav>
    </div>
    {results.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {results.length > 1 ? <article className={card(total.resultCents < 0)} data-testid="home-operating-total">
        <p className="text-xs font-bold uppercase tracking-wider text-stone-500">Resultado operativo total</p>
        <p className={`mt-1 text-2xl font-black ${total.resultCents < 0 ? "text-red-700" : "text-stone-900"}`}>{formatResult(total.resultCents)}</p>
        <p className="mt-1 text-xs text-stone-500">Suma de {total.branches} sucursales</p>
        {total.partial ? <p className="mt-1 text-xs font-bold text-amber-800">⚠ {PARTIAL_NOTE}</p> : null}
      </article> : null}
      {results.map((result) => <Link className={`${card(result.resultCents < 0)} block hover:border-rose-300`} data-testid="home-operating-branch" href={`/admin/branches/${result.branchId}?${rangeQuery(range)}`} key={result.branchId}>
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-stone-500">{result.branchName}{result.branchId === productionBranchId ? <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] text-stone-700">Central</span> : null}</p>
        <p className="mt-0.5 text-xs text-stone-500">Resultado operativo</p>
        <p className={`text-2xl font-black ${result.resultCents < 0 ? "text-red-700" : "text-stone-900"}`}>{formatResult(result.resultCents)}</p>
        {result.partial ? <p className="mt-1 text-xs font-bold text-amber-800">⚠ {PARTIAL_NOTE}</p> : null}
      </Link>)}
    </div> : <p className="mt-3 rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-500">No hay sucursales activas para mostrar.</p>}
  </section>;
}
