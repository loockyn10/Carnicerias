import { formatCurrency } from "@carnicerias/business-logic";

import { StatusBadge } from "../../../../components/admin-ui";
import { PoultryPriceHistory, PoultryPriceListModal, PoultryPricesModal } from "../../../../components/poultry-price-modals";
import { PoultryAddProductModal, PoultryProductSettingsModal } from "../../../../components/poultry-product-modals";
import { SectionTabs } from "../../../../components/section-tabs";
import { requireAdminContext } from "../../../../lib/admin";
import { createPerfLogger } from "../../../../lib/perf";
import { formatKg, formatMargin, marginBps, parsePriceBoard, POULTRY_SALE_UNIT_LABELS } from "../../../../lib/poultry";
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
  const activeLists = board.lists.filter((list) => list.active);

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className="max-w-2xl text-stone-600">Costo por producto y listas de precios. Un cliente usa su lista; si no tiene el producto, la lista General.</p>
      <div className="flex flex-wrap gap-2"><PoultryPriceListModal /><PoultryAddProductModal createProps={createProps} defaultOpen={params.add === "1"} /></div>
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
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm" data-testid="poultry-price-board">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr>
          <th className="p-4">Producto</th><th className="p-4">Modalidad</th><th className="p-4">Costo vigente</th>
          {activeLists.map((list) => <th className="p-4" key={list.id}>Precio {list.name}</th>)}
          <th className="p-4">Estado</th><th className="p-4 text-right">Acciones</th>
        </tr></thead>
        <tbody>{board.products.map((product) => (
          <tr className={`border-b border-stone-100 last:border-0 ${product.active ? "" : "opacity-60"}`} key={product.id}>
            <td className="p-4"><strong>{product.name}</strong>
              <p className="text-xs text-stone-500">{product.sku ? `SKU ${product.sku}` : ""}</p></td>
            <td className="p-4">{POULTRY_SALE_UNIT_LABELS[product.saleUnit]}{product.referenceWeightGrams ? <span className="block text-xs text-stone-500">ref. {formatKg(product.referenceWeightGrams)}</span> : null}</td>
            <td className="p-4">{product.costCents !== null ? <><strong>{formatCurrency(product.costCents)}</strong><span className="block text-xs text-stone-500">{product.saleUnit === "WEIGHT" ? "por kg" : "por cajón"}</span></> : <span className="text-amber-700">Sin costo</span>}</td>
            {activeLists.map((list) => {
              const price = product.prices[list.id];
              return <td className="p-4" key={list.id}>{price ? <>
                <strong>{formatCurrency(price.cents)}</strong>
                {product.costCents !== null ? <span className="block text-xs text-stone-500">margen {formatMargin(marginBps(price.cents, product.costCents))}</span> : null}
              </> : <span className="text-stone-400">—</span>}</td>;
            })}
            <td className="p-4"><StatusBadge tone={product.active ? "success" : "neutral"}>{product.active ? "Activo" : "Quitado"}</StatusBadge></td>
            <td className="p-4"><div className="flex flex-wrap justify-end gap-2">
              <PoultryPricesModal lists={board.lists} product={product} />
              <PoultryProductSettingsModal product={product} />
              <PoultryPriceHistory productId={product.id} productName={product.name} timeZone={context.timezone} />
            </div></td>
          </tr>
        ))}</tbody>
      </table></div>
      {board.products.length === 0 ? <p className="p-8 text-center text-stone-500">Todavía no hay productos de Pollos. Con «+ Agregar producto» elegí uno del catálogo (o creá uno nuevo) y cargale costo y precio.</p> : null}
    </section>
  </main>;
}
