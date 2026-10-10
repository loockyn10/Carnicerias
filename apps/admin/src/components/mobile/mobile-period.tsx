import Link from "next/link";

import { periodLabel, SALES_RANGE_PRESETS, type SalesRange } from "../../lib/date-range";

/**
 * Período del celular: 4 botones (Hoy · Ayer · 7 días · 30 días) y «Otro período», que recién ahí muestra Desde / Hasta. Son links y un formulario GET
 * (sin JavaScript propio): el período viaja en la URL, igual que en el escritorio, y es el mismo que resuelve `resolveSalesRange` (días calendario de la organización).
 */
export function MobilePeriod({ basePath, range, error }: { basePath: string; range: SalesRange; error?: string | undefined }) {
  const chip = (active: boolean) => `grid min-h-12 place-items-center rounded-xl px-2 text-base font-bold ${active ? "bg-stone-800 text-white" : "border border-stone-300 bg-white text-stone-700 active:bg-stone-100"}`;
  return <section aria-label="Período" className="mt-4">
    <div className="grid grid-cols-4 gap-2">
      {SALES_RANGE_PRESETS.map(({ key, label }) => <Link aria-current={range.preset === key ? "true" : undefined} className={chip(range.preset === key)} href={`${basePath}?preset=${key}`} key={key} prefetch={false}>{label}</Link>)}
    </div>
    <details className="mt-2 rounded-xl" open={range.preset === "custom"}>
      <summary className={`flex min-h-12 cursor-pointer list-none items-center justify-center rounded-xl border border-dashed text-base font-bold ${range.preset === "custom" ? "border-stone-800 bg-stone-100 text-stone-900" : "border-stone-300 text-stone-600 active:bg-stone-200"}`}>Otro período</summary>
      <form action={basePath} className="mt-2 grid gap-3 rounded-xl bg-white p-4 shadow-sm" method="get">
        <label className="grid gap-1 text-sm font-bold text-stone-600">Desde<input className="min-h-12 rounded-lg border border-stone-300 px-3 text-base font-normal text-stone-900" defaultValue={range.from} name="from" required type="date" /></label>
        <label className="grid gap-1 text-sm font-bold text-stone-600">Hasta<input className="min-h-12 rounded-lg border border-stone-300 px-3 text-base font-normal text-stone-900" defaultValue={range.to} name="to" required type="date" /></label>
        <button className="min-h-12 rounded-xl bg-emerald-700 px-4 text-base font-bold text-white active:bg-emerald-800" type="submit">Ver este período</button>
      </form>
    </details>
    {error ? <p className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="alert">{error} Se muestra el día de hoy.</p> : null}
    <p className="mt-3 text-center text-sm text-stone-500">Mostrando: <strong className="text-stone-700">{periodLabel(range)}</strong></p>
  </section>;
}
