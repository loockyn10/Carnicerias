"use client";

import { voidShiftAction } from "../app/admin/actions";

/** Mensaje del cuadro de confirmación (exportado para probar que nombra a la persona y aclara el efecto). */
export function voidShiftConfirmMessage(employeeName: string, clockInLabel: string): string {
  return `¿Anular el fichaje de ${employeeName} con entrada ${clockInLabel}?\n\nSe conserva en el historial, pero deja de sumar horas y costo laboral (la rentabilidad de la sucursal se recalcula sola). No se puede deshacer.`;
}

/** Anulación de un fichaje incorrecto: motivo obligatorio + confirmación antes de enviar. El empleado y sus ventas no se tocan. */
export function VoidShiftForm({ shiftId, employeeName, clockInLabel, compact = false }: { shiftId: string; employeeName: string; clockInLabel: string; compact?: boolean }) {
  return <form
    action={voidShiftAction}
    className={compact ? "flex flex-wrap items-center gap-2" : "mt-2 grid gap-2 sm:grid-cols-[2fr_auto]"}
    onSubmit={(event) => {
      if (!window.confirm(voidShiftConfirmMessage(employeeName, clockInLabel))) event.preventDefault();
    }}
  >
    <input name="shift_id" type="hidden" value={shiftId} />
    <input
      aria-label={`Motivo para anular el fichaje de ${employeeName}`}
      className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
      maxLength={500}
      minLength={3}
      name="reason"
      placeholder="Motivo de la anulación (obligatorio)"
      required
    />
    <button className="rounded-lg border border-red-800 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50" type="submit">Anular fichaje</button>
  </form>;
}
