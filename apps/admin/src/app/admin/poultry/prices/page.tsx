import Link from "next/link";

import { StatusBadge } from "../../../../components/admin-ui";
import { PoultryPriceListButton } from "../../../../components/poultry-price-list-button";
import { PoultryPriceListModal } from "../../../../components/poultry-price-modals";
import { PoultryAddProductModal } from "../../../../components/poultry-product-modals";
import { PoultryProductsBoard } from "../../../../components/poultry-products-board";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { createPerfLogger } from "../../../../lib/perf";
import { parsePriceBoard } from "../../../../lib/poultry";
import { POULTRY_TABS } from "../../../../lib/poultry-tabs";
import { loadProductCreateProps } from "../../../../lib/product-create-props";
import { createClient } from "../../../../lib/supabase/server";

/**
 * Pollos → Precios: productos, costo vigente y precio de cada lista, en UNA consulta (`get_poultry_price_board`). Cambiar un costo o un
 * precio abre una vigencia nueva; el historial queda disponible por producto y los pedidos ya tomados no se recalculan.
 */
export default async function PoultryPricesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/poultry/prices");
  const context = await requireAdminContext();
  const params = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, createProps] = await Promise.all([perf.measure("priceBoard", supabase.rpc("get_poultry_price_board")), perf.measure("createProps", loadProductCreateProps(supabase, context.organizationId))]);
  perf.flush();
  const board = parsePriceBoard(data);

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Costo por producto y listas de precios. Un cliente usa su lista; si no tiene el producto, la lista General.</p>
      <div className="flex flex-wrap gap-2"><PoultryPriceListButton /><Link className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-700 hover:bg-stone-50" data-testid="poultry-price-list-images-link" href="/admin/poultry/price-list">Imágenes de la lista</Link><PoultryPriceListModal /><PoultryAddProductModal createProps={createProps} defaultOpen={params.add === "1"} /></div>
    </div>
    <SectionTabs tabs={POULTRY_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}

    <section className="mt-6 rounded-xl bg-white p-4 shadow-sm">
      <h2 className="text-lg font-black">Listas de precios</h2>
      <ul className="mt-2 flex flex-wrap gap-2" data-testid="poultry-lists">
        {board.lists.map((list) => <li className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-1.5 text-sm" key={list.id}>
          <strong>{list.name}</strong>
          {list.isDefault ? <StatusBadge tone="neutral">General</StatusBadge> : null}
          {!list.active ? <StatusBadge tone="warning">Inactiva</StatusBadge> : null}
          <span className="text-xs text-stone-500">{list.customerCount} cliente{list.customerCount === 1 ? "" : "s"}</span>
          <PoultryPriceListModal list={list} />
        </li>)}
      </ul>
    </section>

    <section className="mt-5 overflow-hidden rounded-xl bg-white shadow-sm">
      <div className="border-b border-stone-200 p-4"><h2 className="text-lg font-black">Productos de Pollos</h2><p className="text-sm text-stone-600">Productos del catálogo general que se venden en este módulo. Sólo los activos se pueden pedir.</p></div>
      <PoultryProductsBoard lists={board.lists} products={board.products} timeZone={context.timezone} />
    </section>
  </main>;
}
