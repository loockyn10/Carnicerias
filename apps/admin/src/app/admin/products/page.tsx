import { formatCurrency } from "@carnicerias/business-logic";
import Link from "next/link";

import { BulkPriceEditor, type BulkPriceRow } from "../../../components/bulk-price-editor";
import { ProductCreateModal } from "../../../components/product-create-modal";
import { ProductManageModal } from "../../../components/product-manage-modal";
import { PricingSettingsModal } from "../../../components/pricing-settings-modal";
import { SectionTabs } from "../../../components/section-tabs";
import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { fetchAllRows } from "../../../lib/fetch-all";
import { createPerfLogger } from "../../../lib/perf";
import { promotionLabel, type PromotionLabelRow } from "../../../lib/promotion-label";
import { saveCategoryAction } from "../actions";

const PRODUCTOS_TABS = [
  { label: "Productos", href: "/admin/products" },
  { label: "Precios", href: "/admin/products?tab=pricing" },
  { label: "Promociones", href: "/admin/promotions" }
];

interface Discount extends PromotionLabelRow { id: string; product_id: string; branch_id: string | null; active: boolean; valid_from: string; valid_until: string | null }

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/products");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const category = value("category");
  const status = ["active", "inactive", "all"].includes(value("status")) ? value("status") : "active";
  const pricingTabOpen = value("tab") === "pricing";
  const activeTab = pricingTabOpen ? "/admin/products?tab=pricing" : "/admin/products";
  const supabase = await createClient();
  const PAGE_SIZE = 50;
  const page = Math.max(1, Number.parseInt(value("page") || "1", 10) || 1);
  const branchFilter = value("branch");
  // The catalog is filtered and PAGED in SQL (a Central with thousands of products must never be
  // fetched whole: PostgREST silently truncates at max_rows). Everything else (prices, costs,
  // promotions, categories, locks) is then fetched only for the ids of the current page.
  const [categoriesResult, branchesResult, pageResult, cashResult] = await Promise.all([
    perf.measure("categories", supabase.from("categories").select("id, name, slug, color_hex, sort_order, active").eq("organization_id", context.organizationId).order("sort_order")),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("productsPage", supabase.rpc("list_products_page", {
      p_status: status, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE,
      ...(value("q").trim() ? { p_search: value("q").trim() } : {}), ...(category ? { p_category_id: category } : {}), ...(branchFilter ? { p_branch_id: branchFilter } : {})
    })),
    perf.measure("cashDiscount", supabase.from("organization_cash_discounts").select("cash_discount_bps, valid_from").eq("organization_id", context.organizationId).is("valid_to", null).order("valid_from", { ascending: false }).limit(1).maybeSingle())
  ]);
  const pageRows = pageResult.data ?? [];
  const totalProducts = pageRows[0]?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalProducts / PAGE_SIZE));
  const pageIds = pageRows.map((row) => row.product_id);
  const queryIds = pageIds.length ? pageIds : ["00000000-0000-0000-0000-000000000000"];
  const nowIso = new Date().toISOString();
  const [categoryAssignmentsResult, unitTypeHistoryResult, pricesResult, discountsResult, costsResult, suppliersResult, primarySuppliersResult, packSizesResult] = await Promise.all([
    perf.measure("categoryAssignments", supabase.from("product_category_assignments").select("product_id, category_id").eq("organization_id", context.organizationId).in("product_id", queryIds)),
    perf.measure("unitTypeLocks", supabase.rpc("get_products_unit_type_locks", { p_product_ids: queryIds })),
    perf.measure("prices", supabase.from("product_prices").select("id, product_id, branch_id, price_cents, valid_from, valid_to").eq("organization_id", context.organizationId).in("product_id", queryIds).or(`valid_to.is.null,valid_to.gt.${nowIso}`).order("valid_from", { ascending: false })),
    perf.measure("discounts", supabase.from("product_weight_discounts").select("id, product_id, branch_id, promotion_mode, minimum_grams, discount_type, discount_value, pack_quantity_grams, pack_quantity_units, pack_price_cents, active, valid_from, valid_until").eq("organization_id", context.organizationId).eq("active", true).in("product_id", queryIds).order("valid_from", { ascending: false })),
    perf.measure("costs", supabase.from("product_costs").select("product_id, cost_cents, valid_from, valid_to").eq("organization_id", context.organizationId).in("product_id", queryIds).is("valid_to", null)),
    // Proveedores para el selector (todas las filas: PostgREST trunca en silencio a 1000) y el proveedor principal de los productos de esta página.
    perf.measure("suppliers", fetchAllRows((from, to) => supabase.from("suppliers").select("id, name, code, active").eq("organization_id", context.organizationId).order("name", { ascending: true }).order("id", { ascending: true }).range(from, to))),
    perf.measure("primarySuppliers", supabase.from("product_suppliers").select("product_id, supplier_id").eq("organization_id", context.organizationId).eq("is_primary", true).in("product_id", queryIds)),
    // Unidades por pack de los productos de esta página (null = sin pack).
    perf.measure("packSizes", supabase.from("products").select("id, pack_size_units").eq("organization_id", context.organizationId).in("id", queryIds))
  ]);
  perf.flush();

  const error = [categoriesResult.error, branchesResult.error, pageResult.error, categoryAssignmentsResult.error, unitTypeHistoryResult.error, pricesResult.error, discountsResult.error, costsResult.error, suppliersResult.error, primarySuppliersResult.error, packSizesResult.error, cashResult.error].find(Boolean);
  const categories = categoriesResult.data ?? [];
  const branches = branchesResult.data ?? [];
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const categoryIdsByProduct = new Map<string, string[]>();
  for (const assignment of categoryAssignmentsResult.data ?? []) {
    const current = categoryIdsByProduct.get(assignment.product_id) ?? [];
    current.push(assignment.category_id);
    categoryIdsByProduct.set(assignment.product_id, current);
  }
  const productsWithUnitTypeHistory = new Set(unitTypeHistoryResult.data ?? []);
  const now = Date.now();
  const cashDiscountBps = cashResult.data?.cash_discount_bps ?? 1000;
  const costByProduct = new Map((costsResult.data ?? []).map((row) => [row.product_id, row.cost_cents]));
  const suppliers = suppliersResult.data;
  const supplierNameById = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const packSizeByProduct = new Map((packSizesResult.data ?? []).map((row) => [row.id, row.pack_size_units]));
  const primarySupplierByProduct = new Map((primarySuppliersResult.data ?? []).map((row) => [row.product_id, row.supplier_id]));
  const anyPriceByProduct = new Map<string, NonNullable<typeof pricesResult.data>[number]>();
  const globalPriceByProduct = new Map<string, NonNullable<typeof pricesResult.data>[number]>();
  for (const price of pricesResult.data ?? []) {
    if (new Date(price.valid_from).getTime() > now || price.valid_to && new Date(price.valid_to).getTime() <= now) continue;
    if (!anyPriceByProduct.has(price.product_id)) anyPriceByProduct.set(price.product_id, price);
    if (!price.branch_id && !globalPriceByProduct.has(price.product_id)) globalPriceByProduct.set(price.product_id, price);
  }
  const activePromotionByProduct = new Map<string, Discount>();
  for (const discount of (discountsResult.data ?? []) as unknown as Discount[]) {
    if (!discount.active || new Date(discount.valid_from).getTime() > now || discount.valid_until && new Date(discount.valid_until).getTime() <= now) continue;
    if (!activePromotionByProduct.has(discount.product_id)) activePromotionByProduct.set(discount.product_id, discount);
  }
  const categoryNames = new Map(categories.map((item) => [item.id, item.name]));
  const products = pageRows.map((row) => ({
    id: row.product_id, category_id: row.category_id, name: row.product_name, slug: row.slug, sku: row.sku,
    unit_type: row.unit_type, active: row.active, inventory_role: row.inventory_role, barcodes: row.barcodes, branch_ids: row.branch_ids
  }));
  const bulkPriceRows: BulkPriceRow[] = products
    .filter((product) => product.active && (product.inventory_role === "SELLABLE" || product.inventory_role === "BOTH"))
    .map((product) => ({
      id: product.id, name: product.name, categoryName: categoryNames.get(product.category_id ?? "") ?? "Sin categoría",
      // Un precio 0 es "sin precio definido": se muestra como "sin precio" en el editor masivo, no como $0.
      unitType: product.unit_type, currentPriceCents: (globalPriceByProduct.get(product.id)?.price_cents ?? 0) > 0 ? globalPriceByProduct.get(product.id)?.price_cents ?? null : null
    }));
  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (pricingTabOpen) query.set("tab", "pricing");
    if (value("q").trim()) query.set("q", value("q").trim());
    if (category) query.set("category", category);
    if (status !== "active") query.set("status", status);
    if (branchFilter) query.set("branch", branchFilter);
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `/admin/products?${text}` : "/admin/products";
  };

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div><ProductCreateModal branches={branches} categories={categories.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))} suppliers={suppliers} /></div>
    <SectionTabs active={activeTab} tabs={PRODUCTOS_TABS} />
    {pricingTabOpen ? <section className="mt-6 rounded-xl bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Configuración de precios</h2><p className="mt-1 text-sm text-stone-600">Recargo por tarjeta, aplicado en el POS sobre el precio de lista. Efectivo y transferencia no tienen ajuste.</p><div className="mt-4"><PricingSettingsModal cashDiscountBps={cashDiscountBps} /></div></section> : null}
    {pricingTabOpen ? <section className="mt-6 rounded-xl bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Precios de venta</h2><p className="mt-1 text-sm text-stone-600">Carga masiva del precio de lista (global, todas las sucursales). Sólo se guardan las filas que cambiaste.</p><BulkPriceEditor rows={bulkPriceRows} /></section> : null}
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_12rem_12rem_10rem_auto]">{pricingTabOpen ? <input name="tab" type="hidden" value="pricing" /> : null}<input className={input} defaultValue={value("q")} name="q" placeholder="Buscar producto, SKU o código de barras…" /><select className={input} defaultValue={category} name="category"><option value="">Todas las categorías</option>{categories.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select className={input} defaultValue={status} name="status"><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select><select className={input} defaultValue={branchFilter} name="branch"><option value="">Todas las sucursales</option>{branches.map((item) => <option key={item.id} value={item.id}>Se vende en {item.name}</option>)}</select><button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button></form>
    <p className="mt-3 text-sm text-stone-500">{totalProducts} producto{totalProducts === 1 ? "" : "s"}</p>
    <section className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="px-4 py-3">Producto</th><th className="px-4 py-3">Categoría</th><th className="px-4 py-3">Precio vigente</th><th className="px-4 py-3">Se vende en</th><th className="w-16 px-2 py-3 text-center">Estado</th><th className="px-4 py-3 text-right">Acciones</th></tr></thead><tbody>{products.map((product) => {
      const price = globalPriceByProduct.get(product.id) ?? anyPriceByProduct.get(product.id);
      const promotion = activePromotionByProduct.get(product.id);
      const label = promotion ? promotionLabel(promotion) : null;
      const unitSuffix = product.unit_type === "WEIGHT" ? "/kg" : "/unidad";
      const cost = costByProduct.get(product.id) ?? null;
      // Precio 0 = "sin precio definido" (importado de SimplyGest): se ve en el POS de Central, que lo pide al vender.
      const priceMissing = price !== undefined && price.price_cents <= 0;
      const pricedNow = price !== undefined && price.price_cents > 0 ? price : null;
      const supplierId = primarySupplierByProduct.get(product.id) ?? null;
      return <tr className="border-b border-stone-100 bg-white last:border-0 even:bg-[#f8f8f8] hover:bg-[#f0f0f0]" key={product.id}><td className="px-4 py-3"><strong>{product.name}</strong>{supplierId ? <p className="text-xs text-stone-500">Proveedor: {supplierNameById.get(supplierId) ?? "—"}</p> : null}</td><td className="px-4 py-3 text-stone-600">{categoryNames.get(product.category_id ?? "") ?? "Sin categoría"}</td><td className="px-4 py-3"><strong>{pricedNow ? `${formatCurrency(BigInt(pricedNow.price_cents))} ${unitSuffix}` : priceMissing ? "SIN PRECIO ($0)" : "SIN PRECIO"}</strong><p className="text-xs text-stone-500">{priceMissing ? "La caja de Central lo pide al venderlo" : cost != null ? `${formatCurrency(BigInt(cost))} costo estimado` : pricedNow ? "Costo no disponible" : "No disponible en POS"}</p></td><td className="px-4 py-3 text-xs text-stone-600">{product.branch_ids.length === 0 ? <span className="font-bold text-amber-700">Ninguna sucursal</span> : product.branch_ids.length === branches.length ? "Todas" : product.branch_ids.map((id) => branchNames.get(id) ?? "—").join(", ")}</td><td className="px-2 py-3 text-center"><span aria-label={product.active ? "Activo" : "Inactivo"} className={`inline-flex size-7 items-center justify-center rounded-full text-base font-black leading-none text-white ${product.active ? "bg-emerald-600" : "bg-red-600"}`} role="img" title={product.active ? "Activo" : "Inactivo"}>{product.active ? "✓" : "×"}</span></td><td className="px-4 py-3 text-right"><ProductManageModal branches={branches} categories={categories.filter((item) => item.active || item.id === product.category_id).map((item) => ({ id: item.id, name: item.name }))} costCents={cost} price={pricedNow ? { cents: pricedNow.price_cents } : null} suppliers={suppliers} product={{ id: product.id, categoryId: product.category_id, categoryIds: categoryIdsByProduct.get(product.id) ?? [], name: product.name, slug: product.slug, sku: product.sku, unitType: product.unit_type, active: product.active, inventoryRole: product.inventory_role, hasUnitTypeHistory: productsWithUnitTypeHistory.has(product.id), barcodes: product.barcodes, branchIds: product.branch_ids, primarySupplierId: supplierId, packSizeUnits: packSizeByProduct.get(product.id) ?? null }} promotion={promotion && label ? { id: promotion.id, label } : null} /></td></tr>;
    })}</tbody></table></div>{!products.length ? <p className="p-8 text-center text-stone-500">No hay productos para estos filtros.</p> : null}</section>
    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page - 1)}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={pageHref(page + 1)}>Siguiente →</Link> : <span />}
    </nav> : null}
    <details className="mt-5 rounded-xl bg-white p-5 shadow-sm"><summary className="cursor-pointer font-bold">Gestionar categorías</summary><form action={saveCategoryAction} className="mt-4 flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm font-medium">Nombre<input className={input} name="name" placeholder="Nueva categoría" required /></label><label className="grid gap-1 text-sm font-medium">Color<input aria-label="Color de la categoría" className="h-10 w-14 cursor-pointer rounded-lg border border-stone-300 bg-white p-1" defaultValue="#78716C" name="color_hex" type="color" /></label><input name="slug" type="hidden" value="" /><input name="sort_order" type="hidden" value="0" /><input name="active" type="hidden" value="on" /><button className="rounded-lg border px-4 py-2 text-sm font-bold">Agregar</button></form><div className="mt-5 grid gap-3 md:grid-cols-2">{categories.map((item) => <form action={saveCategoryAction} className="grid grid-cols-[1fr_auto_auto] items-end gap-3 rounded-xl border border-stone-200 p-3" key={item.id}><input name="category_id" type="hidden" value={item.id} /><input name="slug" type="hidden" value={item.slug} /><input name="sort_order" type="hidden" value={item.sort_order} /><label className="grid gap-1 text-sm font-medium">Nombre<input className={input} defaultValue={item.name} name="name" required /></label><label className="grid gap-1 text-sm font-medium">Color<input aria-label={`Color de ${item.name}`} className="h-10 w-14 cursor-pointer rounded-lg border border-stone-300 bg-white p-1" defaultValue={item.color_hex ?? "#78716C"} name="color_hex" type="color" /></label><div className="grid gap-1"><label className="flex items-center gap-2 text-xs"><input defaultChecked={item.active} name="active" type="checkbox" /> Activa</label><button className="rounded-lg border px-3 py-2 text-sm font-bold">Guardar</button></div></form>)}</div></details>
  </main>;
}
