import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireAdminContext } from "../../../../lib/admin";
import { createClient } from "../../../../lib/supabase/server";

interface DashboardData {
  periods: { today: { grossCents: number; previousGrossCents: number; salesCount: number; averageTicketCents: number; kilograms: number } };
  paymentsThisMonth: { method: string; amountCents: number; salesCount: number }[];
}

const PAYMENT_LABELS: Record<string, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro" };

function dayStart(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const day = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  const rendered = Object.fromEntries(formatter.formatToParts(new Date(midnightGuess)).map((part) => [part.type, part.value]));
  const renderedAsUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour), Number(rendered.minute), Number(rendered.second));
  return new Date(midnightGuess + midnightGuess - renderedAsUtc).toISOString();
}

function stockState(status: string | null, current: number, minimum: number) {
  if (status === "DISCONTINUED") return { label: "INACTIVO", className: "bg-stone-200 text-stone-700", urgency: 3 };
  if (status === "OUT_OF_STOCK" || status === "CRITICAL" || (status !== "DISCONTINUED" && current <= 0)) return { label: "CRÍTICO", className: "bg-red-100 text-red-800", urgency: 0 };
  if (status === "LOW_STOCK" || status === "LOW" || current < minimum) return { label: "BAJO", className: "bg-amber-100 text-amber-800", urgency: 1 };
  return { label: "DISPONIBLE", className: "bg-emerald-100 text-emerald-800", urgency: 2 };
}

function Metric({ label, value }: { label: string; value: string }) {
  return <article className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p><p className="mt-2 text-2xl font-black text-rose-800">{value}</p></article>;
}

