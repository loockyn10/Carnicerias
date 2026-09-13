import { formatCurrency } from "@carnicerias/business-logic";

import { ProductCreateModal } from "../../../components/product-create-modal";
import { ProductManageModal } from "../../../components/product-manage-modal";
import { StatusBadge } from "../../../components/admin-ui";
import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { saveCategoryAction } from "../actions";

interface Discount { id: string; product_id: string; branch_id: string | null; minimum_grams: number; discount_type: "PERCENTAGE" | "FIXED_PRICE_PER_KG"; discount_value: number; active: boolean; valid_from: string; valid_until: string | null }
interface CommercialClient { from: (table: string) => { select: (columns: string) => { eq: (column: string, value: string) => { order: (column: string, options?: { ascending?: boolean }) => Promise<{ data: Discount[] | null; error: { message: string } | null }> } } } }

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const q = value("q").toLocaleLowerCase("es");
  const category = value("category");
  const status = value("status") || "active";
  const supabase = await createClient();
  const commercial = supabase as unknown as CommercialClient;
  const [categoriesResult, productsResult, pricesResult, branchesResult, discountsResult] = await Promise.all([
    supabase.from("categories").select("id, name, slug, sort_order, active").eq("organization_id", context.organizationId).order("sort_order"),
    supabase.from("products").select("id, category_id, name, slug, sku, unit_type, active").eq("organization_id", context.organizationId).order("name"),
    supabase.from("product_prices").select("id, product_id, branch_id, price_cents, valid_from, valid_to").eq("organization_id", context.organizationId).order("valid_from", { ascending: false }).limit(200),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    commercial.from("product_weight_discounts").select("id, product_id, branch_id, minimum_grams, discount_type, discount_value, active, valid_from, valid_until").eq("organization_id", context.organizationId).order("valid_from", { ascending: false })
  ]);

  const error = [categoriesResult.error, productsResult.error, pricesResult.error, branchesResult.error, discountsResult.error].find(Boolean);
  const categories = categoriesResult.data ?? [];
  const allProducts = productsResult.data ?? [];
  const branches = branchesResult.data ?? [];
  const now = Date.now();
  const anyPriceByProduct = new Map<string, NonNullable<typeof pricesResult.data>[number]>();
  const globalPriceByProduct = new Map<string, NonNullable<typeof pricesResult.data>[number]>();
  for (const price of pricesResult.data ?? []) {
    if (new Date(price.valid_from).getTime() > now || price.valid_to && new Date(price.valid_to).getTime() <= now) continue;
    if (!anyPriceByProduct.has(price.product_id)) anyPriceByProduct.set(price.product_id, price);
    if (!price.branch_id && !globalPriceByProduct.has(price.product_id)) globalPriceByProduct.set(price.product_id, price);
  }
  const activePromotionByProduct = new Map<string, Discount>();
  for (const discount of discountsResult.data ?? []) {
    if (!discount.active || new Date(discount.valid_from).getTime() > now || discount.valid_until && new Date(discount.valid_until).getTime() <= now) continue;
    if (!activePromotionByProduct.has(discount.product_id)) activePromotionByProduct.set(discount.product_id, discount);
  }
  const categoryNames = new Map(categories.map((item) => [item.id, item.name]));
  const products = allProducts.filter((product) => (!q || product.name.toLocaleLowerCase("es").includes(q) || (product.sku ?? "").toLocaleLowerCase("es").includes(q)) && (!category || product.category_id === category) && (status === "all" || status === "active" && product.active || status === "inactive" && !product.active));

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div><ProductCreateModal categories={categories.filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))} /></div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <form className="mt-6 grid gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-[1fr_12rem_10rem_auto]"><input className={input} defaultValue={value("q")} name="q" placeholder="Buscar producto o SKU…" /><select className={input} defaultValue={category} name="category"><option value="">Todas las categorías</option>{categories.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select className={input} defaultValue={status} name="status"><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select><button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Filtrar</button></form>
    <section className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-4">Producto</th><th className="p-4">Categoría</th><th className="p-4">Precio vigente</th><th className="p-4">Estado</th><th className="p-4 text-right">Acciones</th></tr></thead><tbody>{products.map((product) => {
      const price = globalPriceByProduct.get(product.id) ?? anyPriceByProduct.get(product.id);
      const promotion = activePromotionByProduct.get(product.id);
      const promotionLabel = promotion ? `${promotion.discount_type === "PERCENTAGE" ? `${(promotion.discount_value / 100).toLocaleString("es-AR")}%` : `${formatCurrency(BigInt(promotion.discount_value))}/kg`} desde ${(promotion.minimum_grams / 1000).toLocaleString("es-AR")} kg` : null;
      const unitSuffix = product.unit_type === "WEIGHT" ? "/kg" : "/unidad";
      return <tr className="border-b border-stone-100 last:border-0" key={product.id}><td className="p-4"><strong>{product.name}</strong>{product.sku ? <p className="text-xs text-stone-500">SKU {product.sku}</p> : null}</td><td className="p-4 text-stone-600">{categoryNames.get(product.category_id ?? "") ?? "Sin categoría"}</td><td className="p-4"><strong>{price ? `${formatCurrency(BigInt(price.price_cents))} ${unitSuffix}` : "Sin precio"}</strong><p className="text-xs text-stone-500">{price?.branch_id ? "Sucursal específica" : "Global"}</p></td><td className="p-4"><StatusBadge tone={product.active ? "success" : "neutral"}>{product.active ? "Activo" : "Inactivo"}</StatusBadge></td><td className="p-4 text-right"><ProductManageModal branches={branches} categories={categories.filter((item) => item.active || item.id === product.category_id).map((item) => ({ id: item.id, name: item.name }))} price={price ? { cents: price.price_cents, branchId: price.branch_id } : null} product={{ id: product.id, categoryId: product.category_id, name: product.name, slug: product.slug, sku: product.sku, unitType: product.unit_type, active: product.active }} promotion={promotion && promotionLabel ? { id: promotion.id, label: promotionLabel } : null} /></td></tr>;
    })}</tbody></table></div>{!products.length ? <p className="p-8 text-center text-stone-500">No hay productos para estos filtros.</p> : null}</section>
    <details className="mt-5 rounded-xl bg-white p-5 shadow-sm"><summary className="cursor-pointer font-bold">Gestionar categorías</summary><form action={saveCategoryAction} className="mt-4 flex flex-wrap gap-2"><input className={input} name="name" placeholder="Nueva categoría" required /><input name="slug" type="hidden" value="" /><input name="sort_order" type="hidden" value="0" /><input name="active" type="hidden" value="on" /><button className="rounded-lg border px-4 py-2 text-sm font-bold">Agregar</button></form><div className="mt-4 flex flex-wrap gap-2">{categories.map((item) => <span className="rounded-lg bg-stone-100 px-3 py-2 text-sm font-semibold" key={item.id}>{item.name}</span>)}</div></details>
  </main>;
}
