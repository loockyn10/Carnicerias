import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { MetricCard, StatusBadge } from "../../components/admin-ui";
import { requireAdminContext } from "../../lib/admin";
import { localDayStart, stockPriority } from "../../lib/multibranch";
import { createClient } from "../../lib/supabase/server";

type Filter = "all" | "alerts" | "critical";
type Sort = "name" | "revenue" | "alerts";

interface BranchSummary { id: string; name: string; revenue: number; previousRevenue: number; grams: number; tickets: number; out: number; low: number }

function value(params: Record<string, string | string[] | undefined>, key: string) { return typeof params[key] === "string" ? params[key] : ""; }

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const query = value(params, "q").trim().toLocaleLowerCase("es");
  const filter: Filter = ["alerts", "critical"].includes(value(params, "filter")) ? value(params, "filter") as Filter : "all";
  const sort: Sort = ["revenue", "alerts"].includes(value(params, "sort")) ? value(params, "sort") as Sort : "name";
  const todayStart = localDayStart(context.timezone);
  const supabase = await createClient();
  const [branchesResult, salesResult, stockResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    supabase.from("sales").select("branch_id, total_cents, total_weight_grams, completed_at").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 1)),
    supabase.from("branch_stock_status").select("branch_id, branch_name, product_name, current_stock_grams, minimum_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId)
  ]);
  const error = [branchesResult.error, salesResult.error, stockResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el resumen: {error.message}</main>;

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
  const visible = branches.filter((branch) => branch.name.toLocaleLowerCase("es").includes(query)).filter((branch) => filter === "all" || (filter === "alerts" && branch.out + branch.low > 0) || (filter === "critical" && branch.out > 0)).sort((a, b) => sort === "revenue" ? b.revenue - a.revenue || a.name.localeCompare(b.name, "es") : sort === "alerts" ? (b.out + b.low) - (a.out + a.low) || a.name.localeCompare(b.name, "es") : a.name.localeCompare(b.name, "es"));

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">{context.organizationName}</p><h1 className="mt-1 text-3xl font-black">Situación general</h1><p className="mt-2 text-stone-600">Resumen operativo de hoy.</p></div>
    <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="Ventas hoy" value={formatCurrency(BigInt(total.revenue))} /><MetricCard label="Kg vendidos" value={formatWeight(total.grams)} /><MetricCard label="Tickets" value={String(total.tickets)} /><MetricCard label="Ticket promedio" value={formatCurrency(BigInt(total.tickets ? Math.round(total.revenue / total.tickets) : 0))} /></section>
    <section className="mt-8"><div className="flex items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-rose-800">Prioridad</p><h2 className="mt-1 text-xl font-black">Requiere tu atención</h2></div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/attention">Ver todas las alertas →</Link></div><div className="mt-3 divide-y rounded-xl border border-stone-200 bg-white">{alerts.slice(0, 5).map((alert) => <Link className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-stone-50" href={`/admin/branches/${alert.branchId}`} key={`${alert.branchId}-${alert.productName}`}><div><span className="mr-2">{alert.priority.rank === 0 ? "🔴" : "🟠"}</span><strong>{alert.branchName}</strong> · {alert.productName} {alert.priority.rank === 0 ? "agotado" : "debajo del mínimo"}</div><span className="text-sm text-stone-500">Actual {formatWeight(alert.current)} · Reponer {formatWeight(alert.suggested)}</span></Link>)}{!alerts.length ? <p className="px-4 py-5 text-emerald-700">No hay alertas de stock.</p> : null}</div></section>
    <section className="mt-8"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-rose-800">Operación</p><h2 className="mt-1 text-xl font-black">Sucursales</h2></div><div className="flex gap-2 text-sm"><Link className="font-bold text-rose-800 hover:underline" href="/admin/branches/compare">Comparar</Link><Link className="font-bold text-rose-800 hover:underline" href="/admin/replenishment">Reposición</Link></div></div>
      <form className="mt-4 grid gap-3 rounded-xl border bg-white p-3 md:grid-cols-[1fr_12rem_13rem_auto]"><input className="rounded-lg border border-stone-300 px-3 py-2" defaultValue={value(params, "q")} name="q" placeholder="Buscar sucursal…" /><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={filter} name="filter"><option value="all">Todas</option><option value="alerts">Con alertas</option><option value="critical">Stock crítico</option></select><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={sort} name="sort"><option value="name">Nombre</option><option value="revenue">Mayor facturación</option><option value="alerts">Más alertas</option></select><button className="rounded-lg bg-rose-800 px-5 py-2 font-bold text-white">Aplicar</button></form>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{visible.map((branch) => { const alertsCount = branch.out + branch.low; const change = branch.previousRevenue ? ((branch.revenue - branch.previousRevenue) / branch.previousRevenue) * 100 : null; return <article className="rounded-xl border border-stone-200 bg-white p-4" key={branch.id}><div className="flex justify-between gap-3"><h3 className="text-lg font-black">Sucursal {branch.name}</h3>{alertsCount ? <StatusBadge tone={branch.out ? "critical" : "warning"}>{alertsCount} alertas</StatusBadge> : <StatusBadge tone="success">Sin alertas</StatusBadge>}</div><p className="mt-4 text-2xl font-black text-rose-800">{formatCurrency(BigInt(branch.revenue))}</p><p className={`text-sm font-bold ${change !== null && change < 0 ? "text-red-700" : "text-emerald-700"}`}>{change === null ? "Sin comparación previa" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs ayer`}</p><p className="mt-2 text-sm text-stone-600">{formatWeight(branch.grams)} · {branch.tickets} tickets</p><Link className="mt-4 inline-block font-bold text-rose-800 hover:underline" href={`/admin/branches/${branch.id}`}>Ver sucursal →</Link></article>; })}</div>{!visible.length ? <p className="mt-4 rounded-xl border border-dashed p-8 text-center text-stone-500">No hay sucursales para los filtros elegidos.</p> : null}</section>
  </main>;
}
