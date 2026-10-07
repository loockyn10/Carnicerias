import Link from "next/link";

import { ProductPriceLabel } from "../../../../components/product-price-label";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { buildProductLabel, labelFontSizesPt, LABEL_HEIGHT_MM, LABEL_WIDTH_MM } from "../../../../lib/product-label";
import { createClient } from "../../../../lib/supabase/server";
import { PRODUCTOS_TABS } from "../../products-tabs";

const PREVIEW_SCALE = 3.2;
const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export default async function ProductLabelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const query = value("q").trim().slice(0, 80);
  const selectedId = value("product");
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [optionsResult, settingsResult, productResult, pricesResult] = await Promise.all([
    supabase.rpc("search_products", { p_query: query, p_limit: 15, p_active_only: true }),
    supabase.from("organization_pricing_settings").select("unit_bulk_discount_bps").eq("organization_id", context.organizationId).maybeSingle(),
    selectedId ? supabase.from("products").select("id, name, unit_type").eq("organization_id", context.organizationId).eq("id", selectedId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    // Mismo precio vigente que la lista de Productos: el global (sin sucursal) vigente hoy.
    selectedId ? supabase.from("product_prices").select("price_cents, valid_from, valid_to").eq("organization_id", context.organizationId).eq("product_id", selectedId).is("branch_id", null).lte("valid_from", nowIso).or(`valid_to.is.null,valid_to.gt.${nowIso}`).order("valid_from", { ascending: false }).limit(1) : Promise.resolve({ data: [], error: null })
  ]);
  const error = [optionsResult.error, settingsResult.error, productResult.error, pricesResult.error].find(Boolean);
  const options = optionsResult.data ?? [];
  const product = productResult.data;
  const label = product ? buildProductLabel({
    name: product.name, unitType: product.unit_type,
    listPriceCents: pricesResult.data?.[0]?.price_cents ?? null,
    unitBulkDiscountBps: settingsResult.data?.unit_bulk_discount_bps ?? null
  }) : null;
  const sizes = labelFontSizesPt();
  const pt = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })} pt`;
  const href = (id: string) => `/admin/products/labels?${new URLSearchParams({ ...(query ? { q: query } : {}), product: id }).toString()}`;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs tabs={PRODUCTOS_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <div className="mt-6 grid gap-6 lg:grid-cols-[22rem_1fr]">
      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-black">Elegir producto</h2>
        <form className="mt-3 flex gap-2">
          <input className={`${input} min-w-0 flex-1`} defaultValue={query} name="q" placeholder="Nombre, SKU o código de barras…" />
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold">Buscar</button>
        </form>
        <ul className="mt-3 divide-y divide-stone-100" data-testid="label-product-options">
          {options.map((option) => <li key={option.product_id}><Link className={`block px-2 py-2 text-sm hover:bg-stone-50 ${option.product_id === selectedId ? "bg-rose-50 font-bold text-rose-800" : ""}`} href={href(option.product_id)}>{option.product_name}<span className="ml-2 text-xs text-stone-500">{option.unit_type === "WEIGHT" ? "por kg" : "por unidad"}</span></Link></li>)}
        </ul>
        {!options.length ? <p className="mt-3 text-sm text-stone-500">No hay productos para esa búsqueda.</p> : null}
      </section>
      <section className="rounded-xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-black">Vista previa</h2>
        {label ? <>
          <div className="mt-4 overflow-x-auto pb-2">
            <div className="inline-block border border-stone-300 shadow-sm" data-testid="label-preview-frame"><ProductPriceLabel label={label} scale={PREVIEW_SCALE} /></div>
          </div>
          <p className="mt-3 text-sm font-bold text-stone-700">Tamaño: {LABEL_WIDTH_MM} × {LABEL_HEIGHT_MM} mm <span className="font-normal text-stone-500">(vista ampliada ×{PREVIEW_SCALE.toLocaleString("es-AR")})</span></p>
          <p className="mt-1 text-xs text-stone-500">Precio {pt(sizes.price)} · nombre {pt(sizes.title)} · aclaración {pt(sizes.note)} · precio unitario {pt(sizes.unitPrice)}</p>
          {label.variant === "NO_PRICE" ? <p className="mt-2 text-sm text-amber-700">Este producto no tiene precio vigente definido.</p> : null}
        </> : <p className="mt-4 text-sm text-stone-500">Elegí un producto para ver su etiqueta.</p>}
      </section>
    </div>
  </main>;
}
