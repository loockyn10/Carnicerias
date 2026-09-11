import { formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../../lib/admin";
import { localDayStart, stockPriority } from "../../../lib/multibranch";
import { createClient } from "../../../lib/supabase/server";

export default async function ReplenishmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q.trim().toLocaleLowerCase("es") : "";
  const branchId = typeof params.branch === "string" ? params.branch : "";
  const onlyNeeded = params.only !== "all";
  const supabase = await createClient();
  let stockQuery = supabase.from("branch_stock_status").select("branch_id, branch_name, product_id, product_name, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId);
  if (branchId) stockQuery = stockQuery.eq("branch_id", branchId);
  const [branchesResult, stockResult, salesResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    stockQuery,
    supabase.from("stock_movements").select("branch_id, product_id, quantity_grams").eq("organization_id", context.organizationId).eq("type", "SALE").gte("occurred_at", localDayStart(context.timezone, 6))
  ]);
  const error = [branchesResult.error, stockResult.error, salesResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la reposición: {error.message}</main>;
  const soldByProduct = new Map<string, number>();
  for (const movement of salesResult.data ?? []) {
    const key = `${movement.branch_id}:${movement.product_id}`;
    soldByProduct.set(key, (soldByProduct.get(key) ?? 0) + Math.abs(movement.quantity_grams));
  }
  const rows = (stockResult.data ?? []).map((row) => {
    const current = row.current_stock_grams ?? 0;
    const minimum = row.minimum_stock_grams ?? 0;
    const priority = stockPriority(row.stock_status, current, minimum);
    const soldDaily = (soldByProduct.get(`${row.branch_id ?? ""}:${row.product_id ?? ""}`) ?? 0) / 7;
    return { ...row, current, minimum, target: row.target_stock_grams ?? 0, suggested: row.suggested_replenishment_grams ?? 0, priority, soldDaily };
  }).filter((row) => !search || (row.product_name ?? "").toLocaleLowerCase("es").includes(search)).filter((row) => !onlyNeeded || row.priority.rank < 2).sort((a, b) => a.priority.rank - b.priority.rank || b.suggested - a.suggested || (a.branch_name ?? "").localeCompare(b.branch_name ?? "", "es"));

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Multisucursal</p><h1 className="mt-1 text-3xl font-black">Qué hay que reponer</h1><p className="mt-2 text-stone-600">Consolidado de stock para organizar compras y reposición.</p>
    <form className="mt-6 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-[1fr_13rem_auto_auto]"><input className="rounded-lg border border-stone-300 px-3 py-2" defaultValue={typeof params.q === "string" ? params.q : ""} name="q" placeholder="Buscar producto…" /><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={branchId} name="branch"><option value="">Todas las sucursales</option>{(branchesResult.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={onlyNeeded ? "needed" : "all"} name="only"><option value="needed">Sólo requiere reposición</option><option value="all">Todos los productos</option></select><button className="rounded-lg bg-rose-800 px-5 py-2 font-bold text-white">Aplicar</button></form>
    <section className="mt-6 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-[970px] text-left text-sm"><thead className="border-b bg-stone-50 text-stone-500"><tr><th className="p-3">Sucursal</th><th className="p-3">Producto</th><th className="p-3">Actual</th><th className="p-3">Mínimo</th><th className="p-3">Objetivo</th><th className="p-3">Cobertura</th><th className="p-3">Reponer sugerido</th><th className="p-3">Prioridad</th></tr></thead><tbody>{rows.map((row) => <tr className="border-b border-stone-100" key={`${row.branch_id ?? ""}-${row.product_id ?? ""}`}><td className="p-3"><Link className="font-bold text-rose-800 hover:underline" href={`/admin/branches/${row.branch_id ?? ""}`}>{row.branch_name}</Link></td><td className="p-3 font-bold">{row.product_name}</td><td className="p-3">{formatWeight(row.current)}</td><td className="p-3">{formatWeight(row.minimum)}</td><td className="p-3">{formatWeight(row.target)}</td><td className="p-3">{row.soldDaily > 0 ? `≈ ${(row.current / row.soldDaily).toFixed(1)} días` : "Sin ventas recientes"}</td><td className="p-3 font-bold">{formatWeight(row.suggested)}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-black ${row.priority.className}`}>{row.priority.label}</span></td></tr>)}</tbody></table>{!rows.length ? <p className="p-8 text-center text-stone-500">No hay productos para los filtros elegidos.</p> : null}</section>
  </main>;
}
