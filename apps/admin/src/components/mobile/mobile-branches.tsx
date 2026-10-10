import { formatBasisPointsPercent, formatCurrency, formatWeight } from "@carnicerias/business-logic";

import { alertsText, type BranchCardData } from "../../lib/mobile-branches";
import { rangeQuery, type ResolvedSalesRange } from "../../lib/date-range";
import { MobilePeriod } from "./mobile-period";

/**
 * «Ver sucursales» del celular: una tarjeta por sucursal (sin tablas), con Ventas, Kg, Ganancia, Margen y alertas, y UN botón grande «Ver detalle».
 * Los números salen de las mismas consultas del escritorio. El link al detalle es una navegación completa (`<a>`), a propósito: el detalle del
 * escritorio se abre como modal al navegar desde esta lista, y en el celular no queremos un modal de 900 px.
 */
export function MobileBranches({ cards, range }: { cards: BranchCardData[]; range: ResolvedSalesRange }) {
  const row = (label: string, value: string) => <div className="flex items-baseline justify-between gap-3"><dt className="text-base text-stone-600">{label}</dt><dd className="text-lg font-black text-stone-900">{value}</dd></div>;
  return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-6 pt-4 lg:hidden" data-testid="mobile-branches">
    <MobilePeriod basePath="/admin/branches" error={range.error} range={range} />
    <div className="mt-4 grid gap-4">
      {cards.map((card) => <article aria-label={card.name} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm" key={card.id}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 text-xl font-black uppercase tracking-wide">{card.name}{card.isProduction ? <span className="ml-2 align-middle text-xs font-bold normal-case tracking-normal text-stone-500">Depósito</span> : null}</h2>
          <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-black ${card.alerts === 0 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{card.alerts === 0 ? `✓ ${alertsText(0)}` : `⚠ ${alertsText(card.alerts)}`}</span>
        </div>
        <dl className="mt-3 grid gap-2">
          {row("Ventas", formatCurrency(BigInt(card.revenueCents)))}
          {row("Kg vendidos", formatWeight(card.grams))}
          {card.units > 0 ? row("Unidades vendidas", new Intl.NumberFormat("es-AR").format(card.units)) : null}
          {row("Ganancia bruta", card.profitCents === null ? "—" : formatCurrency(BigInt(card.profitCents)))}
          {row("Margen", card.marginBps === null ? "—" : `${formatBasisPointsPercent(card.marginBps)} %`)}
        </dl>
        {card.missingCostItems > 0 ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">⚠ Hay productos vendidos sin costo cargado: la ganancia puede estar incompleta.</p> : null}
        <a className="mt-4 grid min-h-12 place-items-center rounded-xl bg-emerald-700 px-4 text-base font-bold text-white active:bg-emerald-800" href={`/admin/branches/${card.id}?${rangeQuery(range)}`}>Ver detalle</a>
      </article>)}
      {!cards.length ? <p className="rounded-2xl bg-white p-6 text-center text-stone-500">Todavía no hay sucursales activas.</p> : null}
    </div>
  </div>;
}
