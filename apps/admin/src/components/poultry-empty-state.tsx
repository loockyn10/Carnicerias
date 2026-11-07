import Link from "next/link";

export const ADD_POULTRY_PRODUCT_HREF = "/admin/poultry/prices?add=1";

/** Estado vacío del Resumen: todavía no hay productos de Pollos (en vez de dejar las métricas en cero sin explicar qué falta). */
export function PoultryEmptyState() {
  return <section className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center shadow-sm" data-testid="poultry-empty-state">
    <h2 className="text-xl font-black uppercase tracking-tight">Todavía no hay productos de Pollos configurados</h2>
    <p className="mx-auto mt-2 max-w-md text-stone-600">Agregá el primer producto para comenzar a cargar precios y pedidos.</p>
    <Link className="mt-5 inline-block rounded-lg bg-rose-800 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-900" href={ADD_POULTRY_PRODUCT_HREF}>Agregar producto</Link>
  </section>;
}

/** Aviso del formulario de Nuevo pedido cuando no hay ningún producto de Pollos activo. */
export function PoultryNoProductsNotice() {
  return <section className="mt-6 rounded-xl bg-amber-50 p-6 text-amber-950" data-testid="poultry-no-products">
    <p className="font-bold">No hay productos de Pollos configurados.</p>
    <p className="mt-1 text-sm">Sólo los productos agregados a Pollos y activos se pueden pedir.</p>
    <Link className="mt-4 inline-block rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900" href={ADD_POULTRY_PRODUCT_HREF}>Agregar producto</Link>
  </section>;
}
