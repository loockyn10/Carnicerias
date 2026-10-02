/**
 * Memoria local de "esta sucursal cobra con Mercado Pago" (la decide el servidor con
 * `mp_get_branch_config`). Misma idea que la capacidad de alta rápida (quick-product.ts): se recuerda
 * por dispositivo+sucursal para que el botón siga viéndose (deshabilitado) tras un reinicio sin
 * Internet. Sin dato recordado => `null` ("nunca consultado"), nunca un "sí" inventado. Jamás habilita
 * un cobro por sí sola: iniciar uno vuelve a validar todo en el servidor.
 */
const KEY = "pos.mercadopago.enabled";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface Memory { deviceId: string; branchId: string; enabled: boolean }

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readMercadoPagoEnabled(deviceId: string | null, branchId: string | null, storage: StorageLike | null = defaultStorage()): boolean | null {
  if (!deviceId || !branchId || !storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(KEY) ?? "null") as Partial<Memory> | null;
    if (parsed?.deviceId !== deviceId || parsed.branchId !== branchId || typeof parsed.enabled !== "boolean") return null;
    return parsed.enabled;
  } catch {
    return null;
  }
}

export function writeMercadoPagoEnabled(deviceId: string, branchId: string, enabled: boolean, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify({ deviceId, branchId, enabled } satisfies Memory));
  } catch {
    // Almacenamiento bloqueado/lleno: simplemente no se recuerda.
  }
}
