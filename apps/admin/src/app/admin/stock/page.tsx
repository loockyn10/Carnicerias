import { formatStockQuantity } from "@carnicerias/business-logic";
import Link from "next/link";

import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { createPerfLogger } from "../../../lib/perf";
import { stockPriority } from "../../../lib/multibranch";
import { PurchaseForm, StockAdjustmentForm, StockPolicyForm, WasteForm } from "../../../components/stock-operation-forms";
import { SectionTabs } from "../../../components/section-tabs";

const STOCK_TABS = [
  { label: "Operaciones", href: "/admin/stock" },
  { label: "Por sucursal", href: "/admin/branch-stock" },
  { label: "Reposición", href: "/admin/replenishment" }
];

const PAGE_SIZE = 50;
const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";
const reasonLabels: Record<string, string> = { DISCARD: "Descarte", EXPIRY: "Vencimiento", TRIMMING: "Recorte", DETERIORATION: "Deterioro", INVENTORY_DIFFERENCE: "Diferencia de inventario", OTHER: "Otro" };
const operationLabels: Record<string, string> = { PURCHASE: "Compra", WASTE: "Merma", ADJUSTMENT: "Ajuste" };
const STATUS_OPTIONS = [["", "Todos"], ["ALERTS", "Con alertas"], ["OUT_OF_STOCK", "Sin stock"], ["LOW_STOCK", "Stock bajo"], ["AVAILABLE", "Disponibles"]] as const;

