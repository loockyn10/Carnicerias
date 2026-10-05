import { useEffect, useRef, useState } from "react";

import { formatCurrency } from "@carnicerias/business-logic";

import { CENTRAL_ROW_HEIGHT, CENTRAL_ROW_OVERSCAN, centralRowCode, centralUnitLabel, computeVisibleWindow, type CentralListProduct } from "./lib/central-list";
import { isPriceMissing } from "./lib/product-price";

export interface CentralRowBadge {
  kind: "PACK" | "PROMO";
  label: string;
}

interface CentralProductListProps<T extends CentralListProduct> {
  /** Productos ya filtrados/ordenados por App (misma lista que alimentaba la grilla). */
  products: readonly T[];
  /** Un toque a la fila hace exactamente lo mismo que tocar la card: `openWeight(product)`. */
  onSelect: (product: T) => void;
  badgesFor: (product: T) => readonly CentralRowBadge[];
  accentFor: (product: T) => string | undefined;
  /** Cambia cuando cambia el filtro (categoría/búsqueda): la lista vuelve arriba. */
  resetKey: string;
}

/**
 * Lista compacta de productos para Central (reemplaza la grilla de cards sólo allí). Filas de alto fijo
 * con ventana virtual: con miles de productos sólo se montan las filas visibles + un overscan. Es sólo
 * presentación: no filtra, no decide stock ni precio, y el escáner no depende de qué fila está montada
 * (resuelve contra el catálogo completo en App).
 */
export function CentralProductList<T extends CentralListProduct>({ products, onSelect, badgesFor, accentFor, resetKey }: CentralProductListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Se guarda el primer índice visible (no el scrollTop crudo): el estado sólo cambia al cruzar una fila.
  const [firstRow, setFirstRow] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(CENTRAL_ROW_HEIGHT * 12);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    setFirstRow(0);
  }, [resetKey]);

  const { start, end } = computeVisibleWindow({
    scrollTop: firstRow * CENTRAL_ROW_HEIGHT,
    viewportHeight,
    rowHeight: CENTRAL_ROW_HEIGHT,
    total: products.length,
    overscan: CENTRAL_ROW_OVERSCAN
  });

  return (
    <div
      ref={containerRef}
      className="pos-central-list mt-3 overflow-y-auto rounded-xl border border-stone-800 bg-stone-900/40"
      data-view="list"
      onScroll={(event) => setFirstRow(Math.floor(event.currentTarget.scrollTop / CENTRAL_ROW_HEIGHT))}
    >
      <div style={{ paddingTop: start * CENTRAL_ROW_HEIGHT, paddingBottom: Math.max(0, products.length - end) * CENTRAL_ROW_HEIGHT }}>
        {products.slice(start, end).map((product) => (
          <CentralProductRow key={product.productId} product={product} accent={accentFor(product)} badges={badgesFor(product)} onSelect={() => onSelect(product)} />
        ))}
      </div>
    </div>
  );
}

export function CentralProductRow({ product, accent, badges, onSelect }: { product: CentralListProduct; accent: string | undefined; badges: readonly CentralRowBadge[]; onSelect: () => void }) {
  const code = centralRowCode(product);
  const missing = isPriceMissing(product);
  return (
    <button
      type="button"
      className="pos-central-row flex w-full items-center gap-3 border-b border-l-4 border-b-stone-800 border-l-stone-700 px-3 text-left transition hover:bg-stone-800 focus-visible:bg-stone-800 focus-visible:outline-none"
      style={{ height: CENTRAL_ROW_HEIGHT, borderLeftColor: accent }}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-black leading-tight">{product.productName}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs leading-tight text-stone-500">
          {code ? <span className="truncate">{code}</span> : null}
          {badges.map((badge) => (
            <span
              key={`${badge.kind}:${badge.label}`}
              className={`shrink-0 rounded px-1.5 py-px text-[11px] font-bold ${badge.kind === "PACK" ? "bg-sky-950 text-sky-300" : "bg-amber-950 text-amber-300"}`}
            >
              {badge.label}
            </span>
          ))}
        </span>
      </span>
      {missing
        ? <span className="w-32 shrink-0 text-right text-base font-black text-amber-300">SIN PRECIO</span>
        : (
          <span className="w-32 shrink-0 text-right text-lg font-black tabular-nums text-rose-400">
            {formatCurrency(product.pricePerKgCents)}
            {product.unitType === "WEIGHT" ? <small className="text-xs font-bold text-stone-400">/kg</small> : null}
          </span>
        )}
      <span className="w-16 shrink-0 rounded bg-stone-800 py-0.5 text-center text-[11px] font-black tracking-wide text-stone-300">{centralUnitLabel(product.unitType)}</span>
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stone-800 text-xl font-black text-stone-200">+</span>
    </button>
  );
}
