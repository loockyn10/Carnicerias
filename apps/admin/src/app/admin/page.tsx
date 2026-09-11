import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { MetricCard } from "../../components/admin-ui";
import { requireAdminContext } from "../../lib/admin";
import { localDayStart, stockPriority } from "../../lib/multibranch";
import { createClient } from "../../lib/supabase/server";
import { createPerfLogger } from "../../lib/perf";

interface BranchSummary { id: string; name: string; revenue: number; previousRevenue: number; grams: number; tickets: number; out: number; low: number }

export default async function DashboardPage() {
  const perf = createPerfLogger("/admin");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const todayStart = localDayStart(context.timezone);
  const supabase = await createClient();
  const [branchesResult, salesResult, stockResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("sales", supabase.from("sales").select("branch_id, total_cents, total_weight_grams, completed_at").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 1))),
    perf.measure("stock", supabase.from("branch_stock_status").select("branch_id, branch_name, product_name, current_stock_grams, minimum_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId))
  ]);
  const error = [branchesResult.error, salesResult.error, stockResult.error].find(Boolean);
  if (error) { perf.flush(); return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el resumen: {error.message}</main>; }

  const transformStartedAt = performance.now();
  const branches = (branchesResult.data ?? []).map<BranchSummary>((branch) => ({ id: branch.id, name: branch.name, revenue: 0, previousRevenue: 0, grams: 0, tickets: 0, out: 0, low: 0 }));
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  for (const sale of salesResult.data ?? []) { const branch = byId.get(sale.branch_id); if (!branch) continue; if ((sale.completed_at ?? "") >= todayStart) { branch.revenue += sale.total_cents; branch.grams += sale.total_weight_grams; branch.tickets += 1; } else branch.previousRevenue += sale.total_cents; }
  const alerts = (stockResult.data ?? []).flatMap((row) => {
    const branch = row.branch_id ? byId.get(row.branch_id) : undefined;
    if (!branch) return [];
    const current = row.current_stock_grams ?? 0; const minimum = row.minimum_stock_grams ?? 0;
    const priority = stockPriority(row.stock_status, current, minimum);
    if (priority.rank === 0) branch.out += 1; else if (priority.rank === 1) branch.low += 1;
    return priority.rank < 2 ? [{ branchId: branch.id, branchName: branch.name, productName: row.product_name ?? "Producto", current, suggested: row.suggested_replenishment_grams ?? 0, priority }] : [];
  }).sort((a, b) => a.priority.rank - b.priority.rank || a.current - b.current);
  const total = branches.reduce((sum, branch) => ({ revenue: sum.revenue + branch.revenue, grams: sum.grams + branch.grams, tickets: sum.tickets + branch.tickets }), { revenue: 0, grams: 0, tickets: 0 });
  perf.mark("transform", transformStartedAt); perf.flush();

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">{context.organizationName}</p><h1 className="mt-1 text-3xl font-black">Situación general</h1><p className="mt-2 text-stone-600">Resumen operativo de hoy.</p></div>
    <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="Ventas hoy" value={formatCurrency(BigInt(total.revenue))} /><MetricCard label="Kg vendidos" value={formatWeight(total.grams)} /><MetricCard label="Tickets" value={String(total.tickets)} /><MetricCard label="Ticket promedio" value={formatCurrency(BigInt(total.tickets ? Math.round(total.revenue / total.tickets) : 0))} /></section>
    <section className="mt-8"><div className="flex items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-rose-800">Prioridad</p><h2 className="mt-1 text-xl font-black">Requiere tu atención</h2></div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/attention">Ver todas las alertas →</Link></div><div className="mt-3 divide-y rounded-xl border border-stone-200 bg-white">{alerts.slice(0, 5).map((alert) => <Link className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-stone-50" href={`/admin/branches/${alert.branchId}`} key={`${alert.branchId}-${alert.productName}`}><div><span className="mr-2">{alert.priority.rank === 0 ? "🔴" : "🟠"}</span><strong>{alert.branchName}</strong> · {alert.productName} {alert.priority.rank === 0 ? "agotado" : "debajo del mínimo"}</div><span className="text-sm text-stone-500">Actual {formatWeight(alert.current)} · Reponer {formatWeight(alert.suggested)}</span></Link>)}{!alerts.length ? <p className="px-4 py-5 text-emerald-700">No hay alertas de stock.</p> : null}</div></section>
    <section className="mt-8 rounded-xl bg-white p-5 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-black">Sucursales</h2><p className="mt-1 text-sm text-stone-600">Consultá el estado y las alertas de cada local.</p></div><Link className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold text-stone-700 hover:border-rose-300 hover:text-rose-800" href="/admin/branches">Ver sucursales →</Link></div></section>
  </main>;
}