export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/stock"); const contextStartedAt = performance.now(); const context = await requireAdminContext(); perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const branchFilter = value("branch");
  const search = value("q").trim();
  const status = STATUS_OPTIONS.some(([key]) => key === value("status")) ? value("status") : "";
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);
  const supabase = await createClient();
  // The stock table is filtered and paged in SQL (a Central with thousands of products must never be
  // fetched whole — PostgREST would silently truncate it at max_rows).
  const [stockResult, branchesResult, operationsResult, profilesResult] = await Promise.all([
    perf.measure("stock", supabase.rpc("get_branch_stock_status", {
      p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE,
      ...(branchFilter ? { p_branch_id: branchFilter } : {}), ...(search ? { p_search: search } : {}), ...(status ? { p_status: status } : {})
    })),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("operations", supabase.from("stock_operations").select("id, branch_id, operation_type, supplier, waste_reason, note, occurred_at, actor_profile_id").eq("organization_id", context.organizationId).order("occurred_at", { ascending: false }).limit(50)),
    perf.measure("profiles", supabase.from("profiles").select("id, display_name"))
  ]);
  const operationIds = (operationsResult.data ?? []).map((operation) => operation.id);
  const itemsResult = operationIds.length ? await perf.measure("operationItems", supabase.from("stock_operation_items").select("operation_id, product_id, quantity_grams, system_quantity_before_grams, physical_quantity_grams").in("operation_id", operationIds).order("created_at")) : { data: [], error: null };
  // Names + unit of only the products that appear in the visible history.
  const historyProductIds = [...new Set((itemsResult.data ?? []).map((item) => item.product_id))];
  const historyProductsResult = historyProductIds.length ? await supabase.from("products").select("id, name, unit_type").in("id", historyProductIds) : { data: [], error: null };
  const transformStartedAt = performance.now(); const error = [stockResult.error, branchesResult.error, operationsResult.error, itemsResult.error, historyProductsResult.error, profilesResult.error].find(Boolean);
  const branches = branchesResult.data ?? [];
  const stockRows = stockResult.data ?? [];
  const totalRows = stockRows[0]?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const productInfo = new Map((historyProductsResult.data ?? []).map((item) => [item.id, item]));
  const branchNames = new Map(branches.map((item) => [item.id, item.name]));
  const profileNames = new Map((profilesResult.data ?? []).map((item) => [item.id, item.display_name]));
  perf.mark("transform", transformStartedAt); perf.flush();

  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (branchFilter) query.set("branch", branchFilter);
    if (search) query.set("q", search);
    if (status) query.set("status", status);
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `/admin/stock?${text}` : "/admin/stock";
  };

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Inventario</p><h1 className="mt-1 text-3xl font-black">Operaciones de stock</h1><p className="mt-2 text-stone-600">El actual se deriva del ledger. Las compras, mermas y ajustes agregan movimientos auditados. Los productos por peso se miden en kg; los productos por unidad, en unidades enteras.</p>
    <SectionTabs tabs={STOCK_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <form className="mt-7 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm md:grid-cols-[1fr_12rem_12rem_auto]">
      <input className={input} defaultValue={search} name="q" placeholder="Buscar producto o SKU…" />
      <select className={input} defaultValue={branchFilter} name="branch"><option value="">Todas las sucursales</option>{branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className={input} defaultValue={status} name="status">{STATUS_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <button className="rounded-lg border px-4 py-2 font-bold">Aplicar</button>
    </form>
    <p className="mt-3 text-sm text-stone-500">Sólo se muestran los productos habilitados en cada sucursal · {totalRows} resultado{totalRows === 1 ? "" : "s"}</p>

    <section className="mt-3 overflow-hidden rounded-2xl border bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-stone-50"><tr><th className="p-3">Sucursal</th><th className="p-3">Producto</th><th className="p-3">Actual</th><th className="p-3">Mínimo</th><th className="p-3">Objetivo</th><th className="p-3">Sugerido</th><th className="p-3">Estado</th></tr></thead><tbody>{stockRows.map((row) => {
      const priority = stockPriority(row.stock_status, row.current_stock_grams, row.minimum_stock_grams);
      return <tr className="border-t" key={`${row.branch_id}-${row.product_id}`}><td className="p-3">{row.branch_name}</td><td className="p-3 font-bold">{row.product_name}{row.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{row.sku}</span> : null}</td><td className="p-3">{formatStockQuantity(row.current_stock_grams, row.unit_type)}</td><td className="p-3">{formatStockQuantity(row.minimum_stock_grams, row.unit_type)}</td><td className="p-3">{formatStockQuantity(row.target_stock_grams, row.unit_type)}</td><td className="p-3">{formatStockQuantity(row.suggested_replenishment_grams, row.unit_type)}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-black ${priority.className}`}>{priority.label}</span></td></tr>;
    })}</tbody></table></div>{!stockRows.length && !error ? <p className="p-8 text-center text-stone-500">No hay productos para estos filtros.</p> : null}</section>
    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page - 1)}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page + 1)}>Siguiente →</Link> : <span />}
    </nav> : null}

    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Mínimo y objetivo</h2><p className="mt-1 text-sm text-stone-600">En kg para productos por peso, en unidades para productos por unidad.</p><StockPolicyForm branches={branches} /></section>
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Compra / recepción</h2><p className="mt-1 text-sm text-stone-600">Elegí la sucursal y cargá uno o varios productos.</p><PurchaseForm branches={branches} /></section>
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Merma</h2><WasteForm branches={branches} /></section>
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Inventario físico / ajuste</h2><p className="mt-1 text-sm text-stone-600">Ingresá el conteo físico; PostgreSQL calcula la diferencia contra el sistema.</p><StockAdjustmentForm branches={branches} /></section>
    </div>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Historial de operaciones</h2><div className="mt-4 space-y-3">{(operationsResult.data ?? []).map((operation) => { const operationItems = (itemsResult.data ?? []).filter((item) => item.operation_id === operation.id); return <article className="rounded-xl border p-4" key={operation.id}><div className="flex flex-wrap justify-between gap-3"><div><strong>{operationLabels[operation.operation_type]}</strong> · {branchNames.get(operation.branch_id)}<p className="text-sm text-stone-500">{new Date(operation.occurred_at).toLocaleString("es-AR", { timeZone: context.timezone })} · {profileNames.get(operation.actor_profile_id) ?? operation.actor_profile_id.slice(0, 8)}</p></div><span>{operation.supplier ?? (operation.waste_reason ? reasonLabels[operation.waste_reason] : operation.note)}</span></div><ul className="mt-3 grid gap-2 sm:grid-cols-2">{operationItems.map((item) => { const product = productInfo.get(item.product_id); const unit = product?.unit_type ?? "WEIGHT"; return <li className="rounded-lg bg-stone-50 p-2 text-sm" key={`${item.operation_id}-${item.product_id}`}>{product?.name}: <strong>{item.quantity_grams > 0 ? "+" : ""}{formatStockQuantity(item.quantity_grams, unit)}</strong>{item.physical_quantity_grams !== null ? ` · físico ${formatStockQuantity(item.physical_quantity_grams, unit)}` : ""}</li>; })}</ul></article>; })}{!operationsResult.data?.length ? <p className="text-stone-500">Sin operaciones manuales todavía.</p> : null}</div></section>
  </main>;
}
