"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { formatCurrency } from "@carnicerias/business-logic";

import { setPoultryProductSortOrderAction } from "../app/admin/poultry/actions";
import {
  filterPoultryByCategory, filterPoultryProducts, formatKg, formatMargin, marginBps, parseSortOrderInput, POULTRY_CATEGORIES, POULTRY_CATEGORY_LABELS,
  POULTRY_SALE_UNIT_LABELS, POULTRY_SORT_ORDER_MAX, sortPoultryProducts, type PoultryCategoryFilter, type PoultryPriceList, type PoultryProductRow
} from "../lib/poultry";
import { StatusBadge } from "./admin-ui";
import { fieldInput } from "./form-modal";
import { PoultryPriceHistory, PoultryPricesModal } from "./poultry-price-modals";
import { PoultryDeleteProductModal, PoultryProductSettingsModal } from "./poultry-product-modals";

const FILTERS: { value: PoultryCategoryFilter; label: string }[] = [
  { value: "ALL", label: "Todos" },
  ...POULTRY_CATEGORIES.map((value) => ({ value, label: POULTRY_CATEGORY_LABELS[value] }))
];

/**
 * Número de orden editable en la fila. Se guarda al confirmar (Enter) o al salir del campo. La celda sólo muestra un número que la base
 * confirmó: si el valor es inválido o el guardado falla, vuelve al número guardado y avisa.
 */
function SortOrderCell({ product }: { product: Pick<PoultryProductRow, "id" | "name" | "sortOrder"> }) {
  const [draft, setDraft] = useState(String(product.sortOrder));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saving = useRef(false);

  useEffect(() => { setDraft(String(product.sortOrder)); }, [product.sortOrder]);

  function commit() {
    if (saving.current) return;
    const parsed = parseSortOrderInput(draft);
    if (parsed === null) {
      setDraft(String(product.sortOrder));
      setError(`Ingresá un número entero entre 1 y ${String(POULTRY_SORT_ORDER_MAX)}.`);
      return;
    }
    if (parsed === product.sortOrder) { setDraft(String(parsed)); setError(null); return; }
    saving.current = true;
    startTransition(async () => {
      const result = await setPoultryProductSortOrderAction(product.id, parsed);
      saving.current = false;
      if (!result.ok) {
        setDraft(String(product.sortOrder));
        setError(result.error);
        return;
      }
      setError(null);
      setDraft(String(result.sortOrder));
    });
  }

  return <div className="grid gap-1">
    <input
      aria-describedby={error ? `sort-error-${product.id}` : undefined} aria-invalid={error ? true : undefined} aria-label={`Orden de ${product.name}`}
      className={`${fieldInput} w-20 text-center tabular-nums ${error ? "border-red-400" : ""} ${pending ? "opacity-60" : ""}`}
      data-testid="poultry-sort-order" disabled={pending} inputMode="numeric" max={POULTRY_SORT_ORDER_MAX} min={1}
      onBlur={commit}
      onChange={(event) => { setDraft(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { setDraft(String(product.sortOrder)); setError(null); }
      }}
      step={1} type="number" value={draft}
    />
    {pending ? <span className="text-xs text-stone-500" role="status">Guardando…</span> : null}
    {error ? <span className="max-w-40 text-xs text-red-700" data-testid="poultry-sort-order-error" id={`sort-error-${product.id}`} role="alert">{error}</span> : null}
  </div>;
}

/**
 * Pollos → Precios → «Productos de Pollos»: la tabla del tablero, ordenada por categoría (Pollo primero), número de orden, nombre e id.
 * Buscador en vivo (por nombre, sin mayúsculas ni acentos) combinado con el filtro de categoría. Filtra en el navegador lo que ya trajo
 * `get_poultry_price_board`: no hay consultas extra al escribir. El número de orden se edita en la misma fila.
 */
export function PoultryProductsBoard({ products, lists, timeZone }: { products: PoultryProductRow[]; lists: PoultryPriceList[]; timeZone: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PoultryCategoryFilter>("ALL");
  const activeLists = lists.filter((list) => list.active);
  const sorted = useMemo(() => sortPoultryProducts(products), [products]);
  const visible = useMemo(() => filterPoultryProducts(filterPoultryByCategory(sorted, category), query), [sorted, category, query]);
  const counts = useMemo(() => ({ ALL: products.length, POLLO: filterPoultryByCategory(products, "POLLO").length, CONGELADOS: filterPoultryByCategory(products, "CONGELADOS").length }), [products]);

  return <>
    {products.length > 0 ? <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 px-4 py-3">
      <label className="sr-only" htmlFor="poultry-product-search">Buscar producto</label>
      <input
        autoComplete="off" className={`${fieldInput} w-full sm:max-w-sm`} data-testid="poultry-product-search" id="poultry-product-search"
        onChange={(event) => { setQuery(event.target.value); }} placeholder="Buscar producto por nombre…" type="search" value={query}
      />
      <div aria-label="Filtrar por categoría" className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5" data-testid="poultry-category-filter" role="group">
        {FILTERS.map((filter) => <button
          aria-pressed={category === filter.value}
          className={`rounded-md px-3 py-1.5 text-sm font-bold ${category === filter.value ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"}`}
          data-testid={`poultry-category-filter-${filter.value.toLowerCase()}`} key={filter.value} onClick={() => { setCategory(filter.value); }} type="button"
        >{filter.label} <span className="font-normal opacity-70">({counts[filter.value]})</span></button>)}
      </div>
    </div> : null}
    <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-sm" data-testid="poultry-price-board">
      <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr>
        <th className="p-4">Orden</th><th className="p-4">Producto</th><th className="p-4">Categoría</th><th className="p-4">Modalidad</th><th className="p-4">Costo vigente</th>
        {activeLists.map((list) => <th className="p-4" key={list.id}>Precio {list.name}</th>)}
        <th className="p-4">Estado</th><th className="p-4 text-right">Acciones</th>
      </tr></thead>
      <tbody>{visible.map((product) => (
        <tr className={`border-b border-stone-100 last:border-0 ${product.active ? "" : "opacity-60"}`} data-testid="poultry-product-row" key={product.id}>
          <td className="p-4 align-top"><SortOrderCell product={product} /></td>
          <td className="p-4"><strong>{product.name}</strong>
            <p className="text-xs text-stone-500">{product.sku ? `SKU ${product.sku}` : ""}</p></td>
          <td className="p-4" data-testid="poultry-product-category">{POULTRY_CATEGORY_LABELS[product.category]}</td>
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
    {products.length > 0 && visible.length === 0 ? <p className="p-8 text-center text-stone-500" data-testid="poultry-search-empty" role="status">{query.trim()
      ? <>Ningún producto{category === "ALL" ? "" : ` de ${POULTRY_CATEGORY_LABELS[category]}`} coincide con «{query.trim()}».</>
      : <>No hay productos en {category === "ALL" ? "Pollos" : POULTRY_CATEGORY_LABELS[category]}.</>}</p> : null}
  </>;
}
