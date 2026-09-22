import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../../lib/admin";
import {
  comparisonBps,
  formatBps,
  sortProductAnalytics,
  type AnalyticsSort,
  type AnalyticsUnit,
  type ProductAnalytics,
  type ProfitabilityAnalytics
} from "../../../lib/analytics";
import { createPerfLogger } from "../../../lib/perf";
import { createClient } from "../../../lib/supabase/server";
import { SectionTabs } from "../../../components/section-tabs";

const input = "min-w-0 rounded-lg border border-stone-300 bg-white px-3 py-2";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const presets = new Set(["today", "7d", "30d", "custom"]);
const sorts = new Set<AnalyticsSort>(["profit", "profitability", "revenue", "quantity", "unitProfit"]);
const VENTAS_TABS = [
  { label: "Historial", href: "/admin/sales" },
  { label: "Rendiciones", href: "/admin/settlements" },
  { label: "Rentabilidad", href: "/admin/analytics" }
];

function money(value: number | null, positive = false) {
  if (value === null) return "No disponible";
  return `${positive && value > 0 ? "+" : ""}${formatCurrency(BigInt(value))}`;
}

function quantity(value: number, unit: AnalyticsUnit) {
  return unit === "WEIGHT" ? formatWeight(value) : `${value.toLocaleString("es-AR")} u.`;
}

function comparison(value: number | null) {
  if (value === null) return "Sin comparación disponible";
  if (value === 0) return "Sin cambios vs período anterior";
  return `${value > 0 ? "↑" : "↓"} ${formatBps(Math.abs(value))} vs período anterior`;
}

function buildHref(values: Record<string, string>, changes: Record<string, string | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...values, ...changes })) if (value) params.set(key, value);
  return `/admin/analytics?${params.toString()}`;
}

