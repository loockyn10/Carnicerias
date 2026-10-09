"use client";

import { stockUnitLabel } from "@carnicerias/business-logic";
import { useEffect, useRef, useState } from "react";

import { searchProductsAction, type ProductOption } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

/**
 * Searchable product field: types a name/SKU (or scans a barcode) and picks from at most 15
 * server-side matches. Never loads the catalog (Central can have thousands of products). When
 * `branchId` is set, only products enabled in that branch are offered. The chosen id travels in a
 * hidden input named `name`; the server validates it (nothing here is trusted).
 */
export function ProductPicker({ name, branchId = null, initial = null, onChange, placeholder = "Buscar por nombre, SKU o código de barras…", includeInactive = false }: {
  name: string;
  branchId?: string | null;
  initial?: ProductOption | null;
  onChange?: (product: ProductOption | null) => void;
  placeholder?: string;
  /** Ofrece también los productos dados de baja (filtros de Ventas y auditoría: conservan historial). */
  includeInactive?: boolean;
}) {
  const [selected, setSelected] = useState<ProductOption | null>(initial);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open || selected) return;
    const requestId = ++requestRef.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      searchProductsAction(query, branchId, includeInactive)
        .then((result) => { if (requestRef.current === requestId) setOptions(result); })
        .catch(() => { if (requestRef.current === requestId) { setOptions([]); setFailed(true); } })
        .finally(() => { if (requestRef.current === requestId) setLoading(false); });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, branchId, open, selected, includeInactive]);

  function choose(product: ProductOption | null) {
    setSelected(product);
    setQuery("");
    setOpen(false);
    onChange?.(product);
  }

  if (selected) {
    return <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm">
      <input name={name} type="hidden" value={selected.id} />
      <span className="min-w-0 truncate"><strong>{selected.name}</strong>{selected.sku ? <span className="ml-2 text-xs text-stone-500">{selected.sku}</span> : null}<span className="ml-2 text-xs text-stone-500">{selected.unitType === "WEIGHT" ? "por kg" : "por unidad"}</span>{selected.active === false ? <span className="ml-2 text-xs font-bold text-amber-700">inactivo</span> : null}</span>
      <button className="shrink-0 text-xs font-bold text-rose-800 hover:underline" onClick={() => choose(null)} type="button">Cambiar</button>
    </div>;
  }

  return <div className="relative">
    <input name={name} type="hidden" value="" />
    <input
      autoComplete="off"
      className={`${input} w-full`}
      onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault(); // a scanner ends with Enter: select the match instead of submitting the form
        const code = query.replace(/\s+/g, "").toUpperCase();
        const exact = options.find((option) => option.barcodes.includes(code) || (option.sku ?? "").toUpperCase() === code.toUpperCase());
        const only = options.length === 1 ? options[0] : undefined;
        const match = exact ?? only;
        if (match) choose(match);
      }}
      placeholder={placeholder}
      type="text"
      value={query}
    />
    {open ? <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-stone-200 bg-white text-sm shadow-lg">
      {options.map((option) => <li key={option.id}>
        <button className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-rose-50" onMouseDown={(event) => { event.preventDefault(); choose(option); }} type="button">
          <span className="min-w-0 truncate font-medium">{option.name}{option.sku ? <span className="ml-2 text-xs text-stone-500">{option.sku}</span> : null}{option.active === false ? <span className="ml-2 text-xs font-bold text-amber-700">inactivo</span> : null}</span>
          <span className="shrink-0 text-xs text-stone-500">{stockUnitLabel(option.unitType)}</span>
        </button>
      </li>)}
      {!options.length ? <li className="px-3 py-2 text-stone-500">{loading ? "Buscando…" : failed ? "No se pudo buscar" : branchId ? "Sin resultados entre los productos de esa sucursal" : "Sin resultados"}</li> : null}
    </ul> : null}
  </div>;
}
