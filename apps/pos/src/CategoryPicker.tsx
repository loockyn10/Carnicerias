import { useEffect, useMemo, useRef, useState } from "react";

interface PickerCategory { id: string; name: string }

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-AR");

/** Selector compacto con búsqueda por nombre (POS de Central, ~45 categorías). "ALL" = todas. */
export function CategoryPicker({ categories, value, onChange }: { categories: PickerCategory[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const label = value === "ALL" ? "Todas las categorías" : categories.find((category) => category.id === value)?.name ?? "Todas las categorías";
  const matches = useMemo(() => {
    const q = normalize(query.trim());
    return q ? categories.filter((category) => normalize(category.name).includes(q)) : categories;
  }, [categories, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (id: string) => { onChange(id); setOpen(false); setQuery(""); };
  const item = (id: string, name: string) => (
    <button key={id} type="button" className={`block w-full px-4 py-2 text-left font-bold ${value === id ? "bg-rose-600" : "hover:bg-stone-800"}`} onClick={() => pick(id)}>{name}</button>
  );

  return (
    <div ref={rootRef} className="pos-categories relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 font-bold ${value === "ALL" ? "border-stone-700 bg-stone-800" : "border-rose-600 bg-rose-600"}`} onClick={() => setOpen((current) => !current)}>
        <span className="truncate">{label}</span><span aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-stone-700 bg-stone-900 shadow-xl">
          <input autoFocus className="w-full rounded-t-xl border-b border-stone-700 bg-stone-900 px-4 py-2 outline-none" placeholder="Buscar categoría…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} />
          <div role="listbox" className="max-h-72 overflow-y-auto">
            {!query.trim() ? item("ALL", "Todas las categorías") : null}
            {matches.map((category) => item(category.id, category.name))}
            {matches.length === 0 ? <p className="px-4 py-2 text-stone-400">Sin resultados</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
