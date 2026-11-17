"use client";

import { useMemo, useState } from "react";

import { formatCurrency } from "@carnicerias/business-logic";

import { filterPoultryProducts, formatKg, formatMargin, marginBps, POULTRY_SALE_UNIT_LABELS, type PoultryPriceList, type PoultryProductRow } from "../lib/poultry";
import { StatusBadge } from "./admin-ui";
import { fieldInput } from "./form-modal";
import { PoultryPriceHistory, PoultryPricesModal } from "./poultry-price-modals";
import { PoultryDeleteProductModal, PoultryProductSettingsModal } from "./poultry-product-modals";

/**
 * Pollos → Precios → «Productos de Pollos»: la tabla del tablero con un buscador en vivo (por nombre, sin mayúsculas ni acentos). Filtra
 * en el navegador lo que ya trajo `get_poultry_price_board`: no hay consultas extra al escribir.
 */
export function PoultryProductsBoard({ products, lists, timeZone }: { products: PoultryProductRow[]; lists: PoultryPriceList[]; timeZone: string }) {
  const [query, setQuery] = useState("");
  const activeLists = lists.filter((list) => list.active);
  const visible = useMemo(() => filterPoultryProducts(products, query), [products, query]);

  return <>
    {products.length > 0 ? <div className="border-b border-stone-200 px-4 py-3">
      <label className="sr-only" htmlFor="poultry-product-search">Buscar producto</label>
      <input
        autoComplete="off" className={`${fieldInput} w-full sm:max-w-sm`} data-testid="poultry-product-search" id="poultry-product-search"
        onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar producto por nombre…" type="search" value={query}
      />
    </div> : null}
    <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm" data-testid="poultry-price-board">
      <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr>
        <th className="p-4">Producto</th><th className="p-4">Modalidad</th><th className="p-4">Costo vigente</th>
        {activeLists.map((list) => <th className="p-4" key={list.id}>Precio {list.name}</th>)}
        <th className="p-4">Estado</th><th className="p-4 text-right">Acciones</th>
      </tr></thead>
      <tbody>{visible.map((product) => (
        <tr className={`border-b border-stone-100 last:border-0 ${product.active ? "" : "opacity-60"}`} data-testid="poultry-product-row" key={product.id}>
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
            <PoultryPricesModal lists={lists} product={product} />
            <PoultryProductSettingsModal product={product} />
            <PoultryPriceHistory productId={product.id} productName={product.name} timeZone={timeZone} />
            <PoultryDeleteProductModal product={product} />
          </div></td>
        </tr>
      ))}</tbody>
    </table></div>
    {products.length === 0 ? <p className="p-8 text-center text-stone-500">Todavía no hay productos de Pollos. Con «+ Agregar producto» elegí uno del catálogo (o creá uno nuevo) y cargale costo y precio.</p> : null}
    {products.length > 0 && visible.length === 0 ? <p className="p-8 text-center text-stone-500" data-testid="poultry-search-empty" role="status">Ningún producto coincide con «{query.trim()}».</p> : null}
  </>;
}
