import { formatCurrency, formatStockQuantity, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { MetricCard } from "../../components/admin-ui";
import { HomeOperatingResults } from "../../components/home-operating-results";
import { MobileHome } from "../../components/mobile/mobile-home";
import { requireAdminContext } from "../../lib/admin";
import { periodLabel, resolveSalesRange } from "../../lib/date-range";
import { toOperatingResult } from "../../lib/operating-costs";
import { localDayStart, stockPriority } from "../../lib/multibranch";
import { createClient } from "../../lib/supabase/server";
import { createPerfLogger } from "../../lib/perf";

interface BranchSummary { id: string; name: string; revenue: number; previousRevenue: number; grams: number; tickets: number; out: number; low: number }

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const todayStart = localDayStart(context.timezone);
  const params = await searchParams;
  // Período del «Resultado operativo»: sólo presets (Hoy / Ayer / 7 días / 30 días), en días calendario de la organización.
  const range = resolveSalesRange({ preset: typeof params.preset === "string" ? params.preset : "" }, context.timezone);
  const supabase = await createClient();
  // Alert COUNTS come from a per-branch SQL summary and only the handful of alerts actually shown
  // are fetched (a Central with thousands of products must never be pulled whole to count alerts).
  const [branchesResult, salesResult, summaryResult, alertsResult, operatingResult, organizationResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("sales", supabase.from("sales").select("branch_id, total_cents, total_weight_grams, completed_at").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 1))),
    perf.measure("stockSummary", supabase.rpc("get_branch_stock_summary")),
    perf.measure("stockAlerts", supabase.rpc("get_branch_stock_status", { p_status: "ALERTS", p_limit: 5 })),
    // Resultado operativo de todas las sucursales activas (D-082): la misma RPC que el Resumen de cada sucursal. Complemento: si falla (sin permiso de analítica o sin la migración), el Inicio sigue sin esa sección.
    perf.measure("operating", supabase.rpc("get_branch_operating_result", { p_from: range.from, p_to: range.to })),
    perf.measure("productionBranch", supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).maybeSingle())
  ]);
  const error = [branchesResult.error, salesResult.error, summaryResult.error, alertsResult.error].find(Boolean);
  if (error) { perf.flush(); return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el resumen: {error.message}</main>; }

  const transformStartedAt = performance.now();
  const branches = (branchesResult.data ?? []).map<BranchSummary>((branch) => ({ id: branch.id, name: branch.name, revenue: 0, previousRevenue: 0, grams: 0, tickets: 0, out: 0, low: 0 }));
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  for (const sale of salesResult.data ?? []) { const branch = byId.get(sale.branch_id); if (!branch) continue; if ((sale.completed_at ?? "") >= todayStart) { branch.revenue += sale.total_cents; branch.grams += sale.total_weight_grams; branch.tickets += 1; } else branch.previousRevenue += sale.total_cents; }
  for (const row of summaryResult.data ?? []) {
    const branch = byId.get(row.branch_id);
    if (branch) { branch.out = row.out_of_stock_count; branch.low = row.low_stock_count; }
  }
  const alerts = (alertsResult.data ?? []).flatMap((row) => {
    const branch = byId.get(row.branch_id);
    if (!branch) return [];
    const priority = stockPriority(row.stock_status, row.current_stock_grams, row.minimum_stock_grams);
    return [{ branchId: branch.id, branchName: branch.name, productName: row.product_name, unitType: row.unit_type, current: row.current_stock_grams, suggested: row.suggested_replenishment_grams, priority }];
  });
  const total = branches.reduce((sum, branch) => ({ revenue: sum.revenue + branch.revenue, grams: sum.grams + branch.grams, tickets: sum.tickets + branch.tickets }), { revenue: 0, grams: 0, tickets: 0 });
  const operating = operatingResult.error ? null : operatingResult.data.map(toOperatingResult);
  perf.mark("transform", transformStartedAt); perf.flush();

  // Celular (< lg): sólo las 4 tareas. Escritorio: el panel de siempre (en el celular queda oculto, no se reemplaza).
  return <><MobileHome organizationName={context.organizationName} /><div className="max-lg:hidden"><main className="mx-auto max-w-7xl p-5 sm:p-10">
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="Ventas hoy" value={formatCurrency(BigInt(total.revenue))} /><MetricCard label="Kg vendidos" value={formatWeight(total.grams)} /><MetricCard label="Tickets" value={String(total.tickets)} /><MetricCard label="Ticket promedio" value={formatCurrency(BigInt(total.tickets ? Math.round(total.revenue / total.tickets) : 0))} /></section>
    {operating ? <HomeOperatingResults periodName={periodLabel(range)} productionBranchId={organizationResult.data?.production_branch_id ?? null} range={range} results={operating} /> : null}
    <section className="mt-8"><div className="flex items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-rose-800">Prioridad</p><h2 className="mt-1 text-xl font-black">Requiere tu atención</h2></div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/attention">Ver todas las alertas →</Link></div><div className="mt-3 divide-y rounded-xl border border-stone-200 bg-white">{alerts.slice(0, 5).map((alert) => <Link className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-stone-50" href={`/admin/branches/${alert.branchId}`} key={`${alert.branchId}-${alert.productName}`}><div><span className="mr-2">{alert.priority.rank === 0 ? "🔴" : "🟠"}</span><strong>{alert.branchName}</strong> · {alert.productName} {alert.priority.rank === 0 ? "agotado" : "debajo del mínimo"}</div><dl className="flex shrink-0 gap-4 text-right text-sm"><div><dt className="text-[11px] font-bold uppercase tracking-wide text-stone-500">Actual</dt><dd className="font-bold text-red-700">{formatStockQuantity(alert.current, alert.unitType)}</dd></div><div><dt className="text-[11px] font-bold uppercase tracking-wide text-teal-700">Reponer</dt><dd className="font-bold text-teal-700">{formatStockQuantity(alert.suggested, alert.unitType)}</dd></div></dl></Link>)}{!alerts.length ? <p className="px-4 py-5 text-emerald-700">No hay alertas de stock.</p> : null}</div></section>
  </main></div></>;
}
