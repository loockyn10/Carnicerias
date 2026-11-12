import Link from "next/link";

import { Kpi, Notice, inputClass, primaryButton } from "../../../../components/distribution/ui";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { isIsoDate } from "../../../../lib/date-range";
import { formatPct, overallRotation, topReturns, topSold } from "../../../../lib/distribution/logic";
import { parseDistributionClients, parseDistributionStats } from "../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../lib/distribution/tabs";
import { createPerfLogger } from "../../../../lib/perf";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";
import { formatIsoDate, moneyText, parseVacuumConfigPage, weightText } from "../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../lib/vacuum-tabs";

/**
 * Envasados → Distribución → Panel. Estadísticas de las entregas CONFIRMADAS con filtros por supermercado, fecha, producto y categoría.
 * Lo confirmado (ventas mayoristas firmes y paquetes identificados) está separado de lo ESTIMADO (ventas informadas sólo por cantidad), y nada de lo entregado
 * se presenta como facturación: los valores son el precio comercial de góndola de los paquetes.
 */
export default async function DistributionPanelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum/distribution");
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const from = isIsoDate(value("from")) ? value("from") : "";
  const to = isIsoDate(value("to")) ? value("to") : "";
  const clientId = isUuid(value("client")) ? value("client") : "";
  const siteId = isUuid(value("site")) ? value("site") : "";
  const productId = isUuid(value("product")) ? value("product") : "";
  const categoryId = isUuid(value("category")) ? value("category") : "";

  const supabase = await createClient();
  const [statsResult, clientsResult, productsResult, categoriesResult] = await Promise.all([
    perf.measure("stats", supabase.rpc("get_distribution_stats", {
      ...(from ? { p_from: from } : {}), ...(to ? { p_to: to } : {}), ...(clientId ? { p_client_id: clientId } : {}), ...(siteId ? { p_site_id: siteId } : {}),
      ...(productId ? { p_product_id: productId } : {}), ...(categoryId ? { p_category_id: categoryId } : {})
    })),
    perf.measure("clients", supabase.rpc("list_distribution_clients")),
    perf.measure("products", supabase.rpc("list_vacuum_config_products_page", { p_filter: "enabled", p_limit: 200 })),
    perf.measure("categories", supabase.from("categories").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"))
  ]);
  perf.flush();
  const stats = parseDistributionStats(statsResult.data);
  const clients = parseDistributionClients(clientsResult.data);
  const products = parseVacuumConfigPage(productsResult.data).rows;
  const categories = categoriesResult.data ?? [];
  const error = statsResult.error ?? clientsResult.error ?? productsResult.error;
  const rotation = overallRotation(stats);
  const sold = topSold(stats.products);
  const returns = topReturns(stats.products);

  return <main className="mx-auto max-w-7xl p-5 sm:p-8" data-testid="distribution-panel">
    <p className="max-w-3xl text-stone-600">Producir → identificar → entregar → conciliar → recibir devoluciones. Acá se ve cómo rota la mercadería que se distribuye a los supermercados.</p>
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs tabs={DISTRIBUTION_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="stats-filters" method="get">
      <label className="grid gap-1 text-sm font-bold">Desde<input className={`${inputClass} font-normal`} defaultValue={from || stats.from} name="from" type="date" /></label>
      <label className="grid gap-1 text-sm font-bold">Hasta<input className={`${inputClass} font-normal`} defaultValue={to || stats.to} name="to" type="date" /></label>
      <label className="grid gap-1 text-sm font-bold">Supermercado
        <select className={`${inputClass} font-normal`} defaultValue={clientId} name="client"><option value="">Todos</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.tradeName}</option>)}</select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Establecimiento
        <select className={`${inputClass} font-normal`} defaultValue={siteId} name="site"><option value="">Todos</option>{clients.flatMap((client) => client.sites.map((site) => <option key={site.id} value={site.id}>{client.tradeName} · {site.name}</option>))}</select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Producto
        <select className={`${inputClass} font-normal`} defaultValue={productId} name="product"><option value="">Todos</option>{products.map((product) => <option key={product.productId} value={product.productId}>{product.name}</option>)}</select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Categoría
        <select className={`${inputClass} font-normal`} defaultValue={categoryId} name="category"><option value="">Todas</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
      </label>
      <div className="flex items-end gap-2 sm:col-span-2"><button className={primaryButton}>Aplicar filtros</button><Link className="px-3 py-2 text-sm font-bold text-stone-600 underline" href="/admin/vacuum/distribution">Limpiar</Link></div>
    </form>

    <p className="mt-4 text-sm text-stone-500">Período: {formatIsoDate(stats.from)} al {formatIsoDate(stats.to)} · sólo entregas despachadas.</p>
    {stats.deliveries === 0 ? <div className="mt-4"><Notice tone="info">No hay entregas despachadas en este período. <Link className="font-bold underline" href="/admin/vacuum/distribution/new">Preparar una entrega</Link></Notice></div> : null}

    <section aria-label="Resumen" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi hint={`${String(stats.activeSites)} establecimientos · ${String(stats.deliveries)} entregas`} label="Supermercados activos" testId="kpi-clients" value={stats.activeClients} />
      <Kpi hint={`${weightText(stats.delivered.grams)} distribuidos`} label="Paquetes entregados" testId="kpi-delivered" value={stats.delivered.packages} />
      <Kpi hint={`Firmes ${String(stats.confirmed.firmPackages)} · identificados ${String(stats.confirmed.identifiedPackages)}`} label="Vendidos confirmados" testId="kpi-confirmed" value={stats.confirmed.packages} />
      <Kpi hint="Informados sólo por cantidad: no se sabe cuáles paquetes fueron" label="Vendidos (por cantidad)" testId="kpi-estimated" tone="estimate" value={stats.estimated.packages} />
      <Kpi hint={weightText(stats.returned.grams)} label="Paquetes devueltos" testId="kpi-returned" value={stats.returned.packages} />
      <Kpi hint="Entregados que todavía nadie informó vendidos ni devueltos" label="Pendientes de conciliar" testId="kpi-pending" tone="neutral" value={stats.pending.packages} />
      <Kpi hint="Vendidos confirmados ÷ entregados" label="Rotación confirmada" testId="kpi-rotation" value={formatPct(rotation.confirmedPct)} />
      <Kpi hint="Incluye lo informado por cantidad" label="Rotación con estimación" testId="kpi-rotation-estimate" tone="estimate" value={formatPct(rotation.withEstimatePct)} />
      <Kpi hint="Precio comercial de góndola de lo entregado" label="Valor de mercadería entregada" testId="kpi-delivered-value" tone="neutral" value={moneyText(stats.delivered.cents)} />
      <Kpi hint="Firmes + identificados. No es facturación ni cobranza" label="Valor de ventas confirmadas" testId="kpi-confirmed-value" value={moneyText(stats.confirmed.cents)} />
      <Kpi hint="Cantidad informada × precio promedio del corte en esa entrega" label="Valor estimado de ventas" testId="kpi-estimated-value" tone="estimate" value={moneyText(stats.estimated.cents)} />
    </section>
    <p className="mt-3 max-w-3xl text-xs text-stone-500">Lo entregado NO es una venta: en consignación sólo cuenta como vendido lo que el supermercado informa, y lo informado sólo por cantidad se muestra aparte como estimación. Los valores son precios comerciales de los paquetes; esta etapa no incluye facturación ni cobranza.</p>

    <div className="mt-6 grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="top-sold"><h2 className="text-lg font-black">Cortes más vendidos</h2>
        {sold.length === 0 ? <p className="mt-3 text-sm text-stone-500">Todavía no hay ventas confirmadas ni informadas en el período.</p> : <ol className="mt-3 grid gap-2 text-sm">{sold.map((product) => <li className="flex items-center justify-between gap-3 border-b border-stone-100 pb-2" key={product.productId}>
          <span><strong>{product.productName}</strong>{product.categoryName ? <span className="ml-2 text-xs text-stone-500">{product.categoryName}</span> : null}</span>
          <span className="text-right tabular-nums">{product.soldConfirmed} confirmados{product.soldEstimated > 0 ? <span className="text-amber-700"> + {product.soldEstimated} estimados</span> : null}</span></li>)}</ol>}
      </section>
      <section className="rounded-xl bg-white p-5 shadow-sm" data-testid="top-returns"><h2 className="text-lg font-black">Cortes con mayor devolución</h2>
        {returns.length === 0 ? <p className="mt-3 text-sm text-stone-500">Sin devoluciones relevantes en el período (se consideran cortes con al menos 3 paquetes entregados).</p> : <ol className="mt-3 grid gap-2 text-sm">{returns.map((product) => <li className="flex items-center justify-between gap-3 border-b border-stone-100 pb-2" key={product.productId}>
          <strong>{product.productName}</strong><span className="tabular-nums">{formatPct(product.returnPct)} · {product.returned} de {product.delivered}</span></li>)}</ol>}
      </section>
    </div>

    <section className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm"><h2 className="p-5 pb-0 text-lg font-black">Por corte</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[860px] text-left text-sm" data-testid="stats-by-product">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">Corte</th><th className="p-3">Entregados</th><th className="p-3">Vendidos confirmados</th><th className="p-3">Estimados</th><th className="p-3">Devueltos</th><th className="p-3">Pendientes</th><th className="p-3">Rotación</th><th className="p-3">Devolución</th></tr></thead>
        <tbody>{stats.products.map((product) => <tr className="border-b border-stone-100 last:border-0" key={product.productId}>
          <td className="p-3"><strong>{product.productName}</strong>{product.categoryName ? <span className="block text-xs text-stone-500">{product.categoryName}</span> : null}</td>
          <td className="p-3 tabular-nums">{product.delivered}<span className="block text-xs text-stone-500">{weightText(product.grams)}</span></td>
          <td className="p-3 tabular-nums">{product.soldConfirmed}<span className="block text-xs text-stone-500">{moneyText(product.soldConfirmedCents)}</span></td>
          <td className="p-3 tabular-nums text-amber-800">{product.soldEstimated}<span className="block text-xs">{moneyText(product.soldEstimatedCents)}</span></td>
          <td className="p-3 tabular-nums">{product.returned}</td><td className="p-3 tabular-nums">{product.pending}</td>
          <td className="p-3 tabular-nums">{formatPct(product.rotationConfirmedPct)}<span className="block text-xs text-amber-700">con estimación {formatPct(product.rotationWithEstimatePct)}</span></td>
          <td className="p-3 tabular-nums">{formatPct(product.returnPct)}</td></tr>)}</tbody>
      </table></div>
      {stats.products.length === 0 ? <p className="p-6 text-center text-sm text-stone-500">Sin datos para estos filtros.</p> : null}
    </section>

    <section className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm"><h2 className="p-5 pb-0 text-lg font-black">Rendimiento por supermercado</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[860px] text-left text-sm" data-testid="stats-by-site">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">Establecimiento</th><th className="p-3">Entregas</th><th className="p-3">Entregados</th><th className="p-3">Vendidos confirmados</th><th className="p-3">Estimados</th><th className="p-3">Devueltos</th><th className="p-3">Pendientes</th><th className="p-3">Rotación</th></tr></thead>
        <tbody>{stats.sites.map((site) => <tr className="border-b border-stone-100 last:border-0" key={site.siteId}>
          <td className="p-3"><strong>{site.siteName}</strong><span className="block text-xs text-stone-500">{site.clientName}</span></td>
          <td className="p-3 tabular-nums">{site.deliveries}</td><td className="p-3 tabular-nums">{site.delivered}<span className="block text-xs text-stone-500">{moneyText(site.deliveredCents)}</span></td>
          <td className="p-3 tabular-nums">{site.soldConfirmed}</td><td className="p-3 tabular-nums text-amber-800">{site.soldEstimated}</td><td className="p-3 tabular-nums">{site.returned}</td><td className="p-3 tabular-nums">{site.pending}</td>
          <td className="p-3 tabular-nums">{formatPct(site.rotationConfirmedPct)}<span className="block text-xs text-amber-700">con estimación {formatPct(site.rotationWithEstimatePct)}</span></td></tr>)}</tbody>
      </table></div>
      {stats.sites.length === 0 ? <p className="p-6 text-center text-sm text-stone-500">Sin datos para estos filtros.</p> : null}
    </section>
  </main>;
}
