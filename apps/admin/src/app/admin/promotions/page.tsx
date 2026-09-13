import Link from "next/link";

import { PromotionModal, type PromotionValue } from "../../../components/promotion-modal";
import { StatusBadge } from "../../../components/admin-ui";
import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";

interface Discount { id: string; product_id: string; branch_id: string | null; minimum_grams: number; discount_type: "PERCENTAGE" | "FIXED_PRICE_PER_KG"; discount_value: number; active: boolean; valid_from: string; valid_until: string | null }
interface CommercialClient { from: (table: string) => { select: (columns: string) => { eq: (column: string, value: string) => { order: (column: string, options?: { ascending?: boolean }) => Promise<{ data: Discount[] | null; error: { message: string } | null }> } } } }

function promotionValue(discount: Discount): PromotionValue {
  return { id: discount.id, productId: discount.product_id, branchId: discount.branch_id, minimumGrams: discount.minimum_grams, discountType: discount.discount_type, discountValue: discount.discount_value, active: discount.active, validFrom: discount.valid_from, validUntil: discount.valid_until };
}

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const supabase = await createClient();
  const commercial = supabase as unknown as CommercialClient;
  const [productsResult, branchesResult, discountsResult] = await Promise.all([
    supabase.from("products").select("id, name, unit_type, active").eq("organization_id", context.organizationId).order("name"),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    commercial.from("product_weight_discounts").select("id, product_id, branch_id, minimum_grams, discount_type, discount_value, active, valid_from, valid_until").eq("organization_id", context.organizationId).order("valid_from", { ascending: false })
  ]);
  const error = [productsResult.error, branchesResult.error, discountsResult.error].find(Boolean);
  const products = productsResult.data ?? [];
  const weightProducts = products.filter((product) => product.unit_type === "WEIGHT").map((product) => ({ id: product.id, name: product.name, active: product.active }));
  const branches = branchesResult.data ?? [];
  const discounts = discountsResult.data ?? [];
  const productNames = new Map(products.map((product) => [product.id, product.name]));
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const editedDiscount = discounts.find((discount) => discount.id === value("edit"));

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-stone-500">Inicio / Promociones</p><h1 className="mt-1 text-3xl font-black tracking-tight">Promociones</h1><p className="mt-2 text-stone-600">Descuentos por peso vigentes y programados.</p></div><PromotionModal branches={branches} initialOpen={value("create") === "1"} initialProductId={value("product")} products={weightProducts} trigger="+ Nueva promoción" /></div>
    {editedDiscount ? <PromotionModal branches={branches} initialOpen products={weightProducts} promotion={promotionValue(editedDiscount)} /> : null}
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <section className="mt-7 divide-y rounded-xl bg-white shadow-sm">{discounts.map((discount) => <article className="flex flex-wrap items-center justify-between gap-4 p-4" key={discount.id}><div><h2 className="font-bold">{productNames.get(discount.product_id)}</h2><p className="mt-1 text-sm text-stone-600">{discount.discount_type === "PERCENTAGE" ? `${(discount.discount_value / 100).toLocaleString("es-AR")}%` : `$${(discount.discount_value / 100).toLocaleString("es-AR")}/kg`} desde {(discount.minimum_grams / 1000).toLocaleString("es-AR")} kg · {discount.branch_id ? branchNames.get(discount.branch_id) : "Todas las sucursales"}</p></div><div className="flex items-center gap-3"><StatusBadge tone={discount.active ? "success" : "neutral"}>{discount.active ? "Activa" : "Inactiva"}</StatusBadge><Link className="rounded-lg border px-3 py-2 text-sm font-bold" href={`/admin/promotions?edit=${discount.id}`}>Editar</Link></div></article>)}{!discounts.length ? <p className="p-8 text-center text-stone-500">Todavía no hay promociones.</p> : null}</section>
  </main>;
}
