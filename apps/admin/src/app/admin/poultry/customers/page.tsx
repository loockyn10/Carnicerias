import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";

import { StatusBadge } from "../../../../components/admin-ui";
import { PoultryCustomerModal, PoultryCustomerPricesModal } from "../../../../components/poultry-customer-modals";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { formatIsoDate } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import { formatKg, formatMargin, parseCustomerDetail, parseCustomersPage, parsePriceBoard, POULTRY_STATUS_LABELS, POULTRY_STATUS_TONES } from "../../../../lib/poultry";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 30;

/**
 * Pollos → Clientes: alta, edición, lista de precios asignada y ficha con pedidos recientes y totales (cajones, kilos, facturación, ganancia y margen
 * de los pedidos entregados). Sin saldos ni cuenta corriente: no existe una estructura segura para eso y queda fuera de este alcance.
 */
export default async function PoultryCustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry/customers");
  await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const status = ["active", "inactive", "all"].includes(value("status")) ? value("status") : "active";
  const search = value("q").trim();
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);
  const selected = isUuid(value("customer")) ? value("customer") : "";

  const supabase = await createClient();
  const [pageResult, boardResult, detailResult] = await Promise.all([
    perf.measure("customers", supabase.rpc("list_poultry_customers_page", { p_status: status, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE, ...(search ? { p_search: search } : {}) })),
    perf.measure("priceBoard", supabase.rpc("get_poultry_price_board")),
    selected ? perf.measure("detail", supabase.rpc("get_poultry_customer_detail", { p_customer_id: selected })) : Promise.resolve({ data: null, error: null })
  ]);
  perf.flush();
  const customers = parseCustomersPage(pageResult.data);
  const lists = parsePriceBoard(boardResult.data).lists;
  const detail = parseCustomerDetail(detailResult.data);
  const error = pageResult.error ?? boardResult.error ?? detailResult.error;
  const totalPages = Math.max(1, Math.ceil(customers.total / PAGE_SIZE));
  const href = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (status !== "active") query.set("status", status);
    for (const [key, val] of Object.entries(extra)) if (val) query.set(key, val);
    const text = query.toString();
    return text ? `/admin/poultry/customers?${text}` : "/admin/poultry/customers";
  };

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Clientes de cajones, su lista de precios y lo que compran.</p>
      <PoultryCustomerModal lists={lists} />
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    {detail ? <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" data-testid="poultry-customer-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">{detail.customer.name} {detail.customer.active ? null : <StatusBadge tone="neutral">Inactivo</StatusBadge>}</h2>
          <p className="mt-1 text-sm text-stone-600">
            {[detail.customer.phone, detail.customer.address, detail.customer.taxId].filter(Boolean).join(" · ") || "Sin datos de contacto"}
          </p>
          <p className="mt-1 text-sm text-stone-600">Lista de precios: <strong>{detail.customer.priceListName ?? "General"}</strong></p>
          {detail.customer.notes ? <p className="mt-1 text-sm text-stone-500">{detail.customer.notes}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <PoultryCustomerModal customer={detail.customer} lists={lists} />
          <PoultryCustomerPricesModal detail={detail} />
          <Link className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white" href={`/admin/poultry/orders?new=1&customer=${detail.customer.id}`}>Nuevo pedido</Link>
          <Link className="rounded-lg border px-3 py-2 text-sm font-bold" href="/admin/poultry/customers">Cerrar ficha</Link>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Pedidos entregados", String(detail.totals.orders)], ["Cajones", detail.totals.boxes.toLocaleString("es-AR")],
          ["Kilos", detail.totals.weightGrams > 0 ? formatKg(detail.totals.weightGrams) : "—"], ["Facturación", formatCurrency(detail.totals.revenueCents)],
          ["Ganancia bruta", formatCurrency(detail.totals.profitCents)], ["Margen", formatMargin(detail.totals.marginBps)]
        ].map(([label, text]) => <div key={label}><dt className="text-xs font-bold uppercase text-stone-500">{label}</dt><dd className="text-lg font-black">{text}</dd></div>)}
      </dl>
      <h3 className="mt-5 font-black">Pedidos recientes</h3>
      {detail.recentOrders.length === 0 ? <p className="mt-1 text-sm text-stone-500">Todavía no tiene pedidos.</p> : <table className="mt-1 w-full text-left text-sm"><tbody>{detail.recentOrders.map((order) => (
        <tr className="border-t border-stone-100" key={order.id}>
          <td className="py-1.5"><Link className="font-bold hover:text-rose-800" href={`/admin/poultry/orders?order=${order.id}`}>#{order.orderNumber}</Link></td>
          <td className="py-1.5">{formatIsoDate(order.orderedOn)}</td><td className="py-1.5">{order.boxes} cajones</td>
          <td className="py-1.5"><StatusBadge tone={POULTRY_STATUS_TONES[order.status]}>{POULTRY_STATUS_LABELS[order.status]}</StatusBadge></td>
          <td className="py-1.5 text-right font-semibold">{formatCurrency(order.revenueCents)}</td>
        </tr>
      ))}</tbody></table>}
    </section> : null}

    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_11rem_auto]">
      <input className={input} defaultValue={search} name="q" placeholder="Buscar por nombre, teléfono o DNI/CUIT…" type="search" />
      <select className={input} defaultValue={status} name="status"><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select>
      <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
    </form>
    <p className="mt-3 text-sm text-stone-500">{customers.total} cliente{customers.total === 1 ? "" : "s"}</p>

    <section className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm" data-testid="poultry-customers">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Cliente</th><th className="p-4">Lista</th><th className="p-4">Cajones</th><th className="p-4">Facturación</th><th className="p-4">Ganancia</th><th className="p-4">Última entrega</th><th className="p-4 text-right">Acciones</th></tr></thead>
        <tbody>{customers.rows.map((row) => (
          <tr className={`border-b border-stone-100 last:border-0 ${row.active ? "" : "opacity-60"}`} key={row.id}>
            <td className="p-4"><strong>{row.name}</strong>{row.phone ? <p className="text-xs text-stone-500">{row.phone}</p> : null}</td>
            <td className="p-4">{row.priceListName ?? "General"}</td>
            <td className="p-4">{row.boxes.toLocaleString("es-AR")}</td>
            <td className="p-4">{formatCurrency(row.revenueCents)}</td>
            <td className="p-4">{formatCurrency(row.profitCents)}</td>
            <td className="p-4 text-xs text-stone-500">{row.lastOrderOn ? formatIsoDate(row.lastOrderOn) : "—"}</td>
            <td className="p-4 text-right"><Link className="rounded-lg border px-3 py-2 text-sm font-bold" href={href({ customer: row.id })}>Ver ficha</Link></td>
          </tr>
        ))}</tbody>
      </table></div>
      {customers.rows.length === 0 ? <p className="p-8 text-center text-stone-500">{search || status !== "active" ? "No hay clientes para estos filtros." : "Todavía no hay clientes. Creá el primero."}</p> : null}
    </section>

    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page - 1) })}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page + 1) })}>Siguiente →</Link> : <span />}
    </nav> : null}
  </main>;
}
