import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricCard, SectionHeader, StatusBadge } from "./admin-ui";
import { BranchDetailFrame } from "./branch-detail-frame";
import { BranchForm } from "./branch-form";
import { BranchLifecyclePanel } from "./branch-lifecycle-panel";
import { ForceHardNavigation } from "./force-hard-navigation";
import { MobileBranchDetail } from "./mobile/mobile-branch-detail";
import { BranchSummary } from "./branch-summary";
import { BRANCH_STOCK_PAGE_SIZE, BranchStockPanel, type BranchStockFilter } from "./branch-stock-panel";
import { BranchTabs } from "./branch-tabs";
import { SalesRangeFilter } from "./sales-range-filter";
import { requireAdminContext } from "../lib/admin";
import { buildBranchBoard } from "../lib/branch-board";
import { toInsightRows } from "../lib/branch-insights";
import { buildCarryPlanReport } from "../lib/carry-plan";
import { comparisonLabel, periodLabel, rangeQuery, resolveSalesRange } from "../lib/date-range";
import { localDayStart, stockPriority } from "../lib/multibranch";
import { createClient } from "../lib/supabase/server";

type Tab = "summary" | "stock" | "sales";
interface DashboardData { periods: { today: { grossCents: number; previousGrossCents: number; salesCount: number; averageTicketCents: number; kilograms: number } }; paymentsThisMonth: { method: string; amountCents: number }[] }
const paymentLabels: Record<string, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro" };

