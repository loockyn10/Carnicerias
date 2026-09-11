import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { StatusBadge } from "../../../components/admin-ui";
import { requireAdminContext } from "../../../lib/admin";
import { localDayStart, stockPriority } from "../../../lib/multibranch";
import { createPerfLogger } from "../../../lib/perf";
import { createClient } from "../../../lib/supabase/server";

type Filter = "all" | "alerts" | "critical";
type Sort = "name" | "revenue" | "alerts";

export default async function BranchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/branches");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const q = value("q").trim().toLocaleLowerCase("es");
  const filter: Filter = ["alerts", "critical"].includes(value("filter")) ? value("filter") as Filter : "all";
  const sort: Sort = ["revenue", "alerts"].includes(value("sort")) ? value("sort") as Sort : "name";
  const today = localDayStart(context.timezone);
  const supabase = await createClient();
  const [branchesResult, salesResult, stockResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("sales", supabase.from("sales").select("branch_id, total_cents, total_weight_grams, completed_at").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, 1))),
    perf.measure("stock", supabase.from("branch_stock_status").select("branch_id, current_stock_grams, minimum_stock_grams, stock_status").eq("organization_id", context.organizationId))
  ]);
  const error = [branchesResult.error, salesResult.error, stockResult.error].find(Boolean);
  if (error) { perf.flush(); return <main className="mx-auto max-w-6xl p-8 text-red-800">No se pudieron cargar las sucursales: {error.message}</main>; }

  const transformStartedAt = performance.now();
  const rows = new Map((branchesResult.data ?? []).map((branch) => [branch.id, { id: branch.id, name: branch.name, revenue: 0, previous: 0, grams: 0, tickets: 0, out: 0, low: 0 }]));
  for (const sale of salesResult.data ?? []) {
    const row = rows.get(sale.branch_id);
    if (!row) continue;
    if ((sale.completed_at ?? "") >= today) { row.revenue += sale.total_cents; row.grams += sale.total_weight_grams; row.tickets += 1; } else row.previous += sale.total_cents;
  }
  for (const stock of stockResult.data ?? []) {
    const row = rows.get(stock.branch_id ?? "");
    if (!row) continue;
    const priority = stockPriority(stock.stock_status, stock.current_stock_grams ?? 0, stock.minimum_stock_grams ?? 0);
    if (priority.rank === 0) row.out += 1; else if (priority.rank === 1) row.low += 1;
  }
  const visible = [...rows.values()]
    .filter((row) => row.name.toLocaleLowerCase("es").includes(q))
    .filter((row) => filter === "all" || (filter === "alerts" && row.out + row.low > 0) || (filter === "critical" && row.out > 0))
    .sort((a, b) => sort === "revenue" ? b.revenue - a.revenue || a.name.localeCompare(b.name, "es") : sort === "alerts" ? (b.out + b.low) - (a.out + a.low) || a.name.localeCompare(b.name, "es") : a.name.localeCompare(b.name, "es"));
  perf.mark("transform", transformStartedAt);
  perf.flush();

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex justify-end"><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/branches/compare">Comparar sucursales →</Link></div>
    <form className="mt-3 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_12rem_13rem_auto]">
      <input className="rounded-lg border border-stone-300 px-3 py-2" defaultValue={value("q")} name="q" placeholder="Buscar sucursal…" />
      <select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={filter} name="filter"><option value="all">Todas</option><option value="alerts">Con alertas</option><option value="critical">Stock crítico</option></select>
      <select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={sort} name="sort"><option value="name">Nombre</option><option value="revenue">Mayor facturación</option><option value="alerts">Más alertas</option></select>
      <button className="rounded-lg border px-4 py-2 font-bold">Aplicar</button>
    </form>
    <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {visible.map((row) => {
        const alerts = row.out + row.low;
        const change = row.previous ? ((row.revenue - row.previous) / row.previous) * 100 : null;
        return <Link aria-label={`Ver sucursal ${row.name}`} className="block cursor-pointer rounded-xl border border-transparent bg-white p-4 shadow-sm transition-shadow hover:border-rose-200 hover:bg-rose-50/30 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800" href={`/admin/branches/${row.id}`} key={row.id}>
          <div className="flex items-start justify-between gap-3"><h2 className="text-lg font-black">{row.name}</h2>{alerts ? <StatusBadge tone={row.out ? "critical" : "warning"}>{alerts} alertas</StatusBadge> : <StatusBadge tone="success">Sin alertas</StatusBadge>}</div>
          <p className="mt-4 text-2xl font-black text-rose-800">{formatCurrency(BigInt(row.revenue))}</p>
          <p className={`text-sm font-bold ${change !== null && change < 0 ? "text-red-700" : "text-emerald-700"}`}>{change === null ? "Sin comparación previa" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs ayer`}</p>
          <p className="mt-2 text-sm text-stone-600">{formatWeight(row.grams)} · {row.tickets} tickets</p>
        </Link>;
      })}
    </section>
    {!visible.length ? <p className="mt-5 rounded-xl bg-white p-8 text-center text-stone-500">No hay sucursales para los filtros elegidos.</p> : null}
  </main>;
}
