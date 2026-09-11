import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../lib/admin";
import { createClient } from "../../lib/supabase/server";

type Filter = "all" | "alerts" | "critical";
type Sort = "name" | "revenue" | "alerts";

interface BranchSummary {
  id: string;
  name: string;
  revenueCents: number;
  weightGrams: number;
  tickets: number;
  outOfStock: number;
  belowMinimum: number;
}

function value(params: Record<string, string | string[] | undefined>, key: string) {
  return typeof params[key] === "string" ? params[key] : "";
}

function todayStart(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const day = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  const midnightGuess = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  const rendered = Object.fromEntries(formatter.formatToParts(new Date(midnightGuess)).map((part) => [part.type, part.value]));
  const renderedAsUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour), Number(rendered.minute), Number(rendered.second));
  return new Date(midnightGuess + midnightGuess - renderedAsUtc).toISOString();
}

function isOutOfStock(status: string | null, current: number) {
  return status === "OUT_OF_STOCK" || status === "CRITICAL" || (status !== "DISCONTINUED" && current <= 0);
}

function isBelowMinimum(status: string | null, current: number, minimum: number) {
  return !isOutOfStock(status, current) && (status === "LOW_STOCK" || status === "LOW" || (current > 0 && current < minimum));
}

function Metric({ label, metricValue, detail }: { label: string; metricValue: string; detail?: string }) {
  return <article className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p><p className="mt-2 text-2xl font-black text-rose-800 sm:text-3xl">{metricValue}</p>{detail ? <p className="mt-1 text-sm text-stone-500">{detail}</p> : null}</article>;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const query = value(params, "q").trim();
  const filter: Filter = ["alerts", "critical"].includes(value(params, "filter")) ? value(params, "filter") as Filter : "all";
  const sort: Sort = ["revenue", "alerts"].includes(value(params, "sort")) ? value(params, "sort") as Sort : "name";
  const supabase = await createClient();

  const [branchesResult, salesResult, stockResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    supabase.from("sales").select("branch_id, total_cents, total_weight_grams").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", todayStart(context.timezone)),
    supabase.from("branch_stock_status").select("branch_id, branch_name, product_name, current_stock_grams, minimum_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId)
  ]);
  const error = [branchesResult.error, salesResult.error, stockResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el resumen: {error.message}</main>;

  const branches = (branchesResult.data ?? []).map<BranchSummary>((branch) => ({ id: branch.id, name: branch.name, revenueCents: 0, weightGrams: 0, tickets: 0, outOfStock: 0, belowMinimum: 0 }));
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  for (const sale of salesResult.data ?? []) {
    const branch = byId.get(sale.branch_id);
    if (!branch) continue;
    branch.revenueCents += sale.total_cents;
    branch.weightGrams += sale.total_weight_grams;
    branch.tickets += 1;
  }

  const alerts = (stockResult.data ?? []).flatMap((row) => {
    const branch = row.branch_id ? byId.get(row.branch_id) : undefined;
    if (!branch) return [];
    const current = row.current_stock_grams ?? 0;
    const minimum = row.minimum_stock_grams ?? 0;
    const out = isOutOfStock(row.stock_status, current);
    const low = isBelowMinimum(row.stock_status, current, minimum);
    if (out) branch.outOfStock += 1;
    else if (low) branch.belowMinimum += 1;
    return out || low ? [{ branchId: branch.id, branchName: branch.name, productName: row.product_name ?? "Producto", current, suggested: row.suggested_replenishment_grams ?? 0, out }] : [];
  }).sort((a, b) => Number(b.out) - Number(a.out) || b.suggested - a.suggested || a.branchName.localeCompare(b.branchName, "es"));

  const total = branches.reduce((result, branch) => ({ revenueCents: result.revenueCents + branch.revenueCents, weightGrams: result.weightGrams + branch.weightGrams, tickets: result.tickets + branch.tickets }), { revenueCents: 0, weightGrams: 0, tickets: 0 });
  const branchesWithProblems = branches.filter((branch) => branch.outOfStock + branch.belowMinimum > 0).length;
  const normalizedQuery = query.toLocaleLowerCase("es");
  const visibleBranches = branches.filter((branch) => branch.name.toLocaleLowerCase("es").includes(normalizedQuery)).filter((branch) => filter === "all" || (filter === "alerts" && branch.outOfStock + branch.belowMinimum > 0) || (filter === "critical" && branch.outOfStock > 0)).sort((a, b) => sort === "revenue" ? b.revenueCents - a.revenueCents || a.name.localeCompare(b.name, "es") : sort === "alerts" ? (b.outOfStock + b.belowMinimum) - (a.outOfStock + a.belowMinimum) || a.name.localeCompare(b.name, "es") : a.name.localeCompare(b.name, "es"));

  return (
    <main className="mx-auto max-w-7xl p-5 sm:p-10">
      <div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Resumen de hoy</p><h1 className="mt-1 text-3xl font-black">Sucursales</h1><p className="mt-2 text-stone-600">Vista operativa de las {branches.length} sucursales activas.</p></div>

      <section className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Ventas de hoy" metricValue={formatCurrency(BigInt(total.revenueCents))} />
        <Metric label="Kg vendidos hoy" metricValue={formatWeight(total.weightGrams)} />
        <Metric label="Tickets" metricValue={String(total.tickets)} />
        <Metric label="Ticket promedio" metricValue={formatCurrency(BigInt(total.tickets ? Math.round(total.revenueCents / total.tickets) : 0))} />
        <Metric detail="con stock agotado o bajo" label="Sucursales con problemas" metricValue={String(branchesWithProblems)} />
      </section>

      {alerts.length ? <section className="mt-7 rounded-2xl border border-amber-200 bg-amber-50 p-5"><div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wider text-amber-800">Requieren atención</p><h2 className="mt-1 text-xl font-black">Problemas prioritarios de stock</h2></div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/stock">Ver stock</Link></div><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{alerts.slice(0, 6).map((alert) => <article className="rounded-xl border border-amber-200 bg-white p-3" key={`${alert.branchId}-${alert.productName}`}><p className={`text-xs font-black uppercase ${alert.out ? "text-red-700" : "text-amber-700"}`}>{alert.out ? "Agotado" : "Debajo del mínimo"} · {alert.branchName}</p><p className="mt-1 font-bold">{alert.productName}</p><p className="text-sm text-stone-600">Actual: {formatWeight(alert.current)} · Reponer: {formatWeight(alert.suggested)}</p></article>)}</div></section> : null}

      <form className="mt-7 grid gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm md:grid-cols-[minmax(12rem,1fr)_12rem_13rem_auto]">
        <input aria-label="Buscar sucursal" className="rounded-lg border border-stone-300 px-3 py-2" defaultValue={query} name="q" placeholder="Buscar sucursal…" />
        <select aria-label="Filtrar sucursales" className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={filter} name="filter"><option value="all">Todas</option><option value="alerts">Con alertas</option><option value="critical">Stock crítico</option></select>
        <select aria-label="Ordenar sucursales" className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={sort} name="sort"><option value="name">Nombre</option><option value="revenue">Mayor facturación</option><option value="alerts">Más alertas</option></select>
        <button className="rounded-lg bg-rose-800 px-5 py-2 font-bold text-white hover:bg-rose-900">Aplicar</button>
      </form>

      <section className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visibleBranches.map((branch) => {
          const alertCount = branch.outOfStock + branch.belowMinimum;
          return <article className="flex min-h-64 flex-col rounded-2xl border border-stone-200 bg-white p-5 shadow-sm" key={branch.id}><div className="flex items-start justify-between gap-3"><h2 className="text-xl font-black">{branch.name}</h2>{alertCount ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">{alertCount} alertas</span> : <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800">Stock normal</span>}</div><p className="mt-4 text-2xl font-black text-rose-800">{formatCurrency(BigInt(branch.revenueCents))}</p><p className="text-xs font-bold uppercase tracking-wide text-stone-500">Ventas de hoy</p><dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div><dt className="text-stone-500">Kg vendidos</dt><dd className="font-black">{formatWeight(branch.weightGrams)}</dd></div><div><dt className="text-stone-500">Tickets</dt><dd className="font-black">{branch.tickets}</dd></div><div><dt className="text-stone-500">Ticket promedio</dt><dd className="font-black">{formatCurrency(BigInt(branch.tickets ? Math.round(branch.revenueCents / branch.tickets) : 0))}</dd></div><div><dt className="text-stone-500">Agotados / bajo mínimo</dt><dd className="font-black"><span className={branch.outOfStock ? "text-red-700" : ""}>{branch.outOfStock}</span> / <span className={branch.belowMinimum ? "text-amber-700" : ""}>{branch.belowMinimum}</span></dd></div></dl><Link className="mt-auto pt-5 font-bold text-rose-800 hover:underline" href={`/admin/branches/${branch.id}`}>Ver sucursal →</Link></article>;
        })}
      </section>
      {!visibleBranches.length ? <p className="mt-5 rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-500">No hay sucursales que coincidan con la búsqueda y el filtro.</p> : null}
    </main>
  );
}