export async function BranchPage({ params, searchParams, modal = false }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>; modal?: boolean }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const context = await requireAdminContext();
  const requestedTab = typeof query.tab === "string" ? query.tab : "";
  const tab: Tab = ["stock", "sales"].includes(requestedTab) ? requestedTab as Tab : "summary";
  const queryValue = (key: string) => typeof query[key] === "string" ? query[key] : "";
  // Período de las métricas del Resumen: días calendario de la organización (el mismo rango que se eligió en Sucursales).
  const range = resolveSalesRange({ preset: queryValue("preset"), from: queryValue("from"), to: queryValue("to") }, context.timezone);
  const supabase = await createClient();
  const [branchResult, dashboardResult, stockResult, weekSalesResult, recentSalesResult, restocksResult, wasteResult, rangeSummaryResult, organizationResult, profitabilityResult, operationsResult] = await Promise.all([
    supabase.from("branches").select("id, name, code, address, active").eq("organization_id", context.organizationId).eq("id", id).maybeSingle(),
    supabase.rpc("get_admin_dashboard", { p_branch_id: id }),
    // Alerts only (most urgent first): the whole branch catalog is never fetched for the summary.
    supabase.rpc("get_branch_stock_status", { p_branch_id: id, p_status: "ALERTS", p_limit: 50 }),
    supabase.from("sales").select("id, total_cents, completed_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 6)),
    supabase.from("sales").select("id, total_cents, total_weight_grams, completed_at, created_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(6),
    supabase.from("stock_movements").select("product_id, type, quantity_grams, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).in("type", ["PURCHASE", "RETURN", "ADJUSTMENT_POSITIVE", "TRANSFER_IN"]).order("occurred_at", { ascending: false }).limit(6),
    supabase.from("stock_operations").select("id, waste_reason, occurred_at").eq("organization_id", context.organizationId).eq("branch_id", id).eq("operation_type", "WASTE").order("occurred_at", { ascending: false }).limit(6),
    // Totales del período en el servidor (sólo ventas COMPLETED); también trae el período anterior para la variación.
    supabase.rpc("get_branch_sales_summary", { p_from: range.from, p_to: range.to, p_branch_id: id }),
    supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).maybeSingle(),
    // Ganancia bruta del mismo rango (mismas fórmulas que /admin/analytics). Es un complemento: si falla, el Resumen sigue sin esas tarjetas.
    supabase.rpc("get_branch_profitability_summary", { p_from: range.from, p_to: range.to, p_branch_id: id }),
    // Resumen operativo por producto (más vendidos, baja rotación, alertas por cobertura/inconsistencia): UNA llamada por lote.
    // Es un complemento: si falla, el Resumen sigue con sus métricas y avisa que no pudo calcular el bloque.
    tab === "summary" ? supabase.rpc("get_branch_operations_summary", { p_branch_id: id, p_from: range.from, p_to: range.to }) : Promise.resolve(null)
  ]);
  if (!branchResult.data) {
    // Reached with modal=true when Next's route interception (see
    // force-hard-navigation.tsx) mismatched a static sibling of [id], such as
    // /admin/branches/new or /admin/branches/compare, as a branch id. A real
    // missing/invalid id via direct navigation (modal=false) still 404s.
    if (modal) return <ForceHardNavigation />;
    notFound();
  }
  const error = [branchResult.error, dashboardResult.error, stockResult.error, weekSalesResult.error, recentSalesResult.error, restocksResult.error, wasteResult.error, rangeSummaryResult.error, organizationResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la sucursal: {error.message}</main>;
  const todayStart = localDayStart(context.timezone);
  const isProductionBranch = organizationResult.data?.production_branch_id === id;
  // «Qué llevar» reutiliza get_branch_carry_plan (ventana fija de 7 días); la sucursal productiva es el origen, no un destino.
  // Promise.resolve arranca el pedido ya: corre en paralelo con las lecturas siguientes.
  const carryPromise = tab === "summary" && !isProductionBranch ? Promise.resolve(supabase.rpc("get_branch_carry_plan", { p_branch_id: id })) : null;
  const settingsResult = await supabase.from("branch_product_stock_settings").select("product_id").eq("organization_id", context.organizationId).eq("branch_id", id);
  if (settingsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la configuración de stock: {settingsResult.error.message}</main>;
  const summaryResult = await supabase.rpc("get_branch_stock_summary");
  if (summaryResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el resumen de stock: {summaryResult.error.message}</main>;
  const stockSearch = typeof query.q === "string" ? query.q.trim() : "";
  const stockFilter: BranchStockFilter = ["critical", "low", "available"].includes(typeof query.filter === "string" ? query.filter : "") ? query.filter as BranchStockFilter : "all";
  const stockPage = Math.max(1, Number.parseInt(typeof query.page === "string" ? query.page : "1", 10) || 1);
  const stockPageStatus = { all: null, critical: "OUT_OF_STOCK", low: "LOW_STOCK", available: "AVAILABLE" }[stockFilter];
  const stockPageResult = tab === "stock"
    ? await supabase.rpc("get_branch_stock_status", { p_branch_id: id, p_limit: BRANCH_STOCK_PAGE_SIZE, p_offset: (stockPage - 1) * BRANCH_STOCK_PAGE_SIZE, ...(stockSearch ? { p_search: stockSearch } : {}), ...(stockPageStatus ? { p_status: stockPageStatus } : {}) })
    : { data: [], error: null };
  if (stockPageResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el stock: {stockPageResult.error.message}</main>;
  const restockProductIds = [...new Set((restocksResult.data ?? []).map((movement) => movement.product_id))];
  const restockProductsResult = restockProductIds.length ? await supabase.from("products").select("id, name").in("id", restockProductIds) : { data: [], error: null };
  const restockProductNames = new Map((restockProductsResult.data ?? []).map((row) => [row.id, row.name]));
  const saleIds = (weekSalesResult.data ?? []).map((sale) => sale.id);
  const itemsResult = saleIds.length ? await supabase.from("sale_items").select("sale_id, product_id, product_name_snapshot, weight_grams, quantity_units, subtotal_cents, discount_cents, ticket_discount_cents").in("sale_id", saleIds) : { data: [], error: null };
  if (itemsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el detalle comercial: {itemsResult.error.message}</main>;

  const dashboard = dashboardResult.data as unknown as DashboardData;
  const periodRow = rangeSummaryResult.data?.[0];
  const periodMetrics = {
    grossCents: periodRow?.total_cents ?? 0, previousGrossCents: periodRow?.previous_total_cents ?? 0, salesCount: periodRow?.sales_count ?? 0,
    averageTicketCents: periodRow?.sales_count ? Math.round(periodRow.total_cents / periodRow.sales_count) : 0, kilograms: (periodRow?.weight_grams ?? 0) / 1000, units: periodRow?.units ?? 0
  };
  const profitRow = profitabilityResult.error ? undefined : profitabilityResult.data[0];
  const profit = profitRow ? { grossProfitCents: profitRow.gross_profit_cents, grossMarginBps: profitRow.gross_margin_bps, missingCostItems: profitRow.missing_cost_items, missingCostSales: profitRow.missing_cost_sales, missingCostRevenueCents: profitRow.missing_cost_revenue_cents } : null;
  const todayGrossCents = (weekSalesResult.data ?? []).filter((sale) => (sale.completed_at ?? "") >= todayStart).reduce((sum, sale) => sum + sale.total_cents, 0);
  const stock = (stockResult.data ?? []).map((row) => ({
    ...row, current: row.current_stock_grams, minimum: row.minimum_stock_grams, target: row.target_stock_grams,
    suggested: row.suggested_replenishment_grams, priority: stockPriority(row.stock_status, row.current_stock_grams, row.minimum_stock_grams)
  }));
  const configuredProducts = new Set(settingsResult.data.map((setting) => setting.product_id));
  const branchSummary = summaryResult.data.find((row) => row.branch_id === id);
  const urgent = stock.filter((row) => row.priority.rank < 2);
  const stockCounts = {
    out: branchSummary?.out_of_stock_count ?? 0, low: branchSummary?.low_stock_count ?? 0,
    normal: Math.max(0, (branchSummary?.product_count ?? 0) - (branchSummary?.out_of_stock_count ?? 0) - (branchSummary?.low_stock_count ?? 0))
  };
  const items = itemsResult.data as unknown as { sale_id: string; product_id: string; product_name_snapshot: string; weight_grams: number | null; quantity_units: number | null; subtotal_cents: number; discount_cents: number; ticket_discount_cents: number }[];
  const productTotals = new Map<string, { name: string; grams: number; cents: number }>();
  // Units/grams sold per product in the week (a UNIT item counts its units, a WEIGHT item its grams): the daily rate of the stock tab.
  const soldQuantityByProduct = new Map<string, number>();
  // weight_grams is null for a UNIT sale item — this widget only ranks by revenue (cents), so a
  // UNIT product's "grams" here stays 0 rather than crashing; it just isn't reflected in this
  // particular weight tally (kept out of scope: this is a small informational widget, not the
  // rentabilidad/analytics ranking, which already ranks purely by revenue/cost cents).
  for (const item of items) { const total = productTotals.get(item.product_id) ?? { name: item.product_name_snapshot, grams: 0, cents: 0 }; total.grams += item.weight_grams ?? 0; total.cents += item.subtotal_cents - item.ticket_discount_cents; productTotals.set(item.product_id, total); soldQuantityByProduct.set(item.product_id, (soldQuantityByProduct.get(item.product_id) ?? 0) + (item.weight_grams ?? item.quantity_units ?? 0)); }
  const topProducts = [...productTotals.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);
  const todaySales = new Set((weekSalesResult.data ?? []).filter((sale) => (sale.completed_at ?? "") >= localDayStart(context.timezone)).map((sale) => sale.id));
  const todayDiscounts = items.filter((item) => todaySales.has(item.sale_id)).reduce((sum, item) => sum + item.discount_cents + item.ticket_discount_cents, 0);
  const restocks = (restocksResult.data ?? []).map((movement) => ({ ...movement, productName: restockProductNames.get(movement.product_id) ?? "Producto" }));
  const recentSales = recentSalesResult.data ?? [];
  const recentWaste = wasteResult.data ?? [];
  const change = periodMetrics.previousGrossCents ? ((periodMetrics.grossCents - periodMetrics.previousGrossCents) / periodMetrics.previousGrossCents) * 100 : null;
  const rangeParams = rangeQuery(range);
  const carryResult = carryPromise ? await carryPromise : null;
  const board = tab === "summary" && operationsResult && !operationsResult.error ? buildBranchBoard({
    rows: toInsightRows(operationsResult.data),
    configuredAlerts: urgent.map((row) => ({ productId: row.product_id, productName: row.product_name, unitType: row.unit_type, current: row.current, suggested: row.suggested, rank: row.priority.rank })),
    carry: isProductionBranch || !carryResult ? null : carryResult.error ? carryResult.error.message : buildCarryPlanReport(carryResult.data),
    isProductionBranch, range, now: new Date()
  }) : null;

  return <BranchDetailFrame modal={modal} status={branchResult.data.active ? "ACTIVA" : "INACTIVA"} subtitle={`${branchResult.data.code}${branchResult.data.address ? ` · ${branchResult.data.address}` : ""}`} title={branchResult.data.name}>
    {/* Celular (< lg): detalle vertical sin tablas con las MISMAS cifras. Escritorio: el panel de siempre (en el celular queda oculto). */}
    <MobileBranchDetail active={branchResult.data.active} board={board} boardUnavailable={operationsResult?.error?.message ?? null} branchId={id} branchName={branchResult.data.name} isProduction={isProductionBranch} metrics={{ grossCents: periodMetrics.grossCents, kilograms: periodMetrics.kilograms, units: periodMetrics.units, salesCount: periodMetrics.salesCount }} profit={profit ? { grossProfitCents: profit.grossProfitCents, grossMarginBps: profit.grossMarginBps, missingCostItems: profit.missingCostItems } : null} range={range} />
    <div className="max-lg:hidden"><main className="mx-auto max-w-7xl p-5 sm:p-10">{!modal ? <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/branches">← Volver a sucursales</Link> : null}<div className={modal ? "hidden" : "mt-4 flex flex-wrap items-start justify-between gap-3"}><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Sucursal</p><h1 className="mt-1 text-3xl font-black">{branchResult.data.name}</h1><p className="mt-1 text-stone-600">{branchResult.data.code}{branchResult.data.address ? ` · ${branchResult.data.address}` : ""}</p></div><StatusBadge tone={branchResult.data.active ? "success" : "neutral"}>{branchResult.data.active ? "ACTIVA" : "INACTIVA"}</StatusBadge></div>
    <BranchTabs active={tab} branchId={id} rangeParams={rangeParams} />
    {tab === "summary" ? <><SalesRangeFilter error={range.error} range={range} /><BranchSummary board={board} boardUnavailable={operationsResult?.error?.message ?? null} branchId={id} branchName={branchResult.data.name} change={change} comparisonLabel={comparisonLabel(range)} isProduction={isProductionBranch} metrics={periodMetrics} periodLabel={periodLabel(range)} profit={profit} range={{ from: range.from, to: range.to }} stockCounts={stockCounts} timeZone={context.timezone} />
      <section className="mt-7"><SectionHeader description="Nombre, código y dirección de esta sucursal." title="Editar datos" /><div className="mt-3 rounded-xl border bg-white p-4"><BranchForm branch={{ id, name: branchResult.data.name, code: branchResult.data.code, address: branchResult.data.address, active: branchResult.data.active }} /></div>
        <SectionHeader description="Desactivar conserva todo el historial; eliminar sólo es posible si la sucursal nunca operó." title="Estado de la sucursal" />
        <div className="mt-3"><BranchLifecyclePanel active={branchResult.data.active} branchId={id} /></div>
      </section></> : null}
    {tab === "stock" ? <><BranchStockPanel branchId={id} filter={stockFilter} page={stockPage} rows={stockPageResult.data.map((row) => { const priority = stockPriority(row.stock_status, row.current_stock_grams, row.minimum_stock_grams); return { productId: row.product_id, productName: row.product_name, sku: row.sku, unitType: row.unit_type, current: row.current_stock_grams, minimum: row.minimum_stock_grams, target: row.target_stock_grams, suggested: row.suggested_replenishment_grams, configured: configuredProducts.has(row.product_id), rank: priority.rank, label: priority.label, daily: (soldQuantityByProduct.get(row.product_id) ?? 0) / 7 }; })} search={stockSearch} totalRows={stockPageResult.data[0]?.total_count ?? 0} />
      <div className="mt-7 grid gap-7 lg:grid-cols-2"><section><SectionHeader title="Mermas recientes" action={<Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/stock">Ver movimientos →</Link>} /><div className="mt-3 divide-y rounded-xl border bg-white">{recentWaste.map((waste) => <div className="flex justify-between gap-3 px-4 py-3 text-sm" key={waste.id}><span>{new Date(waste.occurred_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{waste.waste_reason ?? "Merma"}</strong></div>)}{!recentWaste.length ? <p className="px-4 py-5 text-stone-500">Sin mermas recientes.</p> : null}</div></section><section><SectionHeader title="Reingresos recientes" /><div className="mt-3 divide-y rounded-xl border bg-white">{restocks.map((movement) => <div className="flex justify-between gap-3 px-4 py-3 text-sm" key={`${movement.product_id}-${movement.occurred_at}`}><span>{movement.productName} · {movement.type}</span><strong>+{formatWeight(Math.abs(movement.quantity_grams))}</strong></div>)}{!restocks.length ? <p className="px-4 py-5 text-stone-500">Sin reingresos recientes.</p> : null}</div></section></div></> : null}
    {tab === "sales" ? <div className="mt-6 grid gap-7 lg:grid-cols-2"><section><SectionHeader title="Ventas recientes" action={<Link className="text-sm font-bold text-rose-800 hover:underline" href={`/admin/sales?preset=today&branch=${id}`}>Ver ventas →</Link>} /><div className="mt-3 divide-y rounded-xl border bg-white">{recentSales.map((sale) => <div className="flex justify-between gap-4 px-4 py-3 text-sm" key={sale.id}><span>{new Date(sale.completed_at ?? sale.created_at).toLocaleString("es-AR", { timeZone: context.timezone })}</span><strong>{formatCurrency(BigInt(sale.total_cents))} · {formatWeight(sale.total_weight_grams)}</strong></div>)}{!recentSales.length ? <p className="px-4 py-5 text-stone-500">Sin ventas recientes.</p> : null}</div><SectionHeader title="Productos vendidos" description="Últimos 7 días" /><div className="mt-3 divide-y rounded-xl border bg-white">{topProducts.map((product) => <div className="flex justify-between gap-3 px-4 py-3" key={product.name}><strong>{product.name}</strong><span>{formatWeight(product.grams)} · {formatCurrency(BigInt(product.cents))}</span></div>)}</div></section><section><SectionHeader title="Métricas comerciales" /><div className="mt-3 grid gap-3 sm:grid-cols-2"><MetricCard label="Descuentos hoy" value={formatCurrency(BigInt(todayDiscounts))} /><MetricCard label="Facturación hoy" value={formatCurrency(BigInt(todayGrossCents))} /></div><SectionHeader title="Medios de pago" description="Mes actual" /><div className="mt-3 divide-y rounded-xl border bg-white">{dashboard.paymentsThisMonth.map((payment) => <div className="flex justify-between px-4 py-3" key={payment.method}><span>{paymentLabels[payment.method] ?? payment.method}</span><strong>{formatCurrency(BigInt(payment.amountCents))}</strong></div>)}</div></section></div> : null}
  </main></div></BranchDetailFrame>;
}

export default BranchPage;
