import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";

import { MetricCard } from "../../../components/admin-ui";
import { PoultryEmptyState } from "../../../components/poultry-empty-state";
import { SalesRangeFilter } from "../../../components/sales-range-filter";
import { SectionTabs } from "../../../components/section-tabs";
import { requireAdminContext } from "../../../lib/admin";
import { periodLabel, resolveSalesRange } from "../../../lib/date-range";
import { createPerfLogger } from "../../../lib/perf";
import { formatKg, formatMargin, hasActivePoultryProducts, parsePriceBoard, parseSummary } from "../../../lib/poultry";
import { POULTRY_TABS } from "../../../lib/poultry-tabs";
import { createClient } from "../../../lib/supabase/server";

/**
 * Pollos → Resumen: tablero operativo. Todo se agrega en el servidor (`get_poultry_summary`): pedidos abiertos, para hoy, próximos y vencidos,
 * y lo vendido en el período (sólo pedidos ENTREGADOS, con el precio y el costo históricos congelados). Nunca se traen pedidos al navegador.
 */
export default async function PoultryHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry");
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const hasDates = Boolean(value("from") || value("to"));
  const range = resolveSalesRange({ preset: value("preset") || (hasDates ? undefined : "30d"), from: value("from"), to: value("to") }, context.timezone);

  const supabase = await createClient();
  const [{ data, error }, boardResult] = await Promise.all([
    perf.measure("summary", supabase.rpc("get_poultry_summary", { p_from: range.from, p_to: range.to })),
    perf.measure("products", supabase.rpc("get_poultry_price_board"))
  ]);
  const noProducts = !boardResult.error && !hasActivePoultryProducts(parsePriceBoard(boardResult.data).products);
  perf.flush();
  const summary = parseSummary(data);
  const sold = summary.sold;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Cajones de pollo: lo que hay que preparar y entregar, y lo que se vendió, con el costo de cada momento.</p>
      <Link className="rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900" href="/admin/poultry/orders?new=1">+ Nuevo pedido</Link>
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    {noProducts ? <PoultryEmptyState /> : null}
    <h2 className="mt-6 text-xl font-black">Para preparar y entregar</h2>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="poultry-open-metrics">
      <MetricCard detail={`${String(summary.open.pending)} pendientes · ${String(summary.open.preparing)} preparando · ${String(summary.open.ready)} listos`} label="Pedidos abiertos" value={String(summary.open.open)} />
      <MetricCard detail="Entrega programada para hoy" label="Para hoy" value={String(summary.open.dueToday)} />
      <MetricCard detail={summary.open.overdue > 0 ? `${String(summary.open.overdue)} vencidos sin entregar` : "Próximos 7 días"} label="Próximos" value={String(summary.open.upcoming)} />
      <MetricCard detail="Sin fecha de entrega" label="Sin fecha" value={String(summary.open.noDate)} />
    </div>

    <h2 className="mt-8 text-xl font-black">Vendido — {periodLabel(range)}</h2>
    <SalesRangeFilter error={range.error} range={range} />
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="poultry-sold-metrics">
      <MetricCard detail={`${String(sold.orders)} pedido${sold.orders === 1 ? "" : "s"} entregado${sold.orders === 1 ? "" : "s"}`} label="Cajones vendidos" value={sold.boxes.toLocaleString("es-AR")} />
      <MetricCard detail={sold.weightGrams > 0 ? "Con peso real registrado" : "Sin peso real cargado"} label="Kilos vendidos" value={sold.weightGrams > 0 ? formatKg(sold.weightGrams) : "—"} />
      <MetricCard label="Facturación" value={formatCurrency(sold.revenueCents)} />
      <MetricCard detail="Costo vigente al entregar cada pedido" label="Costo" value={formatCurrency(sold.costCents)} />
      <MetricCard label="Ganancia bruta" value={formatCurrency(sold.profitCents)} />
      <MetricCard label="Margen bruto" value={formatMargin(sold.marginBps)} />
    </div>

    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black">Principales clientes</h2>
        {summary.topCustomers.length === 0 ? <p className="mt-3 text-sm text-stone-500">Sin entregas en este período.</p> : <table className="mt-3 w-full text-left text-sm"><thead className="text-stone-500"><tr><th className="py-1.5">Cliente</th><th className="py-1.5 text-right">Pedidos</th><th className="py-1.5 text-right">Facturación</th><th className="py-1.5 text-right">Ganancia</th></tr></thead>
          <tbody>{summary.topCustomers.map((row) => <tr className="border-t border-stone-100" key={row.customerId}><td className="py-1.5 font-semibold"><Link className="hover:text-rose-800" href={`/admin/poultry/customers?customer=${row.customerId}`}>{row.name}</Link></td><td className="py-1.5 text-right">{row.orders}</td><td className="py-1.5 text-right">{formatCurrency(row.revenueCents)}</td><td className="py-1.5 text-right">{formatCurrency(row.profitCents)}</td></tr>)}</tbody></table>}
      </section>
      <section className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black">Productos más vendidos</h2>
        {summary.topProducts.length === 0 ? <p className="mt-3 text-sm text-stone-500">Sin entregas en este período.</p> : <table className="mt-3 w-full text-left text-sm"><thead className="text-stone-500"><tr><th className="py-1.5">Producto</th><th className="py-1.5 text-right">Cajones</th><th className="py-1.5 text-right">Facturación</th><th className="py-1.5 text-right">Ganancia</th></tr></thead>
          <tbody>{summary.topProducts.map((row) => <tr className="border-t border-stone-100" key={row.productId}><td className="py-1.5 font-semibold">{row.name}</td><td className="py-1.5 text-right">{row.boxes}</td><td className="py-1.5 text-right">{formatCurrency(row.revenueCents)}</td><td className="py-1.5 text-right">{formatCurrency(row.profitCents)}</td></tr>)}</tbody></table>}
      </section>
    </div>
  </main>;
}
