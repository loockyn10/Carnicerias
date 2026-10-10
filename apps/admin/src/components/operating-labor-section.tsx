import { formatCurrency } from "@carnicerias/business-logic";

import { formatHourlyRate, formatWorked, LABOR_AUTOMATIC_NOTE, laborPeriodName, type LaborReport } from "../lib/operating-costs";

const money = (cents: number) => formatCurrency(BigInt(cents));

/**
 * «PERSONAL — automático» dentro de «Configurar costos» (D-085): el costo de las horas fichadas en ESTA sucursal en el período, persona por
 * persona (valor hora x horas). Sólo lectura: no hay nada que cargar, se calcula solo con el control horario (fichadas) y el valor hora de
 * cada persona. El desglose con valores hora sólo se muestra con el permiso de control horario; sin él queda el total.
 */
export function LaborSection({ labor, period, today }: { labor: LaborReport; period: { from: string; to: string }; today: string }) {
  const periodName = laborPeriodName(period, today);
  const isToday = periodName === "hoy";
  const periodTitle = isToday ? "Hoy" : "En el período";
  const costTitle = isToday ? "Costo hoy" : "Costo del período";
  return <section aria-labelledby="costs-labor" data-testid="labor-section">
    <h3 className="text-base font-black" id="costs-labor">PERSONAL — automático</h3>
    <p className="mt-0.5 text-sm text-stone-600">{LABOR_AUTOMATIC_NOTE}</p>
    {labor.canSeeDetail ? <ul className="mt-2 divide-y divide-stone-100 rounded-xl bg-white shadow-sm">
      {labor.employees.map((employee) => <li className="px-4 py-3" data-testid="labor-employee" key={employee.employeeId}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <strong>{employee.name}</strong>
            {employee.openShifts > 0 ? <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">Trabajando ahora</span> : null}
          </div>
          <span className="whitespace-nowrap text-sm text-stone-600">{formatHourlyRate(employee)}</span>
        </div>
        <p className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-4 text-sm text-stone-600">
          <span>{periodTitle}: {formatWorked(employee.workedSeconds)}</span>
          <span>{costTitle}: <strong className="text-stone-900">{money(employee.costCents)}</strong></span>
        </p>
        {employee.rateMissing ? <p className="mt-1 text-xs font-bold text-amber-800">⚠ Parte de sus horas no tiene valor hora cargado: esas horas cuestan $ 0.</p> : null}
        {employee.reviewShifts > 0 ? <p className="mt-1 text-xs font-bold text-amber-800">⚠ {employee.reviewShifts === 1 ? "Una fichada a revisar" : `${String(employee.reviewShifts)} fichadas a revisar`} (control horario).</p> : null}
      </li>)}
      {!labor.employees.length ? <li className="px-4 py-4 text-sm text-stone-500">No hay horas fichadas en esta sucursal {periodName}.</li> : null}
    </ul> : <p className="mt-2 rounded-lg bg-stone-100 p-3 text-sm text-stone-700" role="status">El detalle por persona requiere el permiso de control horario. Acá se ve el total.</p>}
    <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 rounded-xl bg-white p-4 text-sm font-black shadow-sm" data-testid="labor-total">
      <span>TOTAL PERSONAL {periodName.toUpperCase()}</span>
      <span className="text-base">{money(labor.costCents)}</span>
    </p>
    {labor.rateMissing && !labor.canSeeDetail ? <p className="mt-1 text-xs font-bold text-amber-800">⚠ Hay horas sin valor hora cargado: el costo de personal está incompleto.</p> : null}
  </section>;
}
