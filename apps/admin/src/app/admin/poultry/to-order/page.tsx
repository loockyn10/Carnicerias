import Link from "next/link";

import { PoultryEmptyState } from "../../../../components/poultry-empty-state";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { formatIsoDate } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import { hasActivePoultryProducts, parsePriceBoard } from "../../../../lib/poultry";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import {
  listToOrderDates, parseToOrder, resolveToOrderSelection, summarizeToOrder, TO_ORDER_VIEW_LABELS, TO_ORDER_VIEWS, type ToOrderView
} from "../../../../lib/poultry-to-order";
import { createClient } from "../../../../lib/supabase/server";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

/**
 * Pollos → Mercadería a encargar (D-105): cuántos cajones de cada producto hay que comprarle al proveedor para cumplir los pedidos abiertos.
 * Se calcula en cada consulta a partir de los pedidos ya registrados (`get_poultry_boxes_to_order`): nada se carga, sincroniza ni guarda, y
 * una edición, cancelación, entrega o cambio de fecha de un pedido se ve en la siguiente consulta. No descuenta stock ni genera compras.
 */
export default async function PoultryToOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry/to-order");
  await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");

  const supabase = await createClient();
  const [{ data, error }, boardResult] = await Promise.all([
    perf.measure("toOrder", supabase.rpc("get_poultry_boxes_to_order")),
    perf.measure("products", supabase.rpc("get_poultry_price_board"))
  ]);
  perf.flush();
  const noProducts = !boardResult.error && !hasActivePoultryProducts(parsePriceBoard(boardResult.data).products);
  const { today, lines } = parseToOrder(data);
  const dates = listToOrderDates(lines, today);
  const { view, date } = resolveToOrderSelection(value("view"), value("date"), dates, today);
  const summary = summarizeToOrder(lines, view, date);

  const href = (nextView: ToOrderView, nextDate?: string) => {
    const query = new URLSearchParams();
    if (nextView !== "all") query.set("view", nextView);
    if (nextView === "date" && nextDate) query.set("date", nextDate);
    const text = query.toString();
    return text ? `/admin/poultry/to-order?${text}` : "/admin/poultry/to-order";
  };
  const chip = (active: boolean) => `rounded-full px-4 py-2 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;
  const viewBoxes = (key: ToOrderView) => summarizeToOrder(lines, key, key === "date" ? date : null).totalBoxes;
  const showCategories = summary.sections.length > 1;
  const grandTotal = summarizeToOrder(lines, "all").totalBoxes;
  const emptyText = view === "none" ? "No hay pedidos abiertos sin fecha de entrega." : view === "date" ? "No hay cajones pendientes para esta fecha." : "No hay cajones pendientes: todos los pedidos están entregados o cancelados.";

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Cajones que hay que encargar al proveedor para cumplir los pedidos abiertos. Se calcula solo con los pedidos registrados: no descuenta stock ni genera compras.</p>
      <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" href="/admin/poultry/orders">Ver pedidos abiertos</Link>
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {noProducts ? <PoultryEmptyState /> : null}

    <div className="mt-6 flex flex-wrap gap-2" data-testid="poultry-to-order-views">
      {TO_ORDER_VIEWS.map((key) => <Link aria-current={view === key ? "page" : undefined} className={chip(view === key)} href={href(key, date)} key={key}>
        {TO_ORDER_VIEW_LABELS[key]} <span className={view === key ? "font-normal opacity-90" : "font-normal text-stone-500"}>· {key === "all" ? grandTotal : viewBoxes(key)}</span>
      </Link>)}
    </div>

    {view === "date" ? <section className="mt-3 rounded-xl bg-white p-4 shadow-sm" data-testid="poultry-to-order-dates">
      <form className="flex flex-wrap items-end gap-3">
        <input name="view" type="hidden" value="date" />
        <label className="grid gap-1 text-xs font-bold text-stone-500">Fecha de entrega<input className={`${input} font-normal text-stone-900`} defaultValue={date} key={date} name="date" required type="date" /></label>
        <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Ver fecha</button>
      </form>
      {dates.length === 0 ? <p className="mt-3 text-sm text-stone-500">Ningún pedido abierto tiene fecha de entrega.</p> : <ul className="mt-3 flex flex-wrap gap-2">
        {dates.map((entry) => <li key={entry.date}>
          <Link aria-current={entry.date === date ? "date" : undefined} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${entry.date === date ? "border-rose-800 bg-rose-50 font-bold text-rose-900" : "border-stone-200 hover:border-rose-300"}`} href={href("date", entry.date)}>
            {formatIsoDate(entry.date)}{entry.date === today ? " · hoy" : ""}
            <span className="text-xs text-stone-500">{entry.boxes} cajón{entry.boxes === 1 ? "" : "es"}</span>
            {entry.overdue ? <span className="text-xs font-bold text-amber-700">Vencida</span> : null}
          </Link>
        </li>)}
      </ul>}
    </section> : null}

    <h2 className="mt-6 text-lg font-black" data-testid="poultry-to-order-title">
      {view === "all" ? "Total general: todos los cajones pendientes" : view === "none" ? "Pedidos abiertos sin fecha de entrega" : `Entrega del ${formatIsoDate(date)}${date === today ? " (hoy)" : date < today ? " (vencida)" : ""}`}
    </h2>
    {view === "all" ? <p className="mt-1 text-sm text-stone-500">Incluye los pedidos sin fecha y los de fechas anteriores que todavía no se entregaron.</p> : null}

    <section className="mt-3 overflow-hidden rounded-xl bg-white shadow-sm">
      {summary.sections.length === 0 ? <p className="p-8 text-center text-stone-500" data-testid="poultry-to-order-empty">{emptyText}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm" data-testid="poultry-to-order-table">
          <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Producto</th><th className="p-4 text-right">Cajones a encargar</th></tr></thead>
          {summary.sections.map((section) => <tbody data-category={section.category} key={section.category}>
            {showCategories ? <tr className="border-b border-stone-100 bg-stone-50/60"><th className="px-4 py-2 text-xs font-black uppercase tracking-wide text-stone-600" colSpan={2}>{section.label} <span className="font-normal normal-case text-stone-500">· {section.boxes} cajón{section.boxes === 1 ? "" : "es"}</span></th></tr> : null}
            {section.rows.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.productId}>
              <td className="p-4 font-semibold">{row.name}<span className="block text-xs font-normal text-stone-500">{row.orders} pedido{row.orders === 1 ? "" : "s"}</span></td>
              <td className="p-4 text-right text-lg font-black tabular-nums">{row.boxes.toLocaleString("es-AR")}</td>
            </tr>)}
          </tbody>)}
          <tfoot><tr className="border-t-2 border-stone-300 bg-stone-50"><th className="p-4 text-base font-black">TOTAL</th><td className="p-4 text-right text-xl font-black tabular-nums" data-testid="poultry-to-order-total">{summary.totalBoxes.toLocaleString("es-AR")}</td></tr></tfoot>
        </table>
      </div>}
    </section>
  </main>;
}
