import { formatStockQuantity, stockUnitLabel } from "@carnicerias/business-logic";

import { carryKey, carryTotals, groupCarryPlan, resolveCarryQuantity, type CarryPlanReport } from "../lib/carry-plan";
import { formatLocalDateTime } from "../lib/date-range";

function totalsText(totals: { grams: number; units: number }) {
  return [totals.grams > 0 ? formatStockQuantity(totals.grams, "WEIGHT") : "", totals.units > 0 ? formatStockQuantity(totals.units, "UNIT") : ""].filter(Boolean).join(" + ") || "Nada";
}

/** Vista pura del informe ya calculado (sin estado propio, para poder probarla sin navegador). */
export function CarryPlanReportView({ report, inputs, showAll, single, branchName, timeZone, onInput, onReset, onShowAll }: {
  report: CarryPlanReport;
  inputs: Record<string, string>;
  showAll: boolean;
  single: boolean;
  branchName?: string | undefined;
  timeZone: string;
  onInput: (key: string, value: string) => void;
  onReset: () => void;
  onShowAll: (value: boolean) => void;
}) {
  const groups = groupCarryPlan(report.rows, { showAll });
  const hiddenTotal = groups.reduce((sum, group) => sum + group.hiddenCount, 0);
  return <div className="mt-4">
    <p className="text-sm text-stone-600">
      <strong>Calculado: {formatLocalDateTime(report.calculatedAt, timeZone)}</strong>
      {report.windowStart ? ` · ventas completadas desde el ${formatLocalDateTime(report.windowStart, timeZone).slice(0, 10)} (${String(report.windowDays)} días, hoy incluido)` : null}
    </p>
    <p className="mt-1 text-xs text-stone-500">Sugerido = vendido − stock actual (nunca menos que 0; un stock negativo cuenta como 0). No depende del stock de la sucursal productiva: lo que se lleva lo decide lo que haya físicamente. Es sólo un informe: no crea transferencias ni mueve stock.</p>
    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
      {hiddenTotal > 0 || showAll ? <label className="flex cursor-pointer items-center gap-2 font-bold"><input checked={showAll} onChange={(event) => onShowAll(event.target.checked)} type="checkbox" />Mostrar sin necesidad{hiddenTotal > 0 ? ` (${String(hiddenTotal)})` : ""}</label> : null}
      <button className="font-bold text-rose-800 hover:underline" onClick={onReset} type="button">Restablecer cantidades</button>
    </div>
    <div className="mt-3 space-y-5">
      {groups.map((group) => {
        const totals = carryTotals(group.rows, inputs);
        return <div key={group.branchId}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-black">{single && branchName ? `Qué llevar a ${branchName}` : group.branchName}</h3>
            <span className="text-sm text-stone-600">Total a llevar: <strong>{totalsText(totals)}</strong></span>
          </div>
          {group.rows.length ? <div className="mt-2 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b bg-stone-50 text-stone-500"><tr><th className="p-3">Producto</th><th className="p-3">Vendió 7d</th><th className="p-3">Stock actual</th><th className="p-3">Sugerido</th><th className="p-3">A llevar ahora</th></tr></thead>
              <tbody>{group.rows.map((row) => {
                const key = carryKey(row);
                const raw = inputs[key] ?? "";
                const parsed = resolveCarryQuantity(raw, row.unitType);
                return <tr className="border-b last:border-0" key={key}>
                  <td className="p-3 font-bold">{row.productName}</td>
                  <td className="p-3">{row.soldQuantity > 0 ? formatStockQuantity(row.soldQuantity, row.unitType) : "—"}</td>
                  <td className={`p-3 ${row.currentQuantity <= 0 ? "font-bold text-red-700" : ""}`}>{row.currentQuantity <= 0 ? "Sin stock" : formatStockQuantity(row.currentQuantity, row.unitType)}{row.currentQuantity < 0 ? <span className="block text-xs font-normal">Faltante {formatStockQuantity(Math.abs(row.currentQuantity), row.unitType)}</span> : null}</td>
                  <td className="p-3 font-bold text-teal-700">{row.suggestedQuantity > 0 ? formatStockQuantity(row.suggestedQuantity, row.unitType) : "—"}</td>
                  <td className="p-3">
                    <span className="flex items-center gap-2">
                      <input aria-invalid={parsed.quantity === null} aria-label={`A llevar ahora de ${row.productName} en ${group.branchName}`} className={`w-28 rounded-lg border px-2 py-1.5 text-right ${parsed.quantity === null ? "border-red-400 bg-red-50" : "border-stone-300"}`} inputMode={row.unitType === "WEIGHT" ? "decimal" : "numeric"} onChange={(event) => onInput(key, event.target.value)} value={raw} />
                      <span className="text-stone-500">{stockUnitLabel(row.unitType)}</span>
                    </span>
                    {parsed.error ? <span className="mt-1 block text-xs text-red-700">{parsed.error}</span> : null}
                  </td>
                </tr>;
              })}</tbody>
            </table>
          </div> : <p className="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">No hace falta llevar nada: lo vendido en los últimos 7 días está cubierto por el stock actual.</p>}
        </div>;
      })}
      {!groups.length ? <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600">{single ? "Esta sucursal no tiene productos habilitados en su surtido." : "No hay sucursales para calcular."}</p> : null}
    </div>
  </div>;
}
