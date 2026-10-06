import Link from "next/link";

import { SALES_RANGE_PRESETS, type SalesRange } from "../lib/date-range";

/**
 * Selector de período de las métricas de ventas: presets (Hoy / Ayer / 7 días / 30 días) y Desde /
 * Hasta para cualquier rango. Los presets son links (`?preset=…`) y Desde/Hasta un formulario GET
 * cuyo único botón es Aplicar, de modo que Enter dentro de una fecha aplica esas fechas. `preserve`
 * son los demás parámetros de la pantalla que deben sobrevivir al cambio de período.
 */
export function SalesRangeFilter({ range, error, preserve = {} }: { range: SalesRange; error?: string | undefined; preserve?: Record<string, string> }) {
  const chip = (active: boolean) => `rounded-full px-4 py-2 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;
  const kept = Object.entries(preserve).filter(([, value]) => value);
  const presetHref = (preset: string) => `?${new URLSearchParams([...kept, ["preset", preset]]).toString()}`;
  return <div className="mt-3 rounded-xl bg-white p-4 shadow-sm">
    <div className="flex flex-wrap items-end gap-2">
      {SALES_RANGE_PRESETS.map(({ key, label }) => <Link aria-current={range.preset === key ? "true" : undefined} className={chip(range.preset === key)} href={presetHref(key)} key={key}>{label}</Link>)}
      <form className="flex flex-wrap items-end gap-2 sm:ml-3" method="get">
        {kept.map(([name, value]) => <input key={name} name={name} type="hidden" value={value} />)}
        <label className="grid gap-1 text-xs font-bold text-stone-500">Desde<input className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" defaultValue={range.from} name="from" required type="date" /></label>
        <label className="grid gap-1 text-xs font-bold text-stone-500">Hasta<input className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" defaultValue={range.to} name="to" required type="date" /></label>
        <button className={`rounded-lg border px-4 py-2 text-sm font-bold ${range.preset === "custom" ? "border-rose-800 text-rose-800" : ""}`} type="submit">Aplicar</button>
      </form>
    </div>
    {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error} Se muestra el día de hoy.</p> : null}
  </div>;
}
