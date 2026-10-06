"use client";

import { useEffect, useState } from "react";

import { PricingConfigForm } from "./pricing-config-form";

type FormProps = Parameters<typeof PricingConfigForm>[0];

/** Configuración de precios detrás de un botón: la página queda compacta y el formulario (sin cambios) vive en el modal. */
export function PricingConfigModal(props: FormProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return <>
    <button className="mt-3 rounded-lg bg-rose-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-rose-900" onClick={() => setOpen(true)} type="button">Configuración de precios</button>
    {open ? <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section aria-labelledby="pricing-config-title" aria-modal="true" className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-xl" role="dialog">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h2 className="text-xl font-black" id="pricing-config-title">Configuración de precios</h2>
          <button aria-label="Cerrar" className="rounded-lg px-2 py-1 text-lg font-bold text-stone-500 hover:text-stone-900" onClick={() => setOpen(false)} type="button">✕</button>
        </div>
        <div className="overflow-y-auto px-5 pb-5">
          <p className="mt-3 text-sm text-stone-600">Valores de toda la organización. El precio de lista se forma desde el costo: costo ÷ (1 − margen).</p>
          <PricingConfigForm {...props} />
        </div>
      </section>
    </div> : null}
  </>;
}
