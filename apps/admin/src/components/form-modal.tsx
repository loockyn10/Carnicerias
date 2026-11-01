"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";

export interface FormModalState { error?: string; successToken?: string }

/**
 * Modal de un formulario con Server Action (patrón de proveedores): botón disparador, cierre con Escape / clic afuera, error en línea y cierre
 * automático cuando la acción devuelve `successToken`. Lo usan Pollos y Envasados para sus altas/ediciones.
 */
export function FormModal({
  triggerLabel, triggerClassName, title, description, action, submitLabel, children, wide = false
}: {
  triggerLabel: string;
  triggerClassName?: string | undefined;
  title: string;
  description?: string | undefined;
  action: (state: FormModalState, formData: FormData) => Promise<FormModalState>;
  submitLabel: string;
  children: ReactNode;
  wide?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, {} as FormModalState);

  useEffect(() => { if (state.successToken) setOpen(false); }, [state.successToken]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [open, pending]);

  return <>
    <button className={triggerClassName ?? "rounded-lg border px-3 py-2 text-sm font-bold"} onClick={() => { setOpen(true); }} type="button">{triggerLabel}</button>
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !pending) setOpen(false); }}>
      <section aria-modal="true" className={`max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white p-5 text-left shadow-xl ${wide ? "max-w-3xl" : "max-w-lg"}`} role="dialog">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-xl font-black">{title}</h2>{description ? <p className="mt-1 text-sm text-stone-600">{description}</p> : null}</div>
          <button aria-label="Cerrar" className="text-xl text-stone-500 hover:text-stone-900" disabled={pending} onClick={() => { setOpen(false); }} type="button">×</button>
        </div>
        <form action={formAction} className="mt-5 grid gap-3">
          {children}
          {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{state.error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-bold text-stone-600" disabled={pending} onClick={() => { setOpen(false); }} type="button">Cancelar</button>
            <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : submitLabel}</button>
          </div>
        </form>
      </section>
    </div> : null}
  </>;
}

export const fieldInput = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
export const fieldLabel = "grid gap-1 text-sm font-medium";
export const optionalHint = "text-xs font-normal text-stone-500";
