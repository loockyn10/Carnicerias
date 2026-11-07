import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";

import { StatusBadge } from "../../../../components/admin-ui";
import { PoultryNoProductsNotice } from "../../../../components/poultry-empty-state";
import { PoultryOrderForm } from "../../../../components/poultry-order-form";
import { PoultryOrderPanel } from "../../../../components/poultry-order-panel";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { formatIsoDate, isIsoDate, localDateString } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import {
  formatKg, isOpenStatus, parseCustomersPage, parseOrderDetail, parseOrdersPage, parseResolvedPrices, POULTRY_STATUS_LABELS, POULTRY_STATUS_TONES, POULTRY_STATUSES
} from "../../../../lib/poultry";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 30;
const STATUS_FILTERS = ["open", ...POULTRY_STATUSES, "all"] as const;

/**
 * Pollos → Pedidos: lista paginada en el servidor, carga rápida de un pedido nuevo (`?new=1`), edición (`?edit=`) y detalle (`?order=`).
 * Los abiertos van primero y por fecha de entrega; entregados y cancelados quedan abajo, del más reciente al más viejo.
 */
export default async function PoultryOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry/orders");
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const isNew = value("new") === "1";
  const editId = isUuid(value("edit")) ? value("edit") : "";
  const orderId = isUuid(value("order")) ? value("order") : "";
  const filter = (STATUS_FILTERS as readonly string[]).includes(value("status")) ? value("status") : "open";
  const search = value("q").trim();
  const from = isIsoDate(value("from")) ? value("from") : "";
  const to = isIsoDate(value("to")) ? value("to") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);
  const formMode = isNew || Boolean(editId);

  const supabase = await createClient();
  const today = localDateString(context.timezone);

  if (formMode) {
    const detailResult = editId ? await perf.measure("editDetail", supabase.rpc("get_poultry_order_detail", { p_order_id: editId })) : { data: null, error: null };
    const order = parseOrderDetail(detailResult.data);
    const presetCustomer = isUuid(value("customer")) ? value("customer") : "";
    const customerForPrices = order?.customerId ?? presetCustomer;
    const [customersResult, branchesResult, pricesResult, settingsResult] = await Promise.all([
      perf.measure("customers", supabase.rpc("list_poultry_customers_page", { p_status: "active", p_limit: 200 })),
      perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
      perf.measure("prices", supabase.rpc("resolve_poultry_prices", customerForPrices ? { p_customer_id: customerForPrices } : {})),
      perf.measure("productionBranch", supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single())
    ]);
    perf.flush();
    const branches = branchesResult.data ?? [];
    const defaultBranchId = order?.branchId ?? settingsResult.data?.production_branch_id ?? branches[0]?.id ?? "";
    const customers = parseCustomersPage(customersResult.data).rows.map((row) => ({ id: row.id, name: row.name }));
    // Al editar, el cliente del pedido puede estar inactivo: se lo incluye igual para que no desaparezca del selector.
    if (order && !customers.some((customer) => customer.id === order.customerId)) customers.push({ id: order.customerId, name: order.customerName });
    const error = detailResult.error ?? customersResult.error ?? branchesResult.error ?? pricesResult.error;
    return <main className="mx-auto max-w-6xl p-5 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-stone-600">{order ? `Editando el pedido #${String(order.orderNumber)}. Las líneas que no cambiás conservan el precio con el que se tomaron.` : "Cliente, fechas y un clic por producto. El precio sale de la lista del cliente."}</p>
        <Link className="rounded-lg border px-4 py-2.5 text-sm font-bold" href="/admin/poultry/orders">← Volver a pedidos</Link>
      </div>
      <SectionTabs tabs={POULTRY_TABS} />
      {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
      {editId && !order ? <p className="mt-5 rounded-lg bg-amber-50 p-4 text-amber-800">No se encontró el pedido.</p> : !order && parseResolvedPrices(pricesResult.data).length === 0 ? <PoultryNoProductsNotice /> : <div className="mt-6">
        <PoultryOrderForm branches={branches} customers={customers} defaultBranchId={defaultBranchId} initialCustomerId={order ? "" : presetCustomer} initialPrices={parseResolvedPrices(pricesResult.data)} key={order?.id ?? `new-${presetCustomer}`} order={order} today={today} />
      </div>}
    </main>;
  }

  const [listResult, detailResult] = await Promise.all([
    perf.measure("orders", supabase.rpc("list_poultry_orders_page", {
      ...(filter === "all" ? {} : { p_status: filter }), ...(from ? { p_from: from } : {}), ...(to ? { p_to: to } : {}),
      ...(search ? { p_search: search } : {}), p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE
    })),
    orderId ? perf.measure("detail", supabase.rpc("get_poultry_order_detail", { p_order_id: orderId })) : Promise.resolve({ data: null, error: null })
  ]);
  perf.flush();
  const orders = parseOrdersPage(listResult.data);
  const detail = parseOrderDetail(detailResult.data);
  const error = listResult.error ?? detailResult.error;
  const totalPages = Math.max(1, Math.ceil(orders.total / PAGE_SIZE));
  const href = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (filter !== "open") query.set("status", filter);
    if (search) query.set("q", search);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    for (const [key, val] of Object.entries(extra)) if (val) query.set(key, val);
    const text = query.toString();
    return text ? `/admin/poultry/orders?${text}` : "/admin/poultry/orders";
  };
  const chip = (active: boolean) => `rounded-full px-4 py-2 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Pedidos de cajones: de pendiente a entregado. Al entregar se congela el costo del momento.</p>
      <Link className="rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900" href="/admin/poultry/orders?new=1">+ Nuevo pedido</Link>
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {value("saved") ? <p className="mt-5 rounded-lg bg-emerald-50 p-4 text-emerald-800" role="status">Pedido #{value("saved")} guardado.</p> : null}
    {detail ? <div className="mt-6"><PoultryOrderPanel key={`${detail.id}-${detail.status}-${detail.revenueCents.toString()}`} order={detail} /></div> : orderId ? <p className="mt-5 rounded-lg bg-amber-50 p-4 text-amber-800">No se encontró el pedido.</p> : null}

    <div className="mt-6 flex flex-wrap gap-2">
      {STATUS_FILTERS.map((key) => <Link className={chip(filter === key)} href={`/admin/poultry/orders${key === "open" ? "" : `?status=${key}`}`} key={key}>{key === "open" ? "Abiertos" : key === "all" ? "Todos" : POULTRY_STATUS_LABELS[key]}</Link>)}
    </div>
    <form className="mt-3 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_10rem_10rem_auto]">
      {filter !== "open" ? <input name="status" type="hidden" value={filter} /> : null}
      <input className={input} defaultValue={search} name="q" placeholder="Buscar por cliente o número de pedido…" type="search" />
      <label className="grid gap-1 text-xs font-bold text-stone-500">Entrega desde<input className={`${input} font-normal text-stone-900`} defaultValue={from} name="from" type="date" /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-500">Entrega hasta<input className={`${input} font-normal text-stone-900`} defaultValue={to} name="to" type="date" /></label>
      <button className="self-end rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
    </form>
    <p className="mt-3 text-sm text-stone-500">{orders.total} pedido{orders.total === 1 ? "" : "s"}</p>

    <section className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm" data-testid="poultry-orders">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Pedido</th><th className="p-4">Cliente</th><th className="p-4">Detalle</th><th className="p-4">Entrega</th><th className="p-4">Estado</th><th className="p-4 text-right">Importe</th><th className="p-4 text-right">Acciones</th></tr></thead>
        <tbody>{orders.rows.map((row) => (
          <tr className="border-b border-stone-100 last:border-0" key={row.id}>
            <td className="p-4 font-bold">#{row.orderNumber}<span className="block text-xs font-normal text-stone-500">{formatIsoDate(row.orderedOn)}</span></td>
            <td className="p-4"><strong>{row.customerName}</strong><span className="block text-xs text-stone-500">{row.branchName}</span></td>
            <td className="max-w-xs p-4 text-stone-600"><span className="line-clamp-2">{row.summary}</span><span className="block text-xs text-stone-500">{row.boxes} cajones{row.weightGrams ? ` · ${formatKg(row.weightGrams)}` : ""}{row.pendingWeight ? " · falta pesar" : ""}</span></td>
            <td className="p-4">{row.deliveryOn ? formatIsoDate(row.deliveryOn) : <span className="text-stone-400">Sin fecha</span>}{isOpenStatus(row.status) && row.deliveryOn && row.deliveryOn < today ? <span className="block text-xs font-bold text-amber-700">Vencido</span> : null}</td>
            <td className="p-4"><StatusBadge tone={POULTRY_STATUS_TONES[row.status]}>{POULTRY_STATUS_LABELS[row.status]}</StatusBadge></td>
            <td className="p-4 text-right font-semibold">{formatCurrency(row.revenueCents)}</td>
            <td className="p-4 text-right"><Link className="rounded-lg border px-3 py-2 text-sm font-bold" href={href({ order: row.id })}>Abrir</Link></td>
          </tr>
        ))}</tbody>
      </table></div>
      {orders.rows.length === 0 ? <p className="p-8 text-center text-stone-500">{search || from || to || filter !== "open" ? "No hay pedidos para estos filtros." : "No hay pedidos abiertos."}</p> : null}
    </section>

    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page - 1) })}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page + 1) })}>Siguiente →</Link> : <span />}
    </nav> : null}
  </main>;
}
