import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../../../lib/admin";
import { localDayStart, stockPriority } from "../../../../lib/multibranch";
import { createClient } from "../../../../lib/supabase/server";

type Period = "today" | "7d" | "30d";
type Sort = "name" | "revenue" | "weight" | "tickets" | "average" | "discounts" | "waste" | "out" | "low";

function sortLink(period: Period, sort: Sort) { return `/admin/branches/compare?period=${period}&sort=${sort}`; }

export default async function CompareBranchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const period: Period = ["7d", "30d"].includes(typeof params.period === "string" ? params.period : "") ? params.period as Period : "today";
  const sort: Sort = ["name", "revenue", "weight", "tickets", "average", "discounts", "waste", "out", "low"].includes(typeof params.sort === "string" ? params.sort : "") ? params.sort as Sort : "revenue";
  const days = period === "today" ? 0 : period === "7d" ? 6 : 29;
  const supabase = await createClient();
  const [branchesResult, salesResult, stockResult, wasteResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    supabase.from("sales").select("id, branch_id, total_cents, total_weight_grams").eq("organization_id", context.organizationId).eq("status", "COMPLETED").gte("completed_at", localDayStart(context.timezone, days)),
    supabase.from("branch_stock_status").select("branch_id, current_stock_grams, minimum_stock_grams, stock_status").eq("organization_id", context.organizationId),
    supabase.from("stock_movements").select("branch_id, quantity_grams").eq("organization_id", context.organizationId).eq("type", "WASTE").gte("occurred_at", localDayStart(context.timezone, days))
  ]);
  const error = [branchesResult.error, salesResult.error, stockResult.error, wasteResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo comparar las sucursales: {error.message}</main>;
  const saleIds = (salesResult.data ?? []).map((sale) => sale.id);
  const itemsResult = saleIds.length ? await supabase.from("sale_items").select("sale_id, discount_cents").in("sale_id", saleIds) : { data: [], error: null };
  if (itemsResult.error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudieron cargar los descuentos: {itemsResult.error.message}</main>;
  const saleBranch = new Map((salesResult.data ?? []).map((sale) => [sale.id, sale.branch_id]));
  const rows = new Map((branchesResult.data ?? []).map((branch) => [branch.id, { id: branch.id, name: branch.name, revenue: 0, grams: 0, tickets: 0, discounts: 0, waste: 0, out: 0, low: 0 }]));
  for (const sale of salesResult.data ?? []) { const row = rows.get(sale.branch_id); if (row) { row.revenue += sale.total_cents; row.grams += sale.total_weight_grams; row.tickets += 1; } }
  for (const item of itemsResult.data as unknown as { sale_id: string; discount_cents: number }[]) { const row = rows.get(saleBranch.get(item.sale_id) ?? ""); if (row) row.discounts += item.discount_cents; }
  for (const movement of wasteResult.data ?? []) { const row = rows.get(movement.branch_id); if (row) row.waste += Math.abs(movement.quantity_grams); }
  for (const stock of stockResult.data ?? []) { const row = rows.get(stock.branch_id ?? ""); if (!row) continue; const priority = stockPriority(stock.stock_status, stock.current_stock_grams ?? 0, stock.minimum_stock_grams ?? 0); if (priority.rank === 0) row.out += 1; else if (priority.rank === 1) row.low += 1; }
  const compared = [...rows.values()].sort((a, b) => {
    const averageA = a.tickets ? Math.round(a.revenue / a.tickets) : 0; const averageB = b.tickets ? Math.round(b.revenue / b.tickets) : 0;
    const values: Record<Sort, [string | number, string | number]> = { name: [a.name, b.name], revenue: [a.revenue, b.revenue], weight: [a.grams, b.grams], tickets: [a.tickets, b.tickets], average: [averageA, averageB], discounts: [a.discounts, b.discounts], waste: [a.waste, b.waste], out: [a.out, b.out], low: [a.low, b.low] };
    const [left, right] = values[sort]; return sort === "name" ? String(left).localeCompare(String(right), "es") : Number(right) - Number(left) || a.name.localeCompare(b.name, "es");
  });
  const periodLabel = period === "today" ? "Hoy" : period === "7d" ? "Últimos 7 días" : "Últimos 30 días";
  const heading = (label: string, key: Sort) => <th className="p-3"><Link className="hover:text-rose-800 hover:underline" href={sortLink(period, key)}>{label}{sort === key ? " ↓" : ""}</Link></th>;

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Multisucursal</p><h1 className="mt-1 text-3xl font-black">Comparar sucursales</h1><p className="mt-2 text-stone-600">{periodLabel}: ventas, descuentos, mermas y estado de stock.</p>
    <form className="mt-6 flex flex-wrap gap-2 rounded-2xl border bg-white p-4 shadow-sm"><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={period} name="period"><option value="today">Hoy</option><option value="7d">7 días</option><option value="30d">30 días</option></select><input name="sort" type="hidden" value={sort} /><button className="rounded-lg bg-rose-800 px-5 py-2 font-bold text-white">Aplicar</button></form>
    <section className="mt-6 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-[1160px] text-left text-sm"><thead className="border-b bg-stone-50 text-stone-500"><tr>{heading("Sucursal", "name")}{heading("Facturación", "revenue")}{heading("Kg vendidos", "weight")}{heading("Tickets", "tickets")}{heading("Ticket promedio", "average")}{heading("Descuentos", "discounts")}{heading("Merma", "waste")}{heading("Agotados", "out")}{heading("Bajo mínimo", "low")}</tr></thead><tbody>{compared.map((row) => <tr className="border-b border-stone-100" key={row.id}><td className="p-3"><Link className="font-bold text-rose-800 hover:underline" href={`/admin/branches/${row.id}`}>{row.name}</Link></td><td className="p-3 font-bold">{formatCurrency(BigInt(row.revenue))}</td><td className="p-3">{formatWeight(row.grams)}</td><td className="p-3">{row.tickets}</td><td className="p-3">{formatCurrency(BigInt(row.tickets ? Math.round(row.revenue / row.tickets) : 0))}</td><td className="p-3">{formatCurrency(BigInt(row.discounts))}</td><td className="p-3">{formatWeight(row.waste)}</td><td className={`p-3 font-black ${row.out ? "text-red-700" : ""}`}>{row.out}</td><td className={`p-3 font-black ${row.low ? "text-amber-700" : ""}`}>{row.low}</td></tr>)}</tbody></table>{!compared.length ? <p className="p-8 text-center text-stone-500">No hay sucursales activas.</p> : null}</section>
  </main>;
}
