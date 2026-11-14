/**
 * Fichaje de empleados (entrada/salida/turnos) por sucursal.
 *
 * El servidor decide si una sucursal lleva fichaje (`branches.timekeeping_enabled`, expuesto por
 * `get_pos_device_capabilities.timekeepingEnabled`); acá sólo se recuerda por sucursal, igual que la
 * capacidad de alta rápida (quick-product.ts) y Mercado Pago, para que la caja se comporte igual sin
 * conexión y después de reiniciar.
 *
 * Regla de seguridad: sin dato recordado (primer arranque sin sync, servidor anterior a la migración)
 * se asume que la sucursal SÍ lleva fichaje, es decir, el comportamiento histórico. Jamás se
 * desactiva el fichaje por una suposición local. El PIN y la sesión del operador no dependen de esto.
 */
const TIMEKEEPING_KEY = "pos.timekeepingEnabled";
/** Cambia sólo si Admin reconfigura la sucursal: se vuelve a preguntar como mucho cada 6 h. */
export const TIMEKEEPING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface TimekeepingMemory { branchId: string; enabled: boolean; checkedAt: number }

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readMemory(storage: StorageLike | null): TimekeepingMemory | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(TIMEKEEPING_KEY) ?? "null") as Partial<TimekeepingMemory> | null;
    if (!parsed || typeof parsed.branchId !== "string" || typeof parsed.enabled !== "boolean") return null;
    return { branchId: parsed.branchId, enabled: parsed.enabled, checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : 0 };
  } catch {
    return null;
  }
}

/** true = la sucursal lleva fichaje. Sólo un `false` recordado PARA ESTA sucursal lo apaga. */
export function readTimekeepingEnabled(branchId: string | null, storage: StorageLike | null = defaultStorage()): boolean {
  if (!branchId) return true;
  const memory = readMemory(storage);
  return !(memory?.branchId === branchId && !memory.enabled);
}

export function writeTimekeepingEnabled(branchId: string, enabled: boolean, storage: StorageLike | null = defaultStorage(), now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(TIMEKEEPING_KEY, JSON.stringify({ branchId, enabled, checkedAt: now } satisfies TimekeepingMemory));
  } catch {
    // Almacenamiento bloqueado/lleno: simplemente no se recuerda (queda el comportamiento histórico: con fichaje).
  }
}

/** True si hay que volver a preguntarle al servidor: nada recordado para esta sucursal, o vencido. */
export function shouldRefreshTimekeeping(branchId: string, storage: StorageLike | null = defaultStorage(), now = Date.now()): boolean {
  if (!storage) return false;
  const memory = readMemory(storage);
  return memory?.branchId !== branchId || now - memory.checkedAt > TIMEKEEPING_MAX_AGE_MS;
}

/** Lectura tipada del campo de la RPC. Un servidor anterior a la migración no lo trae: `null` = no informado. */
export function parseTimekeepingCapability(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Tras validar el PIN: ¿hay que exigir "Marcar entrada"? Sólo con fichaje y sin turno vigente. */
export function clockInRequiredAfterLogin(timekeepingEnabled: boolean, hasShift: boolean): boolean {
  return timekeepingEnabled && !hasShift;
}

/**
 * Qué hace "Salir"/cerrar la ventana con el operador activo. `CLOSE_SHIFT` registra la salida del turno
 * (comportamiento histórico); `RELEASE_ONLY` sólo suelta al operador local: en una sucursal sin fichaje
 * nunca se encola un CLOCK_OUT (el servidor no tiene turno que cerrar).
 */
export function operatorExitMode(timekeepingEnabled: boolean): "CLOSE_SHIFT" | "RELEASE_ONLY" {
  return timekeepingEnabled ? "CLOSE_SHIFT" : "RELEASE_ONLY";
}
