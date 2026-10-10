"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useState } from "react";

import { linesLabel } from "../lib/missing-costs";
import { MissingCostsModal } from "./missing-costs-modal";

/**
 * Aviso del Resumen de sucursal («N líneas sin costo conocido») convertido en acción: al hacer clic abre el modal «Completar costos
 * faltantes» sobre el MISMO período y sucursal. Se monta siempre que haya rentabilidad: si se completan todas las líneas el aviso
 * desaparece pero el modal sigue abierto (con su confirmación) hasta que se cierra.
 */
export function MissingCostsNotice({ branchId, branchName, from, to, timeZone, missingItems, missingRevenueCents }: {
  branchId: string; branchName: string; from: string; to: string; timeZone: string; missingItems: number; missingRevenueCents: number;
}) {
  const [open, setOpen] = useState(false);
  return <>
    {missingItems > 0 ? <div className="self-center sm:col-span-2 lg:col-span-1" role="status">
      <button aria-haspopup="dialog" className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-800 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800" onClick={() => setOpen(true)} type="button">
        <span className="block font-bold">⚠ {linesLabel(missingItems)} sin costo conocido</span>
        <span className="block">{formatCurrency(BigInt(missingRevenueCents))} vendidos fuera de la ganancia</span>
        <span className="mt-1 block font-bold text-rose-800 underline">Completar costos</span>
      </button>
    </div> : null}
    {open ? <MissingCostsModal branchId={branchId} branchName={branchName} from={from} onClose={() => setOpen(false)} timeZone={timeZone} to={to} /> : null}
  </>;
}
