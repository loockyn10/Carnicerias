import Link from "next/link";

import { DeliveryStatusBadge, inputClass, primaryButton } from "../../../../../components/distribution/ui";
import { SectionTabs } from "../../../../../components/section-tabs";
import { requireAdminContext } from "../../../../../lib/admin";
import { isIsoDate } from "../../../../../lib/date-range";
import { COMMERCIAL_MODE_LABELS, DELIVERY_STATUS_LABELS, DELIVERY_STATUSES, parseDeliveriesPage, parseDistributionClients } from "../../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../../lib/distribution/tabs";
import { createClient } from "../../../../../lib/supabase/server";
import { isUuid } from "../../../../../lib/uuid";
import { formatIsoDate, moneyText, weightText } from "../../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../../lib/vacuum-tabs";

const PAGE_SIZE = 30;

/** Envasados → Distribución → Entregas y conciliación: historial de entregas (y de reposiciones) con su resultado; cada una abre su detalle, remito y conciliación. */
export default async function DeliveriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const siteId = isUuid(value("site")) ? value("site") : "";
  const status = (DELIVERY_STATUSES as readonly string[]).includes(value("status")) ? value("status") : "";
  const from = isIsoDate(value("from")) ? value("from") : "";
  const to = isIsoDate(value("to")) ? value("to") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const [listResult, clientsResult] = await Promise.all([
    supabase.rpc("list_distribution_deliveries", {
      ...(siteId ? { p_site_id: siteId } : {}), ...(status ? { p_status: status } : {}), ...(from ? { p_from: from } : {}), ...(to ? { p_to: to } : {}), p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE
    }),
    supabase.rpc("list_distribution_clients")
  ]);
  const list = parseDeliveriesPage(listResult.data);
  const clients = parseDistributionClients(clientsResult.data);
  const error = listResult.error ?? clientsResult.error;
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const href = (overrides: Record<string, string>) => {
    const query = new URLSearchParams({ ...(siteId ? { site: siteId } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...overrides });
    return `/admin/vacuum/distribution/deliveries?${query.toString()}`;
  };

  return <main className="mx-auto max-w-7xl p-5 sm:p-8" data-testid="deliveries-page">
    <p className="max-w-3xl text-stone-600">Cada entrega con su resultado: cuántos paquetes se entregaron, cuántos se informaron vendidos y cuántos volvieron. Entrá a una entrega para conciliarla o registrar devoluciones.</p>
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs tabs={DISTRIBUTION_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5" method="get">
      <label className="grid gap-1 text-sm font-bold">Establecimiento
        <select className={`${inputClass} font-normal`} defaultValue={siteId} name="site"><option value="">Todos</option>{clients.flatMap((client) => client.sites.map((site) => <option key={site.id} value={site.id}>{client.tradeName} · {site.name}</option>))}</select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Estado<select className={`${inputClass} font-normal`} defaultValue={status} name="status"><option value="">Todos</option>{DELIVERY_STATUSES.map((entry) => <option key={entry} value={entry}>{DELIVERY_STATUS_LABELS[entry]}</option>)}</select></label>
      <label className="grid gap-1 text-sm font-bold">Desde<input className={`${inputClass} font-normal`} defaultValue={from} name="from" type="date" /></label>
      <label className="grid gap-1 text-sm font-bold">Hasta<input className={`${inputClass} font-normal`} defaultValue={to} name="to" type="date" /></label>
      <div className="flex items-end gap-2"><button className={primaryButton}>Filtrar</button><Link className="px-3 py-2 text-sm font-bold text-stone-600 underline" href="/admin/vacuum/distribution/deliveries">Limpiar</Link></div>
    </form>
    <section className="mt-4 overflow-hidden rounded-xl bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm" data-testid="deliveries-table">
      <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">Entrega</th><th className="p-3">Supermercado</th><th className="p-3">Fecha</th><th className="p-3">Paquetes</th><th className="p-3">Resultado</th><th className="p-3">Valor</th><th className="p-3" /></tr></thead>
      <tbody>{list.rows.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.id}>
        <td className="p-3"><strong>{row.numberLabel}</strong><span className="block"><DeliveryStatusBadge status={row.status} /></span></td>
        <td className="p-3">{row.clientName}<span className="block text-xs text-stone-500">{row.siteName} · {COMMERCIAL_MODE_LABELS[row.commercialMode]}</span></td>
        <td className="p-3">{formatIsoDate(row.deliveryDate)}</td>
        <td className="p-3 tabular-nums">{row.packageCount}<span className="block text-xs text-stone-500">{weightText(row.totalGrams)}</span></td>
        <td className="p-3 text-xs">{row.status === "CONFIRMED" ? <>{row.soldCount} vendidos · {row.pendingCount} pendientes · {row.returnedCount} devueltos</> : "—"}</td>
        <td className="p-3 tabular-nums">{moneyText(row.totalCents)}</td>
        <td className="p-3 text-right"><Link className="rounded-lg border px-3 py-2 text-xs font-bold" href={row.status === "DRAFT" ? `/admin/vacuum/distribution/new?draft=${row.id}` : `/admin/vacuum/distribution/deliveries/${row.id}`}>{row.status === "DRAFT" ? "Continuar" : "Abrir"}</Link></td></tr>)}</tbody>
    </table></div>
    {list.rows.length === 0 ? <p className="p-8 text-center text-stone-500">Todavía no hay entregas con estos filtros.</p> : null}</section>
    {pages > 1 ? <nav className="mt-4 flex items-center justify-between text-sm"><span>Página {page} de {pages}</span><span className="flex gap-3">{page > 1 ? <Link className="font-bold underline" href={href({ page: String(page - 1) })}>Anterior</Link> : null}{page < pages ? <Link className="font-bold underline" href={href({ page: String(page + 1) })}>Siguiente</Link> : null}</span></nav> : null}
  </main>;
}
