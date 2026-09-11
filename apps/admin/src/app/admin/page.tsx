import { formatCurrency, formatWeight } from "@carnicerias/business-logic";

import { requireAdminContext } from "../../lib/admin";
import { createClient } from "../../lib/supabase/server";

interface PeriodMetric { grossCents: number; previousGrossCents: number; salesCount: number; averageTicketCents: number; kilograms: number }
interface ProductMetric { productId: string; name: string; kilograms: number; grossCents: number }
interface DashboardData {
  periods: { today: PeriodMetric; week: PeriodMetric; month: PeriodMetric };
  paymentsThisMonth: { method: string; amountCents: number; salesCount: number }[];
  topProductsByRevenue: ProductMetric[];
  topProductsByKg: ProductMetric[];
  leastSoldProducts: ProductMetric[];
  stockAlerts: { branchName: string; productName: string; status: string; currentStockGrams: number; suggestedReplenishmentGrams: number }[];
}

function Ranking({ title, items }: { title: string; items: ProductMetric[] }) {
  return <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><h2 className="text-xl font-black">{title}</h2><div className="mt-4 space-y-3">{items.map((item, index) => <div className="flex items-center justify-between gap-4 border-b border-stone-100 pb-3" key={item.productId}><div><span className="mr-2 text-stone-400">#{index + 1}</span><strong>{item.name}</strong><p className="text-sm text-stone-500">{formatWeight(Math.round(item.kilograms * 1000))}</p></div><strong className="text-rose-800">{formatCurrency(BigInt(item.grossCents))}</strong></div>)}{!items.length ? <p className="text-stone-500">Sin ventas en el período.</p> : null}</div></section>;
}

const paymentLabels: Record<string, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", DEBIT: "Débito", CREDIT: "Crédito", OTHER: "Otro" };

function change(metric: PeriodMetric) {
  if (!metric.previousGrossCents) return metric.grossCents ? "+100%" : "0%";
  const value = ((metric.grossCents - metric.previousGrossCents) / metric.previousGrossCents) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const branchId = typeof params.branch === "string" && params.branch ? params.branch : null;
  const supabase = await createClient();
  const [{ data: dashboardRaw, error }, { data: branches }] = await Promise.all([
    supabase.rpc("get_admin_dashboard", { p_branch_id: branchId }),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")
  ]);
  const dashboard = dashboardRaw as unknown as DashboardData | null;

  if (error || !dashboard) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar el dashboard: {error?.message}</main>;
  const cards: [string, PeriodMetric][] = [["Hoy", dashboard.periods.today], ["Semana", dashboard.periods.week], ["Mes", dashboard.periods.month]];

  return (
    <main className="mx-auto max-w-7xl p-5 sm:p-10">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Resumen operativo</p><h1 className="mt-1 text-3xl font-black">Dashboard</h1><p className="mt-2 text-stone-600">{branches?.length ?? 0} sucursales activas · métricas calculadas en PostgreSQL.</p></div><form><select className="rounded-lg border border-stone-300 bg-white px-4 py-2" defaultValue={branchId ?? ""} name="branch"><option value="">Todas las sucursales</option>{(branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><button className="ml-2 rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Aplicar</button></form></div>
      <section className="mt-7 grid gap-4 md:grid-cols-3">
        {cards.map(([label, metric]) => <article className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm" key={label}>
          <p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p>
          <p className="mt-2 text-3xl font-black text-rose-800">{formatCurrency(BigInt(metric.grossCents))}</p>
          <p className={`mt-1 text-sm font-bold ${change(metric).startsWith("-") ? "text-red-700" : "text-emerald-700"}`}>{change(metric)} contra período anterior</p>
          <dl className="mt-4 grid grid-cols-4 gap-2 text-sm"><div><dt className="text-stone-500">Ventas</dt><dd className="font-black">{metric.salesCount}</dd></div><div><dt className="text-stone-500">Ticket</dt><dd className="font-black">{formatCurrency(BigInt(metric.averageTicketCents))}</dd></div><div><dt className="text-stone-500">Kilos</dt><dd className="font-black">{metric.kilograms}</dd></div><div><dt className="text-stone-500">kg/ticket</dt><dd className="font-black">{metric.salesCount ? (metric.kilograms / metric.salesCount).toFixed(2) : "0"}</dd></div></dl>
        </article>)}
      </section>
      <div className="mt-7 grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <Ranking title="Más vendidos por facturación" items={dashboard.topProductsByRevenue} />
        <Ranking title="Más vendidos por kg" items={dashboard.topProductsByKg} />
        <Ranking title="Menos vendidos" items={dashboard.leastSoldProducts} />
        <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Medios de pago · mes</h2><div className="mt-4 space-y-3">{dashboard.paymentsThisMonth.map((item) => <div className="flex justify-between border-b border-stone-100 pb-3" key={item.method}><span>{paymentLabels[item.method] ?? item.method} <small className="text-stone-500">({item.salesCount})</small></span><strong>{formatCurrency(BigInt(item.amountCents))}</strong></div>)}{!dashboard.paymentsThisMonth.length ? <p className="text-stone-500">Sin cobros en el período.</p> : null}</div></section>
      </div>
      <section className="mt-7 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Alertas de stock</h2><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{dashboard.stockAlerts.map((alert) => <article className={`rounded-xl border p-4 ${alert.status === "CRITICAL" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`} key={`${alert.branchName}-${alert.productName}`}><p className="text-xs font-bold uppercase text-stone-500">{alert.branchName} · {alert.status === "CRITICAL" ? "Crítico" : "Bajo"}</p><h3 className="mt-1 font-black">{alert.productName}</h3><p className="mt-2">Actual: <strong>{formatWeight(alert.currentStockGrams)}</strong></p><p className="text-sm text-stone-600">Reponer: {formatWeight(alert.suggestedReplenishmentGrams)}</p></article>)}{!dashboard.stockAlerts.length ? <p className="text-emerald-700">No hay alertas.</p> : null}</div></section>
    </main>
  );
}
