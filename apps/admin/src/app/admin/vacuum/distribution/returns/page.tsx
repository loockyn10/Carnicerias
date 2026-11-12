import Link from "next/link";

import { ReturnsBoard } from "../../../../../components/distribution/returns-board";
import { inputClass, primaryButton } from "../../../../../components/distribution/ui";
import { SectionTabs } from "../../../../../components/section-tabs";
import { requireAdminContext } from "../../../../../lib/admin";
import { localDateString } from "../../../../../lib/date-range";
import { parseDistributionClients, parseReturnsPage, RETURN_STATUS_LABELS, RETURN_STATUSES } from "../../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../../lib/distribution/tabs";
import { createClient } from "../../../../../lib/supabase/server";
import { isUuid } from "../../../../../lib/uuid";
import { VACUUM_TABS } from "../../../../../lib/vacuum-tabs";

const PAGE_SIZE = 50;

/** Envasados → Distribución → Devoluciones: paquetes retirados de los supermercados, en cuarentena y su decisión (reingreso autorizado, rechazo o descarte). */
export default async function ReturnsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const status = value("status") === "ALL" ? "" : (RETURN_STATUSES as readonly string[]).includes(value("status")) ? value("status") : "OPEN";
  const siteId = isUuid(value("site")) ? value("site") : "";
  const deliveryId = isUuid(value("delivery")) ? value("delivery") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const [listResult, clientsResult] = await Promise.all([
    supabase.rpc("list_distribution_returns", { ...(status ? { p_status: status } : {}), ...(siteId ? { p_site_id: siteId } : {}), ...(deliveryId ? { p_delivery_id: deliveryId } : {}), p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE }),
    supabase.rpc("list_distribution_clients")
  ]);
  const list = parseReturnsPage(listResult.data);
  const clients = parseDistributionClients(clientsResult.data);
  const error = listResult.error ?? clientsResult.error;
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const href = (page2: number) => `/admin/vacuum/distribution/returns?${new URLSearchParams({ ...(value("status") ? { status: value("status") } : {}), ...(siteId ? { site: siteId } : {}), ...(deliveryId ? { delivery: deliveryId } : {}), page: String(page2) }).toString()}`;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8" data-testid="returns-page">
    <p className="max-w-3xl text-stone-600">Los paquetes que vuelven de los supermercados entran en <strong>cuarentena</strong>. Ninguno vuelve a estar disponible para vender o distribuir sin una inspección y una aprobación explícita, y nunca se cambian sus fechas de elaboración ni de vencimiento.</p>
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs tabs={DISTRIBUTION_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4" method="get">
      <label className="grid gap-1 text-sm font-bold">Estado
        <select className={`${inputClass} font-normal`} defaultValue={value("status") || "OPEN"} name="status"><option value="OPEN">En curso (sin decidir)</option><option value="ALL">Todos</option>{RETURN_STATUSES.map((entry) => <option key={entry} value={entry}>{RETURN_STATUS_LABELS[entry]}</option>)}</select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Establecimiento
        <select className={`${inputClass} font-normal`} defaultValue={siteId} name="site"><option value="">Todos</option>{clients.flatMap((client) => client.sites.map((site) => <option key={site.id} value={site.id}>{client.tradeName} · {site.name}</option>))}</select>
      </label>
      {deliveryId ? <input name="delivery" type="hidden" value={deliveryId} /> : null}
      <div className="flex items-end gap-2"><button className={primaryButton}>Filtrar</button><Link className="px-3 py-2 text-sm font-bold text-stone-600 underline" href="/admin/vacuum/distribution/returns">Limpiar</Link></div>
    </form>
    <p className="mt-4 text-sm text-stone-500" data-testid="returns-total">{list.total} devolución{list.total === 1 ? "" : "es"}{deliveryId ? " de la entrega elegida" : ""}.</p>
    <div className="mt-3">{list.rows.length === 0 ? <p className="rounded-xl bg-white p-8 text-center text-stone-500 shadow-sm">No hay devoluciones con estos filtros.</p> : <ReturnsBoard rows={list.rows} today={localDateString(context.timezone)} />}</div>
    {pages > 1 ? <nav className="mt-4 flex items-center justify-between text-sm"><span>Página {page} de {pages}</span><span className="flex gap-3">{page > 1 ? <Link className="font-bold underline" href={href(page - 1)}>Anterior</Link> : null}{page < pages ? <Link className="font-bold underline" href={href(page + 1)}>Siguiente</Link> : null}</span></nav> : null}
  </main>;
}
