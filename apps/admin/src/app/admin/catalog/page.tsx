import { formatCurrency } from "@carnicerias/business-logic";

import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { saveAnnouncementAction, saveCategoryAction, saveProductAction, saveWeightDiscountAction, setPriceAction } from "../actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ discount_error?: string }> }) {
  const params = await searchParams;
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [categoriesResult, productsResult, pricesResult, branchesResult] = await Promise.all([
    supabase.from("categories").select("id, name, slug, sort_order, active").eq("organization_id", context.organizationId).order("sort_order"),
    supabase.from("products").select("id, category_id, name, slug, sku, unit_type, active").eq("organization_id", context.organizationId).order("name"),
    supabase.from("product_prices").select("id, product_id, branch_id, price_cents, valid_from, valid_to, created_at").eq("organization_id", context.organizationId).order("valid_from", { ascending: false }).limit(200),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")
  ]);
  const error = [categoriesResult.error, productsResult.error, pricesResult.error, branchesResult.error].find(Boolean);
  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];
  const branches = branchesResult.data ?? [];
  const productNames = new Map(products.map((item) => [item.id, item.name]));
  const branchNames = new Map(branches.map((item) => [item.id, item.name]));

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Gestión comercial</p><h1 className="mt-1 text-3xl font-black">Categorías, productos y precios</h1>
    <p className="mt-2 text-stone-600">Las bajas son lógicas. El historial de precios y las referencias de ventas no se eliminan.</p>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {params.discount_error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{params.discount_error}</p> : null}

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Categorías</h2>
      <form action={saveCategoryAction} className="mt-4 grid gap-3 md:grid-cols-[2fr_2fr_1fr_auto_auto]">
        <input className={input} name="name" placeholder="Nombre" required /><input className={input} name="slug" placeholder="slug automático" /><input className={input} name="sort_order" type="number" defaultValue="0" /><label className="flex items-center gap-2"><input defaultChecked name="active" type="checkbox" /> Activa</label><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Crear</button>
      </form>
      <div className="mt-5 space-y-2">{categories.map((category) => <form action={saveCategoryAction} className="grid gap-2 rounded-xl bg-stone-50 p-3 md:grid-cols-[2fr_2fr_1fr_auto_auto]" key={category.id}>
        <input name="category_id" type="hidden" value={category.id} /><input className={input} name="name" defaultValue={category.name} required /><input className={input} name="slug" defaultValue={category.slug} required /><input className={input} name="sort_order" type="number" defaultValue={category.sort_order} /><label className="flex items-center gap-2"><input defaultChecked={category.active} name="active" type="checkbox" /> Activa</label><button className="rounded-lg border px-3 py-2 font-bold">Guardar</button>
      </form>)}</div>
    </section>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm" id="products"><h2 className="text-xl font-black">Productos</h2>
      <form action={saveProductAction} className="mt-4 grid gap-3 lg:grid-cols-[1.6fr_1fr_1.4fr_1fr_1fr_auto_auto]">
        <input className={input} name="name" placeholder="Producto" required /><input className={input} name="sku" placeholder="SKU" /><select className={input} name="category_id" required><option value="">Categoría</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className={input} name="slug" placeholder="slug automático" /><select className={input} defaultValue="WEIGHT" name="unit_type"><option value="WEIGHT">Peso</option><option value="UNIT">Unidad</option></select><label className="flex items-center gap-2"><input defaultChecked name="active" type="checkbox" /> Activo</label><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Crear</button>
      </form>
      <div className="mt-5 space-y-2">{products.map((product) => <form action={saveProductAction} className="grid gap-2 rounded-xl bg-stone-50 p-3 lg:grid-cols-[1.6fr_1fr_1.4fr_1fr_1fr_auto_auto]" key={product.id}>
        <input name="product_id" type="hidden" value={product.id} /><input className={input} name="name" defaultValue={product.name} required /><input className={input} name="sku" defaultValue={product.sku ?? ""} /><select className={input} name="category_id" defaultValue={product.category_id ?? ""} required>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className={input} name="slug" defaultValue={product.slug} required /><select className={input} defaultValue={product.unit_type} name="unit_type"><option value="WEIGHT">Peso</option><option value="UNIT">Unidad</option></select><label className="flex items-center gap-2"><input defaultChecked={product.active} name="active" type="checkbox" /> Activo</label><button className="rounded-lg border px-3 py-2 font-bold">Guardar</button>
      </form>)}</div>
    </section>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm" id="prices"><h2 className="text-xl font-black">Nuevo precio</h2><p className="mt-1 text-sm text-stone-600">Sin sucursal = precio global. Un precio de sucursal tiene prioridad mientras esté vigente.</p>
      <form action={setPriceAction} className="mt-4 grid gap-3 lg:grid-cols-[2fr_2fr_1fr_1.5fr_auto_auto]">
        <select className={input} name="product_id" required><option value="">Producto</option>{products.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select className={input} name="branch_id"><option value="">Global</option>{branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className={input} min="0.01" name="price" placeholder="Precio ARS" step="0.01" type="number" /><input className={input} name="effective_at" type="datetime-local" /><label className="flex items-center gap-2 text-sm"><input name="close_override" type="checkbox" /> Cerrar override</label><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Aplicar</button>
      </form>
      <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[750px] text-left text-sm"><thead><tr className="border-b text-stone-500"><th className="p-3">Producto</th><th className="p-3">Alcance</th><th className="p-3">Precio</th><th className="p-3">Desde</th><th className="p-3">Hasta</th><th className="p-3">Estado</th></tr></thead><tbody>{(pricesResult.data ?? []).map((price) => { const now = Date.now(); const active = new Date(price.valid_from).getTime() <= now && (!price.valid_to || new Date(price.valid_to).getTime() > now); return <tr className="border-b border-stone-100" key={price.id}><td className="p-3 font-bold">{productNames.get(price.product_id)}</td><td className="p-3">{price.branch_id ? branchNames.get(price.branch_id) : "Global"}</td><td className="p-3">{formatCurrency(BigInt(price.price_cents))}</td><td className="p-3">{new Date(price.valid_from).toLocaleString("es-AR", { timeZone: context.timezone })}</td><td className="p-3">{price.valid_to ? new Date(price.valid_to).toLocaleString("es-AR", { timeZone: context.timezone }) : "Abierto"}</td><td className="p-3 font-bold">{active ? "Vigente" : new Date(price.valid_from).getTime() > now ? "Programado" : "Histórico"}</td></tr>; })}</tbody></table></div>
    </section>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm" id="discounts"><h2 className="text-xl font-black">Descuentos por peso</h2><form action={saveWeightDiscountAction} className="mt-4 grid gap-3 lg:grid-cols-6"><select className={input} name="product_id" required><option value="">Producto</option>{products.filter((p) => p.unit_type === "WEIGHT").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><select className={input} name="branch_id"><option value="">Todas las sucursales</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><input className={input} name="minimum_kg" type="number" step="0.001" min="0.001" placeholder="Desde kg" required/><select className={input} name="discount_type"><option value="PERCENTAGE">Porcentaje</option><option value="FIXED_PRICE_PER_KG">Precio/kg</option></select><input className={input} name="discount_value" type="number" step="0.01" min="0.01" placeholder="Valor" required/><label className="flex items-center gap-2"><input defaultChecked name="active" type="checkbox"/> Activa</label><input className={input} name="valid_from" type="datetime-local"/><input className={input} name="valid_until" type="datetime-local"/><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Guardar descuento</button></form></section>
    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm" id="announcements"><h2 className="text-xl font-black">Avisos para sucursales</h2><form action={saveAnnouncementAction} className="mt-4 grid gap-3 lg:grid-cols-4"><select className={input} name="branch_id"><option value="">Todas las sucursales</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><input className={input} name="title" placeholder="Título" required/><input className={input} name="message" placeholder="Mensaje" required/><select className={input} name="type"><option>INFO</option><option>WARNING</option><option>PROMOTION</option><option>STOCK</option><option>INTERNAL</option></select><input className={input} name="priority" type="number" min="0" max="3" defaultValue="0"/><label className="flex items-center gap-2"><input defaultChecked name="active" type="checkbox"/> Activo</label><input className={input} name="starts_at" type="datetime-local"/><input className={input} name="ends_at" type="datetime-local"/><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Publicar aviso</button></form></section>
  </main>;
}
