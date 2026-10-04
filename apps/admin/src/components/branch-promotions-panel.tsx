"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { saveBranchPromotionFormAction, type PromotionFormState } from "../app/admin/actions";
import { describeBranchPromotion } from "../lib/unit-promotions";
import { StatusBadge } from "./admin-ui";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export interface BranchPromotionRow {
  branchId: string;
  branchName: string;
  /** Promoción vigente de la sucursal, o null si no tiene ninguna. */
  promotion: { minimumUnits: number; discountBps: number } | null;
}

/**
 * Promoción global por sucursal: "desde N unidades del MISMO producto, X % de descuento sobre TODAS esas unidades" para todos los
 * productos que se venden por unidad de esa sucursal, sin crear una promoción por producto. Una sola vigente por sucursal;
 * editarla guarda una versión nueva (las ventas ya hechas conservan la regla que usaron).
 */
export function BranchPromotionsPanel({ rows }: { rows: BranchPromotionRow[] }) {
  const [editing, setEditing] = useState<BranchPromotionRow | null>(null);
  return <section className="mt-6 rounded-xl bg-white p-5 shadow-sm" data-testid="branch-promotions">
    <h2 className="text-xl font-black">Promoción por sucursal</h2>
    <p className="mt-1 text-sm text-stone-600">
      Se aplica a todos los productos por unidad de la sucursal: desde N unidades del <strong>mismo</strong> producto, X% de descuento sobre <strong>todas</strong> las unidades de esa línea (productos distintos no se suman).
      No se acumula con un Pack (con el descuento propio de cada producto), con una promoción propia del producto ni con un precio manual: manda un solo descuento por línea.
    </p>
    <ul className="mt-4 divide-y">
      {rows.map((row) => (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.branchId}>
          <div>
            <p className="font-bold">{row.branchName}</p>
            <p className="text-sm text-stone-600">{row.promotion ? describeBranchPromotion(row.promotion.minimumUnits, row.promotion.discountBps) : "Sin promoción por sucursal"}</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge tone={row.promotion ? "success" : "neutral"}>{row.promotion ? "Activa" : "Sin promoción"}</StatusBadge>
            <button className="rounded-lg border px-3 py-2 text-sm font-bold" onClick={() => setEditing(row)} type="button">{row.promotion ? "Editar" : "Crear"}</button>
          </div>
        </li>
      ))}
      {!rows.length ? <li className="py-4 text-sm text-stone-500">No hay sucursales activas.</li> : null}
    </ul>
    {editing ? <BranchPromotionModal key={editing.branchId} onClose={() => setEditing(null)} row={editing} /> : null}
  </section>;
}

function BranchPromotionModal({ row, onClose }: { row: BranchPromotionRow; onClose: () => void }) {
  const [state, action, pending] = useActionState(saveBranchPromotionFormAction, {} as PromotionFormState);
  const formRef = useRef<HTMLFormElement>(null);
  const activeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.successToken) onClose();
  }, [state.successToken, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  const retire = () => {
    if (!window.confirm("¿Desactivar la promoción de esta sucursal? Las ventas ya hechas conservan el descuento que tuvieron.")) return;
    if (activeRef.current) activeRef.current.checked = false;
    formRef.current?.requestSubmit();
  };

  return <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) onClose(); }}>
    <section aria-modal="true" className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" role="dialog">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xl font-black">{row.promotion ? "Editar" : "Crear"} promoción — {row.branchName}</h3>
        <button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={onClose} type="button">×</button>
      </div>
      <form action={action} className="mt-5 grid gap-3" ref={formRef}>
        <input name="branch_id" type="hidden" value={row.branchId} />
        <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-700">Alcance: <strong>todos los productos por unidad</strong> de {row.branchName}.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">Desde (unidades del mismo producto)
            <input className={input} defaultValue={row.promotion?.minimumUnits ?? 3} inputMode="numeric" max="1000" min="2" name="minimum_units" required step="1" type="number" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Descuento (%)
            <input className={input} defaultValue={row.promotion ? String(row.promotion.discountBps / 100) : "15"} inputMode="decimal" max="99.99" min="0.01" name="discount_percent" required step="0.01" type="number" />
          </label>
        </div>
        <p className="text-xs text-stone-500">Ejemplo: desde 3, 15% → 1 o 2 unidades no tienen descuento; con 3, 4, 5 u 8 unidades iguales, todas se cobran con 15% menos. Una sola promoción vigente por sucursal.</p>
        <label className="flex items-center gap-2 text-sm"><input defaultChecked name="active" ref={activeRef} type="checkbox" /> Promoción activa</label>
        {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div>{row.promotion ? <button className="text-sm font-bold text-red-700 disabled:opacity-50" disabled={pending} onClick={retire} type="button">Desactivar</button> : null}</div>
          <div className="flex gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={onClose} type="button">Cancelar</button>
            <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      </form>
    </section>
  </div>;
}
