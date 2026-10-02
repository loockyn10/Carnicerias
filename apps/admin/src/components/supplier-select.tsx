"use client";

import { useMemo, useState } from "react";

import { normalizeSearchText } from "../lib/text-search";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const MAX_OPTIONS = 8;

export interface SupplierOption { id: string; name: string; code: string | null; active: boolean }

/**
 * "Proveedor principal" del producto: selector buscable y OPCIONAL (un producto sin proveedor es
 * válido). Filtra en el navegador sobre la lista ya cargada (accent/case-insensitive, por nombre o
 * código) y muestra a lo sumo 8 coincidencias. Sólo se ofrecen los proveedores activos más el que el
 * producto ya tiene (aunque esté inactivo, para no perderlo al guardar). El id elegido viaja en un
 * input oculto `supplier_id` (vacío = sin proveedor); el servidor lo valida de nuevo.
 */
export function SupplierSelect({ suppliers, currentSupplierId = null }: { suppliers: SupplierOption[]; currentSupplierId?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(currentSupplierId);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const offered = useMemo(() => suppliers.filter((supplier) => supplier.active || supplier.id === currentSupplierId), [suppliers, currentSupplierId]);
  const selected = offered.find((supplier) => supplier.id === selectedId) ?? null;
  const matches = useMemo(() => {
    const needle = normalizeSearchText(query);
    const found = needle === "" ? offered : offered.filter((supplier) => normalizeSearchText(`${supplier.name} ${supplier.code ?? ""}`).includes(needle));
    return found.slice(0, MAX_OPTIONS);
  }, [offered, query]);

  function choose(id: string | null) {
    setSelectedId(id);
    setQuery("");
    setOpen(false);
  }

  return <div className="grid gap-1 text-sm font-medium">
    <span>Proveedor principal <span className="text-xs font-normal text-stone-500">opcional</span></span>
    <input name="supplier_id" type="hidden" value={selectedId ?? ""} />
    <input name="current_supplier_id" type="hidden" value={currentSupplierId ?? ""} />
    {selected ? <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm">
      <span className="min-w-0 truncate"><strong>{selected.name}</strong>{selected.code ? <span className="ml-2 text-xs text-stone-500">{selected.code}</span> : null}{selected.active ? null : <span className="ml-2 text-xs font-bold text-amber-700">inactivo</span>}</span>
      <span className="flex shrink-0 gap-3"><button className="text-xs font-bold text-rose-800 hover:underline" onClick={() => setSelectedId(null)} type="button">Cambiar</button><button className="text-xs font-bold text-stone-500 hover:underline" onClick={() => choose(null)} type="button">Quitar</button></span>
    </div> : <div className="relative">
      <input
        autoComplete="off"
        className={`${input} w-full font-normal`}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={offered.length === 0 ? "Todavía no hay proveedores" : "Sin proveedor — buscá por nombre o código…"}
        role="combobox"
        aria-expanded={open}
        aria-label="Buscar proveedor"
        type="search"
        value={query}
      />
      {open && offered.length > 0 ? <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg" role="listbox">
        {matches.map((supplier) => <li key={supplier.id}><button className="block w-full px-3 py-2 text-left text-sm font-normal hover:bg-stone-50" onMouseDown={(event) => { event.preventDefault(); choose(supplier.id); }} type="button"><strong>{supplier.name}</strong>{supplier.code ? <span className="ml-2 text-xs text-stone-500">{supplier.code}</span> : null}</button></li>)}
        {matches.length === 0 ? <li className="px-3 py-2 text-sm font-normal text-stone-500">Ningún proveedor coincide.</li> : null}
      </ul> : null}
    </div>}
  </div>;
}
