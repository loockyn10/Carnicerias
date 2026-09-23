import { PromotionModal, type PromotionValue } from "../../../components/promotion-modal";
import { PromotionsList, type PromotionRow } from "../../../components/promotions-list";
import { SectionTabs } from "../../../components/section-tabs";
import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";

const PRODUCTOS_TABS = [
  { label: "Productos", href: "/admin/products" },
  { label: "Precios", href: "/admin/products?tab=pricing" },
  { label: "Promociones", href: "/admin/promotions" }
];

interface Discount {
  id: string;
  product_id: string;
  branch_id: string | null;
  promotion_mode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimum_grams: number | null;
  discount_type: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discount_value: number | null;
  pack_quantity_grams: number | null;
  pack_quantity_units: number | null;
  pack_price_cents: number | null;
  active: boolean;
  valid_from: string;
  valid_until: string | null;
}
interface CommercialClient { from: (table: string) => { select: (columns: string) => { eq: (column: string, value: string) => { order: (column: string, options?: { ascending?: boolean }) => Promise<{ data: Discount[] | null; error: { message: string } | null }> } } } }

function promotionValue(discount: Discount): PromotionValue {
  return {
    id: discount.id, productId: discount.product_id, branchId: discount.branch_id,
    promotionMode: discount.promotion_mode, minimumGrams: discount.minimum_grams,
    discountType: discount.discount_type, discountValue: discount.discount_value,
    packQuantityGrams: discount.pack_quantity_grams, packQuantityUnits: discount.pack_quantity_units,
    packPriceCents: discount.pack_price_cents, active: discount.active,
    validFrom: discount.valid_from, validUntil: discount.valid_until
  };
}

/** "2 kg por $18.000" / "40 u por $28.000" for a pack row; the classic "X% desde Y kg" /
 * "$Z/kg desde Y kg" for a threshold row. The pack's configured TOTAL price is always what's
 * shown — never a derived $/kg or $/u, per the product requirement. */
function displayLine(discount: Discount): string {
  if (discount.promotion_mode === "PACK_FIXED_TOTAL") {
    const quantity = discount.pack_quantity_grams != null
      ? `${(discount.pack_quantity_grams / 1000).toLocaleString("es-AR")} kg`
      : `${(discount.pack_quantity_units ?? 0).toLocaleString("es-AR")} u`;
    return `${quantity} por $${((discount.pack_price_cents ?? 0) / 100).toLocaleString("es-AR")}`;
  }
  const value = discount.discount_type === "PERCENTAGE"
    ? `${((discount.discount_value ?? 0) / 100).toLocaleString("es-AR")}%`
    : `$${((discount.discount_value ?? 0) / 100).toLocaleString("es-AR")}/kg`;
  return `${value} desde ${((discount.minimum_grams ?? 0) / 1000).toLocaleString("es-AR")} kg`;
}

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const supabase = await createClient();
  const commercial = supabase as unknown as CommercialClient;
  const [productsResult, branchesResult, categoriesResult, discountsResult] = await Promise.all([
    supabase.from("products").select("id, name, unit_type, active, category_id").eq("organization_id", context.organizationId).order("name"),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    supabase.from("categories").select("id, name").eq("organization_id", context.organizationId),
    commercial.from("product_weight_discounts")
      .select("id, product_id, branch_id, promotion_mode, minimum_grams, discount_type, discount_value, pack_quantity_grams, pack_quantity_units, pack_price_cents, active, valid_from, valid_until")
      .eq("organization_id", context.organizationId).order("valid_from", { ascending: false })
  ]);
  const error = [productsResult.error, branchesResult.error, categoriesResult.error, discountsResult.error].find(Boolean);
  const products = productsResult.data ?? [];
  // Un producto activo, sea WEIGHT o UNIT, es elegible: la modalidad "Desde cierta cantidad"
  // sigue restringida a WEIGHT (sin cambios) pero "Pack a precio total" ya soporta ambos tipos —
  // ver promotion-modal.tsx. Éste era el motivo real por el que un producto UNIT recién creado
  // no aparecía antes: el filtro WEIGHT-only de acá, no un bug de caché.
  const eligibleProducts = products.map((product) => ({ id: product.id, name: product.name, active: product.active, unitType: product.unit_type }));
  const branches = branchesResult.data ?? [];
  const categories = categoriesResult.data ?? [];
  const discounts = discountsResult.data ?? [];
  const productNames = new Map(products.map((product) => [product.id, product.name]));
  const productCategoryNames = new Map(products.map((product) => [product.id, categories.find((category) => category.id === product.category_id)?.name ?? ""]));
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
  const editedDiscount = discounts.find((discount) => discount.id === value("edit"));

  const rows: PromotionRow[] = discounts.map((discount) => ({
    id: discount.id,
    productName: productNames.get(discount.product_id) ?? "",
    categoryName: productCategoryNames.get(discount.product_id) ?? "",
    branchLabel: discount.branch_id ? branchNames.get(discount.branch_id) ?? "" : "Todas las sucursales",
    active: discount.active,
    displayLine: displayLine(discount)
  }));

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-stone-500">Inicio / Promociones</p><h1 className="mt-1 text-3xl font-black tracking-tight">Promociones</h1><p className="mt-2 text-stone-600">Descuentos por cantidad y packs a precio total vigentes y programados.</p></div><PromotionModal branches={branches} initialOpen={value("create") === "1"} initialProductId={value("product")} products={eligibleProducts} trigger="+ Nueva promoción" /></div>
    <SectionTabs tabs={PRODUCTOS_TABS} />
    {editedDiscount ? <PromotionModal branches={branches} initialOpen products={eligibleProducts} promotion={promotionValue(editedDiscount)} /> : null}
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <PromotionsList rows={rows} />
  </main>;
}
