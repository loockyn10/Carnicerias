/**
 * Estado de un fichaje en el historial de Horas trabajadas. TODOS los fichajes del período se listan y se pueden anular (D-099), estén
 * cerrados, abiertos o a revisar: la anulación no depende de que el turno esté cerrado ni de que su costo ya figure en la rentabilidad.
 */
export interface HistoryShift {
  status: string;
  voidedAt?: string | null | undefined;
}

export type ShiftHistoryState = "VOIDED" | "CLOSED" | "OPEN" | "REQUIRES_REVIEW";

export function shiftHistoryState(shift: HistoryShift): ShiftHistoryState {
  if (shift.voidedAt) return "VOIDED";
  if (shift.status === "OPEN" || shift.status === "REQUIRES_REVIEW") return shift.status;
  return "CLOSED";
}

export const SHIFT_HISTORY_STATE_LABEL: Record<Exclude<ShiftHistoryState, "CLOSED">, string> = {
  VOIDED: "Anulado · no suma horas ni costo",
  OPEN: "En curso",
  REQUIRES_REVIEW: "A revisar · en el costo cuenta como máximo el turno normal"
};

/** Sólo un fichaje que no está anulado ofrece «Anular fichaje». */
export function canVoidShift(shift: HistoryShift): boolean {
  return shiftHistoryState(shift) !== "VOIDED";
}
