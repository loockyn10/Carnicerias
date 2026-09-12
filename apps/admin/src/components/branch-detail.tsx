import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricCard, SectionHeader, StatusBadge } from "./admin-ui";
import { BranchDetailFrame } from "./branch-detail-frame";
import { BranchSummary } from "./branch-summary";
import { BranchStockPanel } from "./branch-stock-panel";
import { BranchTabs } from "./branch-tabs";
import { requireAdminContext } from "../lib/admin";
import { localDayStart, stockPriority } from "../lib/multibranch";
import { createClient } from "../lib/supabase/server";

type Tab = "summary" | "stock" | "sales" | "operation";
interface DashboardData { periods: { today: { grossCents: number; previousGrossCents: number; salesCount: number; averageTicketCents: number; kilograms: number } }; paymentsThisMonth: { method: string; amountCents: number }[] }
const paymentLabels: Record<string, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro" };

export async function BranchPage({ params, searchParams, modal = false }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>; modal?: boolean }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const context = await requireAdminContext();
  const requestedTab = typeof query.tab === "string" ? query.tab : "";
  const tab: Tab = ["stock", "sales", "operation"].includes(requestedTab) ? requestedTab as Tab : "summary";
  const supabase = await createClient();
  const [branchResult, dashboardResult, stockResult, weekSalesResult, recentSalesResult, restocksResult, wasteResult] = await Promise.all([
    supabase.from("branches").select("id, name, code, address, active").eq("organization_id", context.organizationId).eq("id", id).maybeSingle(),
    supabase.rpc("get_admin_dashboard", { p_branch_id: id }),
    supabase.from("branch_stock_status").select("product_id, product_name, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId).eq("branch_id", id),
    supabase.from("sales").select("id, completed_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 6)),
    supabase.from("sales").select("id, total_cents, total_weight_grams, completed_at, created_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(6),
    supabase.from("stock_movements").select("product_id, type, quantity_grams, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).in("type", ["PURCHASE", "RETURN", "ADJUSTMENT_POSITIVE", "TRANSFER_IN"]).order("occurred_at", { ascending: false }).limit(6),
    supabase.from("stock_operations").select("id, waste_reason, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("operation_type", "WASTE").order("occurred_at", { ascending: false }).limit(6)
  ]);
  if (!branchResult.data) notFound();
  const error = [branchResult.error, dashboardResult.error, stockResult.error, weekSalesResult.error, recentSalesResult.error, restocksResult.error, wasteResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la sucursal: {error.message}</main>;
  const todayStart = localDayStart(context.timezone);
  const metricsSalesResult = await supabase.from("sales").select("total_cents, total_weight_grams, completed_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 1));
  if (metricsSalesResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudieron cargar las métricas: {metricsSalesResult.error.message}</main>;
  const settingsResult = await supabase.from("branch_product_stock_settings").select("product_id").eq("organization_id", context.organizationId).eq("branch_id", id);
  if (settingsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la configuración de stock: {settingsResult.error.message}</main>;
  const saleIds = (weekSalesResult.data ?? []).map((sale) => sale.id);
  const itemsResult = saleIds.length ? await supabase.from("sale_items").select("sale_id, product_id, product_name_snapshot, weight_grams, subtotal_cents, discount_cents").in("sale_id", saleIds) : { data: [], error: null };
  if (itemsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el detalle comercial: {itemsResult.error.message}</main>;

  const dashboard = dashboardResult.data as unknown as DashboardData;
  const todayRows = metricsSalesResult.data.filter((sale) => (sale.completed_at ?? "") >= todayStart);
  const previousRows = metricsSalesResult.data.filter((sale) => (sale.completed_at ?? "") < todayStart);
  const grossCents = todayRows.reduce((sum, sale) => sum + sale.total_cents, 0);
  const previousGrossCents = previousRows.reduce((sum, sale) => sum + sale.total_cents, 0);
  const today = { grossCents, previousGrossCents, salesCount: todayRows.length, averageTicketCents: todayRows.length ? Math.round(grossCents / todayRows.length) : 0, kilograms: todayRows.reduce((sum, sale) => sum + sale.total_weight_grams, 0) / 1000 };
  const stock = (stockResult.data ?? []).map((row) => { const current = row.current_stock_grams ?? 0; const minimum = row.minimum_stock_grams ?? 0; return { ...row, current, minimum, target: row.target_stock_grams ?? 0, suggested: row.suggested_replenishment_grams ?? 0, priority: stockPriority(row.stock_status, current, minimum) }; }).sort((a, b) => a.priority.rank - b.priority.rank || a.current - b.current || (a.product_name ?? "").localeCompare(b.product_name ?? "", "es"));
  const configuredProducts = new Set(settingsResult.data.map((setting) => setting.product_id));
  const stockByProduct = new Map(stock.map((row) => [row.product_id, row]));
  const urgent = stock.filter((row) => row.priority.rank < 2);
  const normalStock = stock.filter((row) => row.priority.rank === 2).length;
  const items = itemsResult.data as unknown as { sale_id: string; product_id: string; product_name_snapshot: string; weight_grams: number; subtotal_cents: number; discount_cents: number }[];
  const productTotals = new Map<string, { name: string; grams: number; cents: number }>();
  for (const item of items) { const total = productTotals.get(item.product_id) ?? { name: item.product_name_snapshot, grams: 0, cents: 0 }; total.grams += item.weight_grams; total.cents += item.subtotal_cents; productTotals.set(item.product_id, total); }
  const topProducts = [...productTotals.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);
  const todaySales = new Set((weekSalesResult.data ?? []).filter((sale) => (sale.completed_at ?? "") >= localDayStart(context.timezone)).map((sale) => sale.id));
  const todayDiscounts = items.filter((item) => todaySales.has(item.sale_id)).reduce((sum, item) => sum + item.discount_cents, 0);
  const restocks = (restocksResult.data ?? []).map((movement) => ({ ...movement, productName: stockByProduct.get(movement.product_id)?.product_name ?? "Producto" }));
  const recentSales = recentSalesResult.data ?? [];
  const recentWaste = wasteResult.data ?? [];
  const change = today.previousGrossCents ? ((today.grossCents - today.previousGrossCents) / today.previousGrossCents) * 100 : null;
  const adminLinks: [string, string][] = [["Stock y movimientos", "/admin/stock"], ["Productos", "/admin/products"], ["Promociones", "/admin/promotions"], ["Avisos", "/admin/announcements"], ["Empleados", "/admin/employees"], ["Dispositivos", "/admin/devices"], ["Auditoría", "/admin/audit"]];

  return <BranchDetailFrame modal={modal} status={branchResult.data.active ? "ACTIVA" : "INACTIVA"} subtitle={`${branchResult.data.code}${branchResult.data.address ? ` · ${branchResult.data.address}` : ""}`} title={branchResult.data.name}><main className="mx-auto max-w-7xl p-5 sm:p-10">{!modal ? <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/branches">← Volver a sucursales</Link> : null}<div className={modal ? "hidden" : "mt-4 flex flex-wrap items-start justify-between gap-3"}><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Sucursal</p><h1 className="mt-1 text-3xl font-black">{branchResult.data.name}</h1><p className="mt-1 text-stone-600">{branchResult.data.code}{branchResult.data.address ? ` · ${branchResult.data.address}` : ""}</p></div><StatusBadge tone={branchResult.data.active ? "success" : "neutral"}>{branchResult.data.active ? "ACTIVA" : "INACTIVA"}</StatusBadge></div>
    <BranchTabs active={tab} branchId={id} />
    {tab === "summary" ? <BranchSummary alerts={urgent.map((row) => ({ productId: row.product_id ?? "", productName: row.product_name ?? "Producto", current: row.current, suggested: row.suggested, rank: row.priority.rank, label: row.priority.label }))} branchId={id} change={change} metrics={today} products={topProducts} stockCounts={{ out: stock.filter((row) => row.priority.rank === 0).length, low: stock.filter((row) => row.priority.rank === 1).length, normal: normalStock }} /> : null}
    {tab === "stock" ? <BranchStockPanel rows={stock.map((row) => ({ productId: row.product_id ?? "", productName: row.product_name ?? "Producto", current: row.current, minimum: row.minimum, target: row.target, suggested: row.suggested, configured: configuredProducts.has(row.product_id ?? ""), rank: row.priority.rank, label: row.priority.label, daily: (productTotals.get(row.product_id ?? "")?.grams ?? 0) / 7 }))} /> : null}
    {tab === "sales" ? <div className="mt-6 grid gap-7 lg:grid-cols-2"><section><SectionHeader title="Ventas recientes" action={<Link className="text-sm font-bold text-rose-800 hover:underline" href={`/admin/sales?preset=today&branch=${id}`}>Ver ventas →</Link>} /><div className="mt-3 divide-y rounded-xl border bg-white">{recentSales.map((sale) => <div className="flex justify-between gap-4 px-4 py-3 text-sm" key={sale.id}><span>{new Date(sale.completed_at ?? sale.created_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{formatCurrency(BigInt(sale.total_cents))} · {formatWeight(sale.total_weight_grams)}</strong></div>)}{!recentSales.length ? <p className="px-4 py-5 text-stone-500">Sin ventas recientes.</p> : null}</div><SectionHeader title="Productos vendidos" description="Últimos 7 días" /><div className="mt-3 divide-y rounded-xl border bg-white">{topProducts.map((product) => <div className="flex justify-between gap-3 px-4 py-3" key={product.name}><strong>{product.name}</strong><span>{formatWeight(product.grams)} · {formatCurrency(BigInt(product.cents))}</span></div>)}</div></section><section><SectionHeader title="Métricas comerciales" /><div className="mt-3 grid gap-3 sm:grid-cols-2"><MetricCard label="Descuentos hoy" value={formatCurrency(BigInt(todayDiscounts))} /><MetricCard label="Facturación hoy" value={formatCurrency(BigInt(today.grossCents))} /></div><SectionHeader title="Medios de pago" description="Mes actual" /><div className="mt-3 divide-y rounded-xl border bg-white">{dashboard.paymentsThisMonth.map((payment) => <div className="flex justify-between px-4 py-3" key={payment.method}><span>{paymentLabels[payment.method] ?? payment.method}</span><strong>{formatCurrency(BigInt(payment.amountCents))}</strong></div>)}</div></section></div> : null}
    {tab === "operation" ? <div className="mt-6 grid gap-7 lg:grid-cols-2"><section><SectionHeader title="Mermas recientes" action={<Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/stock">Ver movimientos →</Link>} /><div className="mt-3 divide-y rounded-xl border bg-white">{recentWaste.map((waste) => <div className="flex justify-between gap-3 px-4 py-3 text-sm" key={waste.id}><span>{new Date(waste.occurred_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{waste.waste_reason ?? "Merma"}</strong></div>)}{!recentWaste.length ? <p className="px-4 py-5 text-stone-500">Sin mermas recientes.</p> : null}</div><SectionHeader title="Reingresos recientes" /><div className="mt-3 divide-y rounded-xl border bg-white">{restocks.map((movement) => <div className="flex justify-between gap-3 px-4 py-3 text-sm" key={`${movement.product_id}-${movement.occurred_at}`}><span>{movement.productName} · {movement.type}</span><strong>+{formatWeight(Math.abs(movement.quantity_grams))}</strong></div>)}{!restocks.length ? <p className="px-4 py-5 text-stone-500">Sin reingresos recientes.</p> : null}</div></section><section><SectionHeader title="Administración de la sucursal" description="Accesos a las funciones existentes." /><div className="mt-3 grid gap-2 sm:grid-cols-2">{adminLinks.map(([label, href]) => <Link className="rounded-lg border bg-white px-4 py-3 font-bold hover:border-rose-300 hover:text-rose-800" href={href} key={label}>{label} →</Link>)}</div></section></div> : null}
  </main></BranchDetailFrame>;
}

export default BranchPage;
