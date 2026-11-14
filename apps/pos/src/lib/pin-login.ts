/**
 * Ingreso del operador con PIN: servidor primero, autorización local como respaldo.
 *
 * Reglas (no cambian el modelo de seguridad existente):
 *   - Con sesión técnica en línea se valida contra `verify_pos_operator_pin`. Si el servidor responde
 *     `ok:false` (PIN incorrecto, empleado revocado, bloqueo) NUNCA se prueba el verificador local:
 *     el servidor manda.
 *   - Sólo si la validación en línea no pudo completarse por la infraestructura (JWT vencido que no
 *     se pudo renovar, sesión inválida o sin conexión con Supabase) se usa `verify_local_operator`,
 *     que exige verificador salado + `grant_valid_until` vigente + bloqueo por intentos fallidos.
 *     Sin una validación en línea previa de ese empleado no hay acceso (no existe atajo).
 *   - Un error que no es de infraestructura (p. ej. 42501, función inexistente) se muestra tal cual.
 */
import { classifyAuthFailure, isRecoverableWithLocalAuthorization, type AuthFailureKind } from "./session-recovery";

/**
 * Tope de espera de la validación en línea. Con `navigator.onLine === true` pero sin llegar a Supabase
 * (router sin salida, DNS caído) supabase-js reintenta la renovación del token con backoff hasta ~25 s:
 * el cajero no debe mirar "Validando…" todo ese tiempo antes de poder usar su autorización local.
 */
export const ONLINE_PIN_TIMEOUT_MS = 8_000;

export interface PinLoginDeps<TOperator, TVerified> {
  /** Tope de espera de `verifyOnline` en ms (por defecto `ONLINE_PIN_TIMEOUT_MS`). */
  timeoutMs?: number;
  online: boolean;
  /** `rpc("verify_pos_operator_pin")`: devuelve el payload o lanza el error de Supabase. */
  verifyOnline: () => Promise<TVerified & { ok: boolean; message?: string }>;
  /** Guarda el verificador/grant devuelto por el servidor y entrega el operador local. */
  cacheVerified: (verified: TVerified) => Promise<TOperator>;
  /** `verify_local_operator`: valida contra SQLite. */
  verifyLocal: () => Promise<TOperator>;
}

export interface PinLoginResult<TOperator> {
  operator: TOperator;
  via: "server" | "local";
  /** Por qué se usó la autorización local estando "en línea" (null si no hubo respaldo). */
  fallbackReason: AuthFailureKind | null;
}

export const LOCAL_FALLBACK_NOTICE = "Sin servidor: ingreso con autorización local";

const NEEDS_ONLINE_PIN = "Este empleado debe validar su PIN online nuevamente";

function reasonText(kind: AuthFailureKind): string {
  return kind === "connectivity"
    ? "No hay conexión con el servidor"
    : "La sesión de la caja con el servidor venció y no se pudo renovar";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tiempo de espera agotado al validar el PIN con el servidor (timed out)")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      // Se conserva el error ORIGINAL (objeto plano de PostgREST con `code`) para poder clasificarlo.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

export async function authenticateOperatorPin<TOperator, TVerified>(deps: PinLoginDeps<TOperator, TVerified>): Promise<PinLoginResult<TOperator>> {
  if (!deps.online) {
    return { operator: await deps.verifyLocal(), via: "local", fallbackReason: null };
  }

  let verified: TVerified & { ok: boolean; message?: string };
  try {
    verified = await withTimeout(deps.verifyOnline(), deps.timeoutMs ?? ONLINE_PIN_TIMEOUT_MS);
  } catch (error) {
    const kind = classifyAuthFailure(error);
    if (!isRecoverableWithLocalAuthorization(kind)) throw error;
    try {
      return { operator: await deps.verifyLocal(), via: "local", fallbackReason: kind };
    } catch (localError) {
      const localMessage = localError instanceof Error ? localError.message : typeof localError === "string" ? localError : "";
      // Sin grant local vigente para este empleado: explicar la causa real en lugar de "JWT expired".
      if (localMessage.includes(NEEDS_ONLINE_PIN)) {
        throw new Error(`${reasonText(kind)} y este empleado no tiene una validación reciente guardada en la caja. Con Internet, volvé a intentar o reconectá la caja.`);
      }
      throw localError;
    }
  }

  if (!verified.ok) throw new Error(verified.message ?? "PIN incorrecto");
  return { operator: await deps.cacheVerified(verified), via: "server", fallbackReason: null };
}
