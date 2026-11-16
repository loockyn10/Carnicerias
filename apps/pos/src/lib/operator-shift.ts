import type { LocalShift } from "./local-database";

/**
 * Turno laboral del operador al ingresar (y al sincronizar). D-098: el POS de CENTRAL NO USA FICHAJES: el ingreso es seleccionar empleado →
 * PIN → entrar; no se busca, crea ni reconcilia ningún turno (ni en SQLite ni en el servidor) y la falta de turno nunca bloquea nada.
 * En las demás sucursales el comportamiento es el de siempre (D-024).
 */

export interface OperatorShiftDeps {
  /** Lo que la UI ya sabe de la capacidad de Central (`centralPos`). */
  centralHint: boolean;
  /** La fuente de verdad local: la misma bandera de SQLite que gatea el cierre de sesión, el heartbeat y la sincronización. */
  timekeepingDisabled: () => Promise<boolean>;
  currentShift: (employeeId: string) => Promise<LocalShift | null>;
  applyServerShift: (shift: LocalShift) => Promise<void>;
  clearReconciledShift: (employeeId: string) => Promise<void>;
  /** Consulta el turno abierto en el servidor (RPC `get_current_employee_shift`). */
  remoteShift: () => Promise<{ data: unknown; error: Error | null }>;
  /** Errores del servidor que NO bloquean el ingreso (auth vencida / sin conexión): se sigue con el turno local. Por defecto ninguno. */
  tolerateRemoteError?: ((error: Error) => boolean) | undefined;
  /** Hay Internet y sesión online con token de operador: recién ahí se consulta el servidor. */
  canQueryRemote: boolean;
}

export interface OperatorShiftResult {
  /** false = Central: no hay fichaje (ni se pide «Marcar entrada»). */
  timekeeping: boolean;
  shift: LocalShift | null;
}

export async function loadOperatorShift(employeeId: string, deps: OperatorShiftDeps): Promise<OperatorShiftResult> {
  if (deps.centralHint || (await deps.timekeepingDisabled())) return { timekeeping: false, shift: null };
  let current = await deps.currentShift(employeeId);
  if (deps.canQueryRemote) {
    const { data, error } = await deps.remoteShift();
    // Sólo lectura: ante un error tolerable (servidor inalcanzable, sesión técnica vencida) manda el turno local y no se reconcilia nada.
    if (error && !deps.tolerateRemoteError?.(error)) throw error;
    if (!error) {
      if (data) {
        const remote = data as Omit<LocalShift, "employeeId">;
        current = { ...remote, employeeId };
        await deps.applyServerShift(current);
      } else {
        await deps.clearReconciledShift(employeeId);
        current = await deps.currentShift(employeeId);
      }
    }
  }
  return { timekeeping: true, shift: current };
}
