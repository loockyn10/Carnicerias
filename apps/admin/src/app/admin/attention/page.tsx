import { formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../../lib/admin";
import { stockPriority } from "../../../lib/multibranch";
import { createClient } from "../../../lib/supabase/server";

type Filter = "all" | "critical" | "stock" | "waste" | "restock";

export default async function AttentionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const filter: Filter = ["critical", "stock", "waste", "restock"].includes(typeof params.filter === "string" ? params.filter : "") ? params.filter as Filter : "all";
  const branchId = typeof params.branch === "string" ? params.branch : "";
  const supabase = await createClient();
  let movementQuery = supabase.from("stock_movements").select("branch_id, product_id, type, quantity_grams, occurred_at").eq("organization_id", context.organizationId).in("type", ["WASTE", "PURCHASE", "RETURN", "ADJUSTMENT_POSITIVE", "TRANSFER_IN"]).order("occurred_at", { ascending: false }).limit(100);
  if (branchId) movementQuery = movementQuery.eq("branch_id", branchId);
  let stockQuery = supabase.from("branch_stock_status").select("branch_id, branch_name, product_id, product_name, current_stock_grams, minimum_stock_grams, target_stock_grams, suggested_replenishment_grams, stock_status").eq("organization_id", context.organizationId);
  if (branchId) stockQuery = stockQuery.eq("branch_id", branchId);
  const [branchesResult, stockResult, movementsResult] = await Promise.all([
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"), stockQuery, movementQuery
  ]);
  const error = [branchesResult.error, stockResult.error, movementsResult.error].find(Boolean);
  if (error) return <main className="mx-auto max-w-7xl p-8 text-red-800">No se pudo cargar la atención global: {error.message}</main>;

  const stockRows = (stockResult.data ?? []).map((row) => {
    const current = row.current_stock_grams ?? 0;
    const minimum = row.minimum_stock_grams ?? 0;
    return { ...row, current, minimum, target: row.target_stock_grams ?? 0, suggested: row.suggested_replenishment_grams ?? 0, priority: stockPriority(row.stock_status, current, minimum) };
  });
  const products = new Map(stockRows.map((row) => [`${row.branch_id ?? ""}:${row.product_id ?? ""}`, row]));
  const events = [
    ...stockRows.filter((row) => row.priority.rank < 2).map((row) => ({ kind: "stock" as const, rank: row.priority.rank, branchId: row.branch_id ?? "", branchName: row.branch_name ?? "Sucursal", productName: row.product_name ?? "Producto", detail: row.priority.label === "CRÍTICO" ? "Producto agotado" : "Debajo del mínimo", current: row.current, minimum: row.minimum, target: row.target, suggested: row.suggested, occurredAt: "" })),
    ...(movementsResult.data ?? []).map((movement) => {
      const product = products.get(`${movement.branch_id}:${movement.product_id}`);
      const waste = movement.type === "WASTE";
      return { kind: waste ? "waste" as const : "restock" as const, rank: waste ? 2 : 3, branchId: movement.branch_id, branchName: (branchesResult.data ?? []).find((branch) => branch.id === movement.branch_id)?.name ?? "Sucursal", productName: product?.product_name ?? "Producto", detail: waste ? "Merma registrada" : "Reingreso reciente", current: product?.current ?? 0, minimum: product?.minimum ?? 0, target: product?.target ?? 0, suggested: product?.suggested ?? 0, occurredAt: movement.occurred_at };
    })
  ].filter((event) => filter === "all" || (filter === "critical" && event.rank === 0) || (filter === "stock" && event.kind === "stock") || event.kind === filter).sort((a, b) => a.rank - b.rank || b.occurredAt.localeCompare(a.occurredAt)).slice(0, 100);

  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Multisucursal</p><h1 className="mt-1 text-3xl font-black">Centro de atención</h1><p className="mt-2 text-stone-600">Problemas y movimientos relevantes de todas las sucursales, ordenados por prioridad.</p>
    <form className="mt-6 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-[1fr_13rem_auto]"><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={filter} name="filter"><option value="all">Todas</option><option value="critical">Críticas</option><option value="stock">Stock</option><option value="waste">Mermas</option><option value="restock">Reingresos</option></select><select className="rounded-lg border border-stone-300 bg-white px-3 py-2" defaultValue={branchId} name="branch"><option value="">Todas las sucursales</option>{(branchesResult.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><button className="rounded-lg bg-rose-800 px-5 py-2 font-bold text-white">Aplicar</button></form>
    <section className="mt-6 space-y-3">{events.map((event, index) => <article className={`rounded-2xl border p-4 shadow-sm ${event.rank === 0 ? "border-red-200 bg-red-50" : event.rank === 1 ? "border-amber-200 bg-amber-50" : "border-stone-200 bg-white"}`} key={`${event.kind}-${event.branchId}-${event.productName}-${event.occurredAt}-${String(index)}`}><div className="flex flex-wrap items-start justify-between gap-4"><div><p className={`text-xs font-black uppercase tracking-wide ${event.rank === 0 ? "text-red-800" : event.rank === 1 ? "text-amber-800" : "text-stone-500"}`}>{event.rank === 0 ? "CRÍTICO" : event.rank === 1 ? "ALTO" : event.kind === "waste" ? "MEDIO" : "INFO"} · {event.branchName}</p><h2 className="mt-1 text-lg font-black">{event.productName}</h2><p className="text-sm text-stone-600">{event.detail}{event.occurredAt ? ` · ${new Date(event.occurredAt).toLocaleString("es-AR", { timeZone: context.timezone })}` : ""}</p></div><Link className="font-bold text-rose-800 hover:underline" href={`/admin/branches/${event.branchId}`}>Ver sucursal →</Link></div>{event.kind === "stock" ? <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div><dt className="text-stone-500">Actual</dt><dd className="font-bold">{formatWeight(event.current)}</dd></div><div><dt className="text-stone-500">Mínimo</dt><dd className="font-bold">{formatWeight(event.minimum)}</dd></div><div><dt className="text-stone-500">Objetivo</dt><dd className="font-bold">{formatWeight(event.target)}</dd></div><div><dt className="text-stone-500">Reponer</dt><dd className="font-bold">{formatWeight(event.suggested)}</dd></div></dl> : null}</article>)}{!events.length ? <p className="rounded-2xl border bg-white p-8 text-center text-emerald-700">No hay eventos para los filtros elegidos.</p> : null}</section>
  </main>;
}
