"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Diálogos abiertos, el último es el de arriba: Escape cierra sólo ese. */
const openDialogs: symbol[] = [];

/**
 * Modal liviano para profundizar desde el Resumen de sucursal (producto, qué llevar, listas completas) SIN salir a otra
 * pantalla. Se apila sobre el detalle de sucursal (z-60 vs. z-50 de `BranchDetailFrame`): Escape y el clic en el fondo
 * cierran sólo este diálogo (el escucha va en la fase de captura, así el marco de la sucursal no ve ese Escape).
 */
export function OverlayDialog({ title, subtitle, onClose, children, wide = false }: {
  title: string;
  subtitle?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    const id = Symbol("overlay");
    openDialogs.push(id);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openDialogs[openDialogs.length - 1] !== id) return;
      event.stopPropagation();
      latestClose.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return <div aria-label={title} aria-modal="true" className="fixed inset-0 z-[60] flex items-center justify-center bg-stone-950/40 p-0 sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="dialog">
    <section className={`flex max-h-dvh w-full ${wide ? "max-w-4xl" : "max-w-2xl"} flex-col overflow-hidden bg-[#f5f4f1] shadow-xl sm:max-h-[90vh] sm:rounded-2xl`}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-stone-200 bg-[#fbfaf8] px-5 py-4">
        <div className="min-w-0"><h2 className="truncate text-lg font-black">{title}</h2>{subtitle ? <p className="truncate text-sm text-stone-500">{subtitle}</p> : null}</div>
        <button aria-label="Cerrar" className="grid size-9 shrink-0 place-items-center rounded-lg text-xl text-stone-600 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800" onClick={onClose} ref={closeButton} type="button">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
    </section>
  </div>;
}
