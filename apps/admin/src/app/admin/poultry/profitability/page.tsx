import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";

import { MetricCard } from "../../../../components/admin-ui";
import { SalesRangeFilter } from "../../../../components/sales-range-filter";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { periodLabel, resolveSalesRange } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import {
  formatKg, formatMargin, isProfitabilityGroup, parseCustomersPage, parsePriceBoard, parseProfitability, PROFITABILITY_GROUP_LABELS, PROFITABILITY_GROUPS
} from "../../../../lib/poultry";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const PAGE_SIZE = 50;

/**
 * Pollos → Rentabilidad: facturación, costo histórico, ganancia bruta y margen por período, producto, cliente o pedido. Usa los snapshots de cada
 * línea (precio al crear, costo al entregar): nunca el costo actual. La agregación y la paginación se hacen en el servidor.
 */
export default async function PoultryProfitabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry/profitability");
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const hasDates = Boolean(value("from") || value("to"));
  const range = resolveSalesRange({ preset: value("preset") || (hasDates ? undefined : "30d"), from: value("from"), to: value("to") }, context.timezone);
  const group = isProfitabilityGroup(value("group")) ? value("group") : "product";
  const productId = isUuid(value("product")) ? value("product") : "";
  const customerId = isUuid(value("customer")) ? value("customer") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);

  const supabase = await createClient();
  const [result, boardResult, customersResult] = await Promise.all([
    perf.measure("profitability", supabase.rpc("get_poultry_profitability", {
      p_from: range.from, p_to: range.to, p_group_by: group, ...(productId ? { p_product_id: productId } : {}), ...(customerId ? { p_customer_id: customerId } : {}),
      p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE
    })),
    perf.measure("products", supabase.rpc("get_poultry_price_board")),
    perf.measure("customers", supabase.rpc("list_poultry_customers_page", { p_status: "all", p_limit: 200 }))
  ]);
  perf.flush();
  const report = parseProfitability(result.data);
  const products = parsePriceBoard(boardResult.data).products;
  const customers = parseCustomersPage(customersResult.data).rows;
  const error = result.error ?? boardResult.error ?? customersResult.error;
  const totalPages = Math.max(1, Math.ceil(report.total / PAGE_SIZE));
  const base = { group, product: productId, customer: customerId };
  const href = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (range.preset !== "30d") { if (range.preset !== "custom") query.set("preset", range.preset); else { query.set("from", range.from); query.set("to", range.to); } }
    for (const [key, val] of Object.entries({ ...base, ...extra })) if (val && !(key === "group" && val === "product")) query.set(key, val);
    const text = query.toString();
    return text ? `/admin/poultry/profitability?${text}` : "/admin/poultry/profitability";
  };
  const chip = (active: boolean) => `rounded-full px-4 py-2 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;
  const totals = report.totals;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <p className="max-w-2xl text-stone-600">Sólo pedidos entregados. El precio es el del pedido y el costo es el vigente cuando se entregó: cambiar costos o precios después no altera este análisis.</p>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <SalesRangeFilter error={range.error} preserve={{ group: group === "product" ? "" : group, product: productId, customer: customerId }} range={range} />
    <div className="mt-3 flex flex-wrap gap-2" data-testid="profitability-groups">
      {PROFITABILITY_GROUPS.map((key) => <Link className={chip(group === key)} href={href({ group: key, page: "" })} key={key}>Por {PROFITABILITY_GROUP_LABELS[key].toLowerCase()}</Link>)}
    </div>
    <form className="mt-3 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_1fr_auto]">
      {group !== "product" ? <input name="group" type="hidden" value={group} /> : null}
      {range.preset === "custom" ? <><input name="from" type="hidden" value={range.from} /><input name="to" type="hidden" value={range.to} /></> : range.preset !== "30d" ? <input name="preset" type="hidden" value={range.preset} /> : null}
      <select aria-label="Producto" className={input} defaultValue={productId} name="product"><option value="">Todos los productos</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
      <select aria-label="Cliente" className={input} defaultValue={customerId} name="customer"><option value="">Todos los clientes</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>
      <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button>
    </form>

    <h2 className="mt-6 text-xl font-black">Total — {periodLabel(range)}</h2>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="profitability-totals">
      <MetricCard detail={`${String(totals.orders)} pedido${totals.orders === 1 ? "" : "s"} · ${totals.boxes.toLocaleString("es-AR")} cajones${totals.weightGrams > 0 ? ` · ${formatKg(totals.weightGrams)}` : ""}`} label="Facturación" value={formatCurrency(totals.revenueCents)} />
      <MetricCard label="Costo histórico" value={formatCurrency(totals.costCents)} />
      <MetricCard label="Ganancia bruta" value={formatCurrency(totals.profitCents)} />
      <MetricCard label="Margen bruto" value={formatMargin(totals.marginBps)} />
    </div>

    <section className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm" data-testid="profitability-rows">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">{PROFITABILITY_GROUP_LABELS[report.groupBy]}</th><th className="p-4 text-right">Pedidos</th><th className="p-4 text-right">Cajones</th><th className="p-4 text-right">Facturación</th><th className="p-4 text-right">Costo</th><th className="p-4 text-right">Ganancia</th><th className="p-4 text-right">Margen</th></tr></thead>
        <tbody>{report.rows.map((row) => (
          <tr className="border-b border-stone-100 last:border-0" key={row.key}>
            <td className="p-4 font-semibold">{report.groupBy === "order" ? <Link className="hover:text-rose-800" href={`/admin/poultry/orders?order=${row.key}`}>{row.label}</Link> : row.label}</td>
            <td className="p-4 text-right">{row.orders}</td><td className="p-4 text-right">{row.boxes.toLocaleString("es-AR")}</td>
            <td className="p-4 text-right">{formatCurrency(row.revenueCents)}</td><td className="p-4 text-right">{formatCurrency(row.costCents)}</td>
            <td className="p-4 text-right font-bold">{formatCurrency(row.profitCents)}</td><td className="p-4 text-right">{formatMargin(row.marginBps)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {report.rows.length === 0 ? <p className="p-8 text-center text-stone-500">No hay pedidos entregados en este período.</p> : null}
    </section>

    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page - 1) })}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: String(page + 1) })}>Siguiente →</Link> : <span />}
    </nav> : null}
  </main>;
}