export default async function BranchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, queryParams] = await Promise.all([params, searchParams]);
  const context = await requireAdminContext();
  const supabase = await createClient();
  const startToday = dayStart(context.timezone);
  const weekStart = new Date(new Date(startToday).getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const stockQuery = typeof queryParams.q === "string" ? queryParams.q.trim() : "";

  const [branchResult, dashboardResult, stockResult, weekSalesResult, recentSalesResult, movementsResult, wasteResult] = await Promise.all([
    supabase.from("branches").select("id, name, code, address, active").eq("organization_id", context.organizationId).eq("id", id).maybeSingle(),
    supabase.rpc("get_admin_dashboard", { p_branch_id: id }),
    supabase.from("branch_stock_status").select("product_id, product_name, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId).eq("branch_id", id),
    supabase.from("sales").select("id, completed_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").gte("completed_at", weekStart),
    supabase.from("sales").select("id, total_cents, total_weight_grams, completed_at, created_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(6),
    supabase.from("stock_movements").select("product_id, type, quantity_grams, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).in("type", ["PURCHASE", "RETURN", "ADJUSTMENT_POSITIVE", "TRANSFER_IN"]).order("occurred_at", { ascending: false }).limit(5),
    supabase.from("stock_operations").select("id, waste_reason, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("operation_type", "WASTE").order("occurred_at", { ascending: false }).limit(4)
  ]);
  if (!branchResult.data) notFound();
  const error = [branchResult.error, dashboardResult.error, stockResult.error, weekSalesResult.error, recentSalesResult.error, movementsResult.error, wasteResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la sucursal: {error.message}</main>;

  const weekSaleIds = (weekSalesResult.data ?? []).map((sale) => sale.id);
  const itemsResult = weekSaleIds.length ? await supabase.from("sale_items").select("sale_id, product_id, product_name_snapshot, weight_grams, subtotal_cents, discount_cents").in("sale_id", weekSaleIds) : { data: [], error: null };
  if (itemsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el detalle comercial: {itemsResult.error.message}</main>;

  const dashboard = dashboardResult.data as unknown as DashboardData;
  const today = dashboard.periods.today;
  const todaySaleIds = new Set((weekSalesResult.data ?? []).filter((sale) => (sale.completed_at ?? "") >= startToday).map((sale) => sale.id));
  const items = itemsResult.data as unknown as { sale_id: string; product_id: string; product_name_snapshot: string; weight_grams: number; subtotal_cents: number; discount_cents: number }[];
  const discountCents = items.filter((item) => todaySaleIds.has(item.sale_id)).reduce((sum, item) => sum + item.discount_cents, 0);
  const productTotals = new Map<string, { name: string; grams: number; cents: number }>();
  for (const item of items) {
    const current = productTotals.get(item.product_id) ?? { name: item.product_name_snapshot, grams: 0, cents: 0 };
    current.grams += item.weight_grams;
    current.cents += item.subtotal_cents;
    productTotals.set(item.product_id, current);
  }

  const stock = (stockResult.data ?? []).map((row) => {
    const current = row.current_stock_grams ?? 0;
    const minimum = row.minimum_stock_grams ?? 0;
    return { ...row, current, minimum, target: row.target_stock_grams ?? 0, suggested: row.suggested_replenishment_grams ?? 0, state: stockState(row.stock_status, current, minimum) };
  }).sort((a, b) => a.state.urgency - b.state.urgency || a.current - b.current || (a.product_name ?? "").localeCompare(b.product_name ?? "", "es"));
  const visibleStock = stock.filter((row) => !stockQuery || (row.product_name ?? "").toLocaleLowerCase("es").includes(stockQuery.toLocaleLowerCase("es")));
  const stockByProduct = new Map(stock.map((row) => [row.product_id, row]));
  const urgent = stock.filter((row) => row.state.urgency < 2);
  const topProducts = [...productTotals.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);
  const recentRestocks = (movementsResult.data ?? []).map((movement) => ({ ...movement, productName: stockByProduct.get(movement.product_id)?.product_name ?? "Producto" }));
  const change = today.previousGrossCents ? ((today.grossCents - today.previousGrossCents) / today.previousGrossCents) * 100 : null;
  const quickLinks: [string, string][] = [
    ["Ventas", `/admin/sales?preset=today&branch=${id}`], ["Stock y movimientos", "/admin/stock"], ["Productos y precios", "/admin/catalog"], ["Descuentos", "/admin/catalog#discounts"], ["Avisos", "/admin/catalog#announcements"], ["Empleados", "/admin/employees"]
  ];
  const recentSales = recentSalesResult.data ?? [];
  const paymentMetrics = dashboard.paymentsThisMonth;
  const recentWaste = wasteResult.data ?? [];

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin">← Volver a sucursales</Link>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Panel operativo</p><h1 className="mt-1 text-3xl font-black">{branchResult.data.name}</h1><p className="mt-2 text-stone-600">{branchResult.data.code}{branchResult.data.address ? ` · ${branchResult.data.address}` : ""}</p></div><span className={`rounded-full px-3 py-1 text-sm font-black ${branchResult.data.active ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-700"}`}>{branchResult.data.active ? "ACTIVA" : "INACTIVA"}</span></div>

    <section className="mt-6 flex flex-wrap gap-2">{quickLinks.map(([label, href]) => <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-bold hover:border-rose-300 hover:text-rose-800" href={href} key={label}>{label}</Link>)}</section>
    <section className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-5"><Metric label="Facturación hoy" value={formatCurrency(BigInt(today.grossCents))} /><Metric label="Kg vendidos" value={formatWeight(Math.round(today.kilograms * 1000))} /><Metric label="Tickets" value={String(today.salesCount)} /><Metric label="Ticket promedio" value={formatCurrency(BigInt(today.averageTicketCents))} /><Metric label="Descuentos otorgados" value={formatCurrency(BigInt(discountCents))} /></section>
    {change !== null ? <p className={`mt-3 text-sm font-bold ${change < 0 ? "text-red-700" : "text-emerald-700"}`}>{change >= 0 ? "+" : ""}{change.toFixed(1)}% de facturación frente a ayer.</p> : null}

    <section className={`mt-7 rounded-2xl border p-5 ${urgent.length ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><p className={`text-xs font-bold uppercase tracking-wider ${urgent.length ? "text-amber-800" : "text-emerald-800"}`}>Requiere atención</p><h2 className="mt-1 text-xl font-black">{urgent.length ? `${String(urgent.length)} producto${urgent.length === 1 ? "" : "s"} con prioridad operativa` : "Sin alertas de stock"}</h2>{urgent.length ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{urgent.slice(0, 8).map((row) => <article className="rounded-xl border border-amber-200 bg-white p-4" key={row.product_id}><div className="flex items-start justify-between gap-3"><strong>{row.product_name}</strong><span className={`rounded-full px-2 py-1 text-xs font-black ${row.state.className}`}>{row.state.label}</span></div><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-stone-500">Actual</dt><dd className="font-bold">{formatWeight(row.current)}</dd></div><div><dt className="text-stone-500">Mínimo</dt><dd className="font-bold">{formatWeight(row.minimum)}</dd></div><div><dt className="text-stone-500">Objetivo</dt><dd className="font-bold">{formatWeight(row.target)}</dd></div><div><dt className="text-stone-500">Reponer</dt><dd className="font-bold">{formatWeight(row.suggested)}</dd></div></dl></article>)}</div> : <p className="mt-3 text-sm text-emerald-800">El stock de peso está disponible según sus mínimos configurados.</p>}</section>

    <section className="mt-7 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-black">Stock de la sucursal</h2><p className="mt-1 text-sm text-stone-600">Ordenado por urgencia.</p></div><form className="flex gap-2"><input className="rounded-lg border border-stone-300 px-3 py-2 text-sm" defaultValue={stockQuery} name="q" placeholder="Buscar producto…" /><button className="rounded-lg border px-3 py-2 text-sm font-bold">Buscar</button></form></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b text-stone-500"><tr><th className="p-3">Producto</th><th className="p-3">Actual</th><th className="p-3">Mínimo</th><th className="p-3">Objetivo</th><th className="p-3">Estado</th><th className="p-3">Reposición sugerida</th><th className="p-3">Cobertura simple</th></tr></thead><tbody>{visibleStock.map((row) => { const average = (productTotals.get(row.product_id ?? "")?.grams ?? 0) / 7; return <tr className="border-b border-stone-100" key={row.product_id}><td className="p-3 font-bold">{row.product_name}</td><td className="p-3">{formatWeight(row.current)}</td><td className="p-3">{formatWeight(row.minimum)}</td><td className="p-3">{formatWeight(row.target)}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-black ${row.state.className}`}>{row.state.label}</span></td><td className="p-3">{formatWeight(row.suggested)}</td><td className="p-3">{average > 0 ? `≈ ${(row.current / average).toFixed(1)} días` : "Sin ventas recientes"}</td></tr>; })}</tbody></table></div>{!visibleStock.length ? <p className="mt-4 text-center text-stone-500">No hay productos para esta búsqueda.</p> : null}</section>

    <div className="mt-7 grid gap-6 lg:grid-cols-2"><section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><h2 className="text-xl font-black">Productos más vendidos</h2><p className="mt-1 text-sm text-stone-600">Últimos 7 días.</p></div><Link className="text-sm font-bold text-rose-800 hover:underline" href={`/admin/sales?branch=${id}&preset=week`}>Ver ventas</Link></div><div className="mt-4 space-y-3">{topProducts.map((product, index) => <div className="flex items-center justify-between gap-4 border-b border-stone-100 pb-3" key={product.name}><div><span className="mr-2 text-stone-400">#{index + 1}</span><strong>{product.name}</strong><p className="text-sm text-stone-500">{formatWeight(product.grams)}</p></div><strong className="text-rose-800">{formatCurrency(BigInt(product.cents))}</strong></div>)}{!topProducts.length ? <p className="text-stone-500">Sin ventas en los últimos 7 días.</p> : null}</div></section>
      <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><div className="flex justify-between gap-3"><div><h2 className="text-xl font-black">Operación reciente</h2><p className="mt-1 text-sm text-stone-600">Ventas, cobros y movimientos de stock.</p></div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/stock">Ver movimientos</Link></div><h3 className="mt-4 text-sm font-black uppercase tracking-wide text-stone-500">Ventas recientes</h3><div className="mt-2 space-y-2">{recentSales.slice(0, 4).map((sale) => <div className="flex justify-between gap-3 text-sm" key={sale.id}><span>{new Date(sale.completed_at ?? sale.created_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{formatCurrency(BigInt(sale.total_cents))} · {formatWeight(sale.total_weight_grams)}</strong></div>)}{!recentSales.length ? <p className="text-sm text-stone-500">Sin ventas recientes.</p> : null}</div><h3 className="mt-5 text-sm font-black uppercase tracking-wide text-stone-500">Medios de pago · mes</h3><div className="mt-2 grid grid-cols-2 gap-2 text-sm">{paymentMetrics.slice(0, 4).map((payment) => <div className="rounded-lg bg-stone-50 p-2" key={payment.method}><span className="text-stone-500">{PAYMENT_LABELS[payment.method] ?? payment.method}</span><p className="font-black">{formatCurrency(BigInt(payment.amountCents))}</p></div>)}</div><h3 className="mt-5 text-sm font-black uppercase tracking-wide text-stone-500">Mermas recientes</h3><div className="mt-2 space-y-2">{recentWaste.map((waste) => <div className="flex justify-between gap-3 text-sm" key={waste.id}><span>{new Date(waste.occurred_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{waste.waste_reason ?? "Merma"}</strong></div>)}{!recentWaste.length ? <p className="text-sm text-stone-500">Sin mermas recientes.</p> : null}</div><h3 className="mt-5 text-sm font-black uppercase tracking-wide text-stone-500">Reingresos recientes</h3><div className="mt-2 space-y-2">{recentRestocks.map((movement) => <div className="flex justify-between gap-3 text-sm" key={movement.product_id + movement.occurred_at}><span>{movement.productName} · {movement.type}</span><strong>+{formatWeight(Math.abs(movement.quantity_grams))}</strong></div>)}{!recentRestocks.length ? <p className="text-sm text-stone-500">Sin reingresos recientes.</p> : null}</div></section></div>
  </main>;
}
