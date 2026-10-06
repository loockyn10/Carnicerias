"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { BulkDeactivateState } from "../app/admin/actions";
import {
  deactivateConfirmationText, deactivateSuccessText, effectiveSelection, productCountLabel, selectedCountLabel, toggleAllSelectable, toggleSelected
} from "../lib/product-selection";

interface SelectionContextValue {
  selecting: boolean;
  /** Ids seleccionados que siguen visibles (los que dejaron de verse nunca cuentan). */
  selectedIds: string[];
  selectableIds: string[];
  toggleMode: () => void;
  toggle: (productId: string) => void;
  toggleAll: () => void;
  /** Limpia la selección y sale del modo selección; no modifica ningún producto. */
  cancel: () => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

// Cuando la desactivación vacía la última página se navega a la anterior: la `key` del provider cambia y se remonta, así que el aviso
// de éxito viaja hasta el montaje siguiente por acá (módulo del cliente: sobrevive a la navegación sin usar la URL ni storage).
let carriedNotice: string | null = null;

function useSelection(): SelectionContextValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("Los componentes de selección de productos deben ir dentro de <ProductSelectionProvider>");
  return value;
}

/**
 * Estado del modo selección de /admin/products. Sin checkboxes permanentes: todo lo que se dibuja
 * (columna, encabezado, barra) depende de `selecting`. `selectableIds` son los productos ACTIVOS de la
 * página actual; la página lo monta con una `key` derivada de los filtros, así que cambiar de filtro o
 * de página descarta el estado (y la selección) por completo.
 */