function Ranking({ title, rows, render }: { title: string; rows: ProductAnalytics[]; render: (row: ProductAnalytics) => string }) {
  return <section className="min-w-0"><h3 className="text-xs font-black uppercase tracking-wide text-stone-500">{title}</h3><ol className="mt-3 space-y-2">{rows.slice(0, 3).map((row, index) => <li className="flex min-w-0 items-center justify-between gap-3 text-sm" key={row.productId}><span className="truncate"><strong className="mr-2 text-stone-400">{index + 1}.</strong>{row.productName}</span><strong className="shrink-0">{render(row)}</strong></li>)}{!rows.length ? <li className="text-sm text-stone-500">Sin datos disponibles.</li> : null}</ol></section>;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/analytics");
  const contextStartedAt = performance.now();
  await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const raw = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const preset = presets.has(raw("period")) ? raw("period") : "7d";
  const from = datePattern.test(raw("from")) ? raw("from") : "";
  const to = datePattern.test(raw("to")) ? raw("to") : "";
  const branch = uuidPattern.test(raw("branch")) ? raw("branch") : "";
  const category = uuidPattern.test(raw("category")) ? raw("category") : "";
  const product = uuidPattern.test(raw("product")) ? raw("product") : "";
  const sort = sorts.has(raw("sort") as AnalyticsSort) ? raw("sort") as AnalyticsSort : "profit";
  const values = { period: preset, from, to, branch, category, sort };
  const supabase = await createClient();
  const result = await perf.measure("analytics", supabase.rpc("get_profitability_analytics", {
    p_preset: preset,
    p_from: preset === "custom" ? from || null : null,
    p_to: preset === "custom" ? to || null : null,
    p_branch_id: branch || null,
    p_category_id: category || null,
    p_product_id: product || null
  }));
  perf.flush();
  const data = result.data as unknown as ProfitabilityAnalytics | null;
  if (result.error || !data) return <main className="mx-auto max-w-7xl p-5 sm:p-8"><p className="rounded-xl bg-red-50 p-4 text-red-800">No se pudo cargar la rentabilidad: {result.error?.message ?? "Respuesta vacía"}</p></main>;

  const rows = sortProductAnalytics(data.products, sort);
  const fullyCosted = data.products.filter((row) => row.grossProfitCents !== null);
  const topRevenue = [...data.products].sort((a, b) => b.revenueCents - a.revenueCents);
  const topProfit = [...fullyCosted].sort((a, b) => (b.grossProfitCents ?? 0) - (a.grossProfitCents ?? 0));
  const topProfitability = fullyCosted.filter((row) => row.profitabilityBps !== null).sort((a, b) => (b.profitabilityBps ?? 0) - (a.profitabilityBps ?? 0));
  const topWeight = data.products.filter((row) => row.unitType === "WEIGHT").sort((a, b) => b.quantity - a.quantity);
  const topUnit = data.products.filter((row) => row.unitType === "UNIT").sort((a, b) => b.quantity - a.quantity);
  const revenueChange = comparisonBps(data.summary.revenueCents, data.previousSummary.revenueCents);
  const profitChange = data.summary.coverageBps === 10_000 && data.previousSummary.coverageBps === 10_000
    ? comparisonBps(data.summary.grossProfitCents, data.previousSummary.grossProfitCents) : null;
  const periodLabel = `${data.period.from} → ${data.period.to}`;
  const sortLabel: Record<AnalyticsSort, string> = { profit: "Ganancia bruta", profitability: "Rentabilidad %", revenue: "Facturación", quantity: "Cantidad vendida", unitProfit: "Ganancia por kg/unidad" };

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Análisis comercial</p><h1 className="mt-1 text-3xl font-black">Rentabilidad</h1><p className="mt-2 text-stone-600">Ganancia bruta basada exclusivamente en el costo histórico registrado en cada venta.</p>
    <SectionTabs tabs={VENTAS_TABS} />

    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-6">
      <select className={input} defaultValue={preset} name="period"><option value="today">Hoy</option><option value="7d">7 días</option><option value="30d">30 días</option><option value="custom">Personalizado</option></select>
      <input aria-label="Desde" className={input} defaultValue={from} name="from" type="date" /><input aria-label="Hasta" className={input} defaultValue={to} name="to" type="date" />
      <select className={input} defaultValue={branch} name="branch"><option value="">Todas las sucursales</option>{data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={input} defaultValue={category} name="category"><option value="">Todas las categorías</option>{data.categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Aplicar</button>
      <input name="sort" type="hidden" value={sort} />
    </form>
    <p className="mt-3 text-sm text-stone-500">Período analizado: {periodLabel} · zona horaria {data.timezone}</p>

    {data.summary.coverageBps < 10_000 ? <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Parte de las ventas no tiene costo histórico y no se incluye en rentabilidad. Cobertura por facturación: <strong>{formatBps(data.summary.coverageBps)}</strong> ({data.summary.missingCostItems} ítems sin costo).</p> : null}

    <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-xl bg-white p-4 shadow-sm"><p className="text-sm text-stone-500">Ventas</p><strong className="mt-1 block text-2xl">{money(data.summary.revenueCents)}</strong><p className="mt-1 text-xs text-stone-500">{comparison(revenueChange)}</p></article>
      <article className="rounded-xl bg-white p-4 shadow-sm"><p className="text-sm text-stone-500">Costo de mercadería{data.summary.coverageBps < 10_000 ? " (con costo)" : ""}</p><strong className="mt-1 block text-2xl">{money(data.summary.costCents)}</strong><p className="mt-1 text-xs text-stone-500">Sólo ventas con costo histórico</p></article>
      <article className="rounded-xl bg-stone-950 p-4 text-white"><p className="text-sm text-stone-300">Ganancia bruta{data.summary.coverageBps < 10_000 ? " (con costo)" : ""}</p><strong className="mt-1 block text-2xl">{money(data.summary.grossProfitCents, true)}</strong><p className="mt-1 text-xs text-stone-300">{profitChange === null && data.summary.coverageBps < 10_000 ? "Comparación omitida por cobertura parcial" : comparison(profitChange)}</p></article>
      <article className="rounded-xl bg-white p-4 shadow-sm"><p className="text-sm text-stone-500">Rentabilidad sobre costo</p><strong className="mt-1 block text-2xl">{formatBps(data.summary.profitabilityBps)}</strong><p className="mt-1 text-xs text-stone-500">Ganancia bruta / costo histórico</p></article>
    </section>
    <div className="mt-3 flex flex-wrap gap-3 text-sm text-stone-600"><span className="rounded-full bg-white px-3 py-1 shadow-sm">Peso vendido: <strong>{formatWeight(data.summary.weightGrams)}</strong></span><span className="rounded-full bg-white px-3 py-1 shadow-sm">Unidades vendidas: <strong>{data.summary.unitCount.toLocaleString("es-AR")}</strong></span></div>

    <section className="mt-7 grid gap-5 rounded-xl bg-white p-5 shadow-sm md:grid-cols-2 xl:grid-cols-4">
      <section><h3 className="text-xs font-black uppercase tracking-wide text-stone-500">Más vendidos</h3><div className="mt-3 grid gap-4"><Ranking render={(row) => quantity(row.quantity, row.unitType)} rows={topWeight} title="Por peso" />{topUnit.length ? <Ranking render={(row) => quantity(row.quantity, row.unitType)} rows={topUnit} title="Por unidad" /> : null}</div></section>
      <Ranking render={(row) => money(row.revenueCents)} rows={topRevenue} title="Mayor facturación" />
      <Ranking render={(row) => money(row.grossProfitCents, true)} rows={topProfit} title="Mayor ganancia" />
      <Ranking render={(row) => formatBps(row.profitabilityBps)} rows={topProfitability} title="Mayor rentabilidad" />
    </section>

    <section className="mt-8"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-black">Rentabilidad por producto</h2><p className="text-sm text-stone-500">Orden: {sortLabel[sort]} descendente.</p></div><select aria-label="Ordenar productos" className={input} defaultValue={sort} onChange={undefined} form="analytics-sort" name="sort"><option value="profit">Ganancia bruta</option><option value="profitability">Rentabilidad %</option><option value="revenue">Facturación</option><option value="quantity">Cantidad vendida</option><option value="unitProfit">Ganancia por kg/unidad</option></select><form id="analytics-sort"><input name="period" type="hidden" value={preset} /><input name="from" type="hidden" value={from} /><input name="to" type="hidden" value={to} /><input name="branch" type="hidden" value={branch} /><input name="category" type="hidden" value={category} /><button className="rounded-lg border px-3 py-2 text-sm font-bold">Ordenar</button></form></div>
      <div className="mt-4 hidden overflow-hidden rounded-xl bg-white shadow-sm md:block"><table className="w-full text-left text-sm"><thead className="border-b bg-stone-50 text-stone-500"><tr><th className="p-3">Producto</th><th className="p-3">Cantidad</th><th className="p-3">Facturación</th><th className="p-3">Costo</th><th className="p-3">Ganancia bruta</th><th className="p-3">Ganancia/medida</th><th className="p-3">Rentabilidad</th></tr></thead><tbody>{rows.map((row) => <tr className="border-b border-stone-100" key={row.productId}><td className="p-3"><Link className="font-bold text-rose-800 hover:underline" href={buildHref(values, { product: row.productId })}>{row.productName}</Link><p className="text-xs text-stone-500">{row.categoryName}</p></td><td className="p-3">{quantity(row.quantity, row.unitType)}</td><td className="p-3 font-bold">{money(row.revenueCents)}</td><td className="p-3">{money(row.costCents)}</td><td className="p-3 font-black">{money(row.grossProfitCents, true)}</td><td className="p-3">{row.profitPerMeasureCents === null ? "No disponible" : `${money(row.profitPerMeasureCents, true)}/${row.unitType === "WEIGHT" ? "kg" : "unidad"}`}</td><td className="p-3">{formatBps(row.profitabilityBps)}</td></tr>)}</tbody></table></div>
      <div className="mt-4 grid gap-3 md:hidden">{rows.map((row) => <Link className="rounded-xl bg-white p-4 shadow-sm" href={buildHref(values, { product: row.productId })} key={row.productId}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><strong className="block truncate">{row.productName}</strong><span className="text-xs text-stone-500">{quantity(row.quantity, row.unitType)}</span></div><div className="text-right"><strong className="block text-rose-800">{money(row.grossProfitCents, true)}</strong><span className="text-xs text-stone-500">{formatBps(row.profitabilityBps)}</span></div></div><p className="mt-3 text-sm text-stone-600">Facturación {money(row.revenueCents)} · Costo {money(row.costCents)}</p></Link>)}{!rows.length ? <p className="rounded-xl bg-white p-8 text-center text-stone-500">No hay ventas en el período.</p> : null}</div>
    </section>

    {data.categories.length ? <section className="mt-8"><h2 className="text-xl font-black">Por categoría</h2><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.categories.map((row) => <article className="rounded-xl bg-white p-4 shadow-sm" key={row.categoryId}><strong>{row.categoryName}</strong><dl className="mt-3 grid grid-cols-3 gap-2 text-sm"><div><dt className="text-stone-500">Ventas</dt><dd className="font-bold">{money(row.revenueCents)}</dd></div><div><dt className="text-stone-500">Costo</dt><dd className="font-bold">{money(row.costCents)}</dd></div><div><dt className="text-stone-500">Ganancia</dt><dd className="font-bold">{money(row.grossProfitCents, true)}</dd></div></dl></article>)}</div></section> : null}

    {data.detail ? <section className="mt-8 rounded-2xl border border-rose-200 bg-white p-5 shadow-lg"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wide text-rose-800">Detalle de producto</p><h2 className="mt-1 text-2xl font-black">{data.detail.productName}</h2><p className="text-sm text-stone-500">{data.detail.categoryName} · {periodLabel}</p></div><Link aria-label="Cerrar detalle" className="rounded-full border px-3 py-1 font-black" href={buildHref(values, { product: null })}>×</Link></div>
      {data.detail.summary.missingCostItems ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Este producto contiene ventas sin costo histórico; costo y ganancia completa no están disponibles.</p> : null}
      <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6"><div><dt className="text-sm text-stone-500">Cantidad</dt><dd className="font-black">{quantity(data.detail.summary.quantity, data.detail.unitType)}</dd></div><div><dt className="text-sm text-stone-500">Facturación</dt><dd className="font-black">{money(data.detail.summary.revenueCents)}</dd></div><div><dt className="text-sm text-stone-500">Costo</dt><dd className="font-black">{money(data.detail.summary.costCents)}</dd></div><div><dt className="text-sm text-stone-500">Ganancia bruta</dt><dd className="font-black">{money(data.detail.summary.grossProfitCents, true)}</dd></div><div><dt className="text-sm text-stone-500">Ganancia/{data.detail.unitType === "WEIGHT" ? "kg" : "unidad"}</dt><dd className="font-black">{money(data.detail.summary.profitPerMeasureCents, true)}</dd></div><div><dt className="text-sm text-stone-500">Rentabilidad</dt><dd className="font-black">{formatBps(data.detail.summary.profitabilityBps)}</dd></div></dl>
      <div className="mt-7 grid gap-7 lg:grid-cols-2"><section><h3 className="font-black">Por sucursal</h3><div className="mt-2 divide-y">{data.detail.branches.map((row) => <div className="flex items-center justify-between gap-3 py-3" key={row.branchId}><div><strong>{row.branchName}</strong><p className="text-sm text-stone-500">{quantity(row.quantity, data.detail?.unitType ?? "WEIGHT")} · {money(row.revenueCents)}</p></div><div className="text-right"><strong>{money(row.grossProfitCents, true)}</strong><p className="text-xs text-stone-500">{formatBps(row.profitabilityBps)}</p></div></div>)}{!data.detail.branches.length ? <p className="py-4 text-sm text-stone-500">Sin ventas por sucursal.</p> : null}</div></section><section><h3 className="font-black">Evolución</h3><div className="mt-2 divide-y">{data.detail.evolution.map((row) => <div className="grid grid-cols-3 gap-2 py-3 text-sm" key={row.date}><strong>{row.date}</strong><span>{quantity(row.quantity, data.detail?.unitType ?? "WEIGHT")}</span><span className="text-right font-bold">{money(row.grossProfitCents, true)}</span></div>)}{!data.detail.evolution.length ? <p className="py-4 text-sm text-stone-500">Sin evolución para mostrar.</p> : null}</div></section></div>
    </section> : null}
  </main>;
}
