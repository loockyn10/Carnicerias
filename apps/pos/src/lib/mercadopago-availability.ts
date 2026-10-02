/**
 * Disponibilidad del botón "Mercado Pago" y diagnóstico de POR QUÉ no aparece. Lógica pura: sin
 * red, sin Supabase, sin Tauri, sin React (se prueba sin credenciales).
 */

/** Resultado de `mp_get_branch_config`, sin tragarse el error: el motivo llega hasta el diagnóstico. */
export type MercadoPagoConfigResult =
  | { status: "ok"; enabled: boolean; manualTransferAllowed: boolean }
  | { status: "error"; code: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Interpreta la respuesta de la RPC. Si el servidor contesta por OTRA sucursal que la de este
 * dispositivo (`expectedBranchId`), no se confía en la respuesta. Un error se conserva con su código y
 * mensaje (datos de PostgREST: nunca llevan secretos).
 */
export function parseBranchConfigResponse(
  data: unknown,
  error: { code?: string | null; message?: string | null } | null,
  expectedBranchId: string | null
): MercadoPagoConfigResult {
  if (error) return { status: "error", code: error.code ?? "ERROR", message: error.message ?? "Error desconocido" };
  const record = asRecord(data);
  if (!record || typeof record.enabled !== "boolean") {
    return { status: "error", code: "BAD_RESPONSE", message: "Respuesta inesperada de mp_get_branch_config" };
  }
  if (expectedBranchId && typeof record.branchId === "string" && record.branchId !== expectedBranchId) {
    return { status: "error", code: "BRANCH_MISMATCH", message: "La configuración recibida es de otra sucursal" };
  }
  // Un servidor que todavía no informa la política sigue permitiendo la transferencia manual (no hay
  // forma de que la prohíba); sólo un `false` explícito la esconde.
  const manualTransferAllowed = typeof record.manualTransferAllowed === "boolean" ? record.manualTransferAllowed : true;
  return { status: "ok", enabled: record.enabled, manualTransferAllowed };
}

/**
 * ¿Se ofrece el botón "Transferencia" (manual) en el POS? Una sucursal con Mercado Pago habilitado y
 * obligatorio (`manualTransferAllowed === false`, que decide el servidor por configuración de sucursal,
 * nunca por nombre) cobra lo digital sólo con Mercado Pago verificado. Sin información (nunca
 * consultado) se mantiene el comportamiento de siempre; el servidor rechaza igual lo que no corresponda.
 */
export function isManualTransferOffered(input: { mercadoPagoEnabled: boolean | null; manualTransferAllowed: boolean | null }): boolean {
  return !(input.mercadoPagoEnabled === true && input.manualTransferAllowed === false);
}

export type MercadoPagoUnavailableReason =
  | "NOT_DESKTOP"
  | "NO_DEVICE"
  | "NO_USER"
  | "SESSION_NOT_ONLINE"
  | "OFFLINE"
  | "NOT_ENABLED"
  | "LOOKUP_FAILED"
  | "NOT_CHECKED_YET";

export interface MercadoPagoAvailability {
  /** El botón existe en pantalla (la sucursal tiene Mercado Pago habilitado, aunque hoy no se pueda usar). */
  visible: boolean;
  /** El botón se puede usar ahora (hay Internet y sesión técnica real). */
  usable: boolean;
  reason: MercadoPagoUnavailableReason | null;
  /** Texto para el diagnóstico del POS (sin datos sensibles). */
  explanation: string;
}

const EXPLANATIONS: Record<MercadoPagoUnavailableReason, string> = {
  NOT_DESKTOP: "Sólo disponible en el POS de escritorio.",
  NO_DEVICE: "Todavía no se leyó el dispositivo local.",
  NO_USER: "Sin sesión técnica: la caja necesita configuración.",
  SESSION_NOT_ONLINE: "La caja funciona con la autorización en caché, sin sesión técnica en línea: no sincroniza ni puede consultar Mercado Pago. Reconectá la caja con la cuenta técnica.",
  OFFLINE: "Sin conexión a Internet: Mercado Pago requiere conexión.",
  NOT_ENABLED: "Mercado Pago no está habilitado para esta sucursal.",
  LOOKUP_FAILED: "No se pudo consultar la configuración de Mercado Pago de esta sucursal.",
  NOT_CHECKED_YET: "Todavía no se consultó la configuración de Mercado Pago de esta sucursal."
};

/**
 * Decide si el botón se ve y si se puede usar, con el motivo. `knownEnabled` es lo último que se
 * supo de la sucursal (servidor o caché local): `true` / `false` / `null` (nunca consultado). Visible
 * aun sin conexión cuando ya se sabe que la sucursal lo tiene (queda deshabilitado), para que un
 * reinicio offline no haga desaparecer el medio de pago.
 */
export function resolveMercadoPagoAvailability(input: {
  desktop: boolean;
  hasDevice: boolean;
  hasUser: boolean;
  sessionOffline: boolean;
  browserOnline: boolean;
  knownEnabled: boolean | null;
  lookupFailed: boolean;
}): MercadoPagoAvailability {
  const result = (visible: boolean, usable: boolean, reason: MercadoPagoUnavailableReason | null): MercadoPagoAvailability => ({
    visible, usable, reason, explanation: reason ? EXPLANATIONS[reason] : "Disponible."
  });
  if (!input.desktop) return result(false, false, "NOT_DESKTOP");
  if (!input.hasDevice) return result(false, false, "NO_DEVICE");
  if (!input.hasUser) return result(false, false, "NO_USER");
  if (input.knownEnabled === false) return result(false, false, "NOT_ENABLED");
  const visible = input.knownEnabled === true;
  if (input.sessionOffline && input.browserOnline) return result(visible, false, "SESSION_NOT_ONLINE");
  if (!input.browserOnline) return result(visible, false, "OFFLINE");
  if (!visible) return result(false, false, input.lookupFailed ? "LOOKUP_FAILED" : "NOT_CHECKED_YET");
  return result(true, true, null);
}

/**
 * La caja está "degradada": hay Internet pero la sesión técnica de Supabase no se pudo restaurar
 * (p. ej. `tauri dev` sirve la app desde otro origen que la instalada y no ve la sesión guardada).
 * Corre con la autorización en caché: vende, pero no sincroniza ni puede cobrar con Mercado Pago.
 */
export function isSessionDegraded(input: { desktop: boolean; sessionOffline: boolean; browserOnline: boolean }): boolean {
  return input.desktop && input.sessionOffline && input.browserOnline;
}