export function ProductSelectionProvider({ selectableIds, children }: { selectableIds: string[]; children: ReactNode }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectableKey = selectableIds.join(",");
  // `selectableKey` es la identidad estable de `selectableIds` (la página pasa un array nuevo en cada render).
  const stableSelectableIds = useMemo(() => selectableIds, [selectableKey]);
  const selectedIds = useMemo(() => effectiveSelection(selected, stableSelectableIds), [selected, stableSelectableIds]);

  const cancel = useCallback(() => { setSelected(new Set()); setSelecting(false); }, []);
  const toggleMode = useCallback(() => {
    setSelecting((current) => !current);
    setSelected(new Set());
  }, []);
  const toggle = useCallback((productId: string) => setSelected((current) => toggleSelected(current, productId)), []);
  const toggleAll = useCallback(() => setSelected((current) => toggleAllSelectable(current, stableSelectableIds)), [stableSelectableIds]);

  const value = useMemo<SelectionContextValue>(
    () => ({ selecting, selectedIds, selectableIds: stableSelectableIds, toggleMode, toggle, toggleAll, cancel }),
    [selecting, selectedIds, stableSelectableIds, toggleMode, toggle, toggleAll, cancel]
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** Botón «Seleccionar», justo después de «Filtrar». Es un toggle: volver a pulsarlo sale del modo. */
export function ProductSelectToggle() {
  const { selecting, toggleMode } = useSelection();
  return <button
    aria-pressed={selecting}
    className={`rounded-lg border px-4 py-2 text-sm font-bold ${selecting ? "border-sky-700 bg-sky-50 text-sky-900" : "border-stone-300"}`}
    onClick={toggleMode}
    type="button"
  >Seleccionar</button>;
}

/** Celda del encabezado con el checkbox que marca/desmarca los productos visibles (activos) de esta página. */
export function ProductSelectHeaderCell() {
  const { selecting, selectedIds, selectableIds, toggleAll } = useSelection();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const allSelected = selectableIds.length > 0 && selectedIds.length === selectableIds.length;
  const someSelected = selectedIds.length > 0 && !allSelected;
  useEffect(() => { if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected; }, [someSelected, selecting]);
  if (!selecting) return null;
  return <th className="w-10 px-3 py-3">
    <input
      aria-label="Seleccionar todos los productos visibles"
      checked={allSelected}
      className="size-4 cursor-pointer accent-sky-700 disabled:cursor-not-allowed"
      disabled={selectableIds.length === 0}
      onChange={toggleAll}
      ref={checkboxRef}
      title={selectableIds.length === 0 ? "No hay productos activos para seleccionar" : "Seleccionar todos los productos visibles"}
      type="checkbox"
    />
  </th>;
}

/** Fila de producto: agrega la celda del checkbox sólo en modo selección y resalta la fila elegida. */
export function ProductSelectableRow({ productId, productName, selectable, children }: { productId: string; productName: string; selectable: boolean; children: ReactNode }) {
  const { selecting, selectedIds, toggle } = useSelection();
  const checked = selecting && selectedIds.includes(productId);
  return <tr className={`border-b border-stone-100 last:border-0 ${checked ? "bg-sky-50 hover:bg-sky-100" : "bg-white even:bg-[#f8f8f8] hover:bg-[#f0f0f0]"}`}>
    {selecting ? <td className="w-10 px-3 py-3">
      <input
        aria-label={`Seleccionar ${productName}`}
        checked={checked}
        className="size-4 cursor-pointer accent-sky-700 disabled:cursor-not-allowed"
        disabled={!selectable}
        onChange={() => toggle(productId)}
        title={selectable ? undefined : "Ya está inactivo"}
        type="checkbox"
      />
    </td> : null}
    {children}
  </tr>;
}

/** Barra de acciones masivas (con ≥ 1 seleccionado), modal de confirmación y aviso de resultado. */
export function ProductBulkBar({ deactivateAction, emptiedPageHref }: {
  deactivateAction: (productIds: string[]) => Promise<BulkDeactivateState>;
  /** Adónde ir si la desactivación vacía por completo la última página (null = quedarse). */
  emptiedPageHref: string | null;
}) {
  const router = useRouter();
  const { selecting, selectedIds, selectableIds, cancel } = useSelection();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const count = selectedIds.length;

  useEffect(() => { if (selecting) setNotice(null); }, [selecting]);
  useEffect(() => {
    if (carriedNotice === null) return;
    setNotice(carriedNotice);
    carriedNotice = null;
  }, []);
  useEffect(() => { if (count === 0) { setConfirmOpen(false); setError(null); } }, [count]);

  useEffect(() => {
    if (!confirmOpen) return;
    cancelButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) setConfirmOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen, pending]);

  const closeConfirm = () => { if (pending) return; setConfirmOpen(false); setError(null); };

  const confirm = async () => {
    if (pending || count === 0) return;
    const ids = selectedIds;
    setPending(true);
    setError(null);
    try {
      const result = await deactivateAction(ids);
      if (result.error) { setError(result.error); return; }
      const emptiedPage = emptiedPageHref !== null && ids.length === selectableIds.length;
      const successText = deactivateSuccessText(result.deactivated ?? 0, result.alreadyInactive ?? 0);
      setNotice(successText);
      setConfirmOpen(false);
      cancel();
      if (emptiedPage) {
        carriedNotice = successText;
        router.replace(emptiedPageHref);
      }
    } catch {
      // Fallo de red/servidor antes de recibir respuesta: nada se confirmó, la selección se conserva.
      setError("No se pudo completar la desactivación. Revisá la conexión y reintentá; no se modificó ningún producto.");
    } finally {
      setPending(false);
    }
  };

  return <>
    {notice ? <p className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-800" role="status">
      <span>{notice}</span>
      <button aria-label="Cerrar aviso" className="text-lg leading-none text-emerald-700 hover:text-emerald-900" onClick={() => setNotice(null)} type="button">×</button>
    </p> : null}
    {selecting && count === 0 ? <p className="mt-3 text-sm text-stone-500">Marcá los productos que querés desactivar.</p> : null}
    {selecting && count > 0 ? <div aria-label="Acciones masivas" className="sticky top-2 z-30 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm" role="region">
      <p className="text-sm font-bold text-sky-900">{selectedCountLabel(count)}</p>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold" onClick={cancel} type="button">Cancelar</button>
        <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800" onClick={() => setConfirmOpen(true)} type="button">Desactivar productos</button>
      </div>
    </div> : null}
    {confirmOpen && count > 0 ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) closeConfirm(); }}>
      <section aria-describedby="bulk-deactivate-description" aria-labelledby="bulk-deactivate-title" aria-modal="true" className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" role="dialog">
        <h2 className="text-xl font-black" id="bulk-deactivate-title">Desactivar productos</h2>
        <p className="mt-3 text-sm text-stone-700" id="bulk-deactivate-description">{deactivateConfirmationText(count)}</p>
        {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={pending} onClick={closeConfirm} ref={cancelButtonRef} type="button">Cancelar</button>
          <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-60" disabled={pending} onClick={() => { void confirm(); }} type="button">{pending ? "Desactivando…" : `Desactivar ${productCountLabel(count)}`}</button>
        </div>
      </section>
    </div> : null}
  </>;
}
