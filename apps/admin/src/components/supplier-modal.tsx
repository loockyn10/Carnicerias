"use client";

import { useActionState, useEffect, useState } from "react";

import { saveSupplierFormAction, setSupplierActiveFormAction, type SupplierFormState } from "../app/admin/actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

export interface SupplierView {
  id: string;
  name: string;
  code: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
}

/**
 * Alta / edición de un proveedor. Sólo el nombre es obligatorio (SimplyGest puede no traer CUIT,
 * teléfono, etc.). Sin cuentas corrientes, pagos ni órdenes de compra: este módulo es la base de
 * proveedores y su vínculo con productos.
 */
export function SupplierModal({ supplier }: { supplier?: SupplierView }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(saveSupplierFormAction, {} as SupplierFormState);

  useEffect(() => { if (state.successToken) setOpen(false); }, [state.successToken]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  return <>
    {supplier
      ? <button className="rounded-lg border px-3 py-2 text-sm font-bold" onClick={() => setOpen(true)} type="button">Editar</button>
      : <button className="rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900" onClick={() => setOpen(true)} type="button">+ Nuevo proveedor</button>}
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) setOpen(false); }}>
      <section aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 text-left shadow-xl" role="dialog">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-xl font-black">{supplier ? `Editar proveedor — ${supplier.name}` : "Nuevo proveedor"}</h2><p className="mt-1 text-sm text-stone-600">Sólo el nombre es obligatorio.</p></div>
          <button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={() => setOpen(false)} type="button">×</button>
        </div>
        <form action={action} className="mt-5 grid gap-3">
          {supplier ? <input name="supplier_id" type="hidden" value={supplier.id} /> : null}
          <label className="grid gap-1 text-sm font-medium">Nombre<input autoFocus className={input} defaultValue={supplier?.name ?? ""} maxLength={120} name="name" required /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium">Código <span className="text-xs font-normal text-stone-500">opcional · p. ej. el de SimplyGest</span><input className={input} defaultValue={supplier?.code ?? ""} maxLength={60} name="code" /></label>
            <label className="grid gap-1 text-sm font-medium">CUIT <span className="text-xs font-normal text-stone-500">opcional</span><input className={input} defaultValue={supplier?.taxId ?? ""} maxLength={40} name="tax_id" /></label>
            <label className="grid gap-1 text-sm font-medium">Teléfono <span className="text-xs font-normal text-stone-500">opcional</span><input className={input} defaultValue={supplier?.phone ?? ""} maxLength={60} name="phone" type="tel" /></label>
            <label className="grid gap-1 text-sm font-medium">Email <span className="text-xs font-normal text-stone-500">opcional</span><input className={input} defaultValue={supplier?.email ?? ""} maxLength={160} name="email" type="email" /></label>
          </div>
          <label className="grid gap-1 text-sm font-medium">Notas <span className="text-xs font-normal text-stone-500">opcional</span><textarea className={input} defaultValue={supplier?.notes ?? ""} maxLength={1000} name="notes" rows={3} /></label>
          <label className="flex items-center gap-2 text-sm"><input defaultChecked={supplier?.active ?? true} name="active" type="checkbox" /> Proveedor activo</label>
          {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={() => setOpen(false)} type="button">Cancelar</button>
            <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : supplier ? "Guardar cambios" : "Crear proveedor"}</button>
          </div>
        </form>
      </section>
    </div> : null}
  </>;
}

/** Activar / desactivar sin borrar: el proveedor conserva sus productos y deja de ofrecerse al asignarlo. */
export function SupplierActiveToggle({ supplier }: { supplier: Pick<SupplierView, "id" | "name" | "active"> }) {
  const [state, action, pending] = useActionState(setSupplierActiveFormAction, {} as SupplierFormState);
  return <form action={action} className="inline" onSubmit={(event) => {
    if (supplier.active && !window.confirm(`¿Desactivar a ${supplier.name}?\nSus productos conservan el proveedor; sólo deja de ofrecerse para asignarlo a otros.`)) event.preventDefault();
  }}>
    <input name="supplier_id" type="hidden" value={supplier.id} />
    {supplier.active ? null : <input name="active" type="hidden" value="on" />}
    <button className={`rounded-lg border px-3 py-2 text-sm font-bold disabled:opacity-50 ${supplier.active ? "text-red-700" : "text-emerald-700"}`} disabled={pending}>{supplier.active ? "Desactivar" : "Activar"}</button>
    {state.error ? <span className="ml-2 text-xs text-red-700" role="alert">{state.error}</span> : null}
  </form>;
}
