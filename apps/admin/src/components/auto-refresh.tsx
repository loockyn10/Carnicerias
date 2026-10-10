"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Vuelve a pedir los datos de la página cada `intervalMs` mientras `enabled` (y al volver a la pestaña): sirve para que un costo que sigue
 * corriendo (una fichada abierta) se actualice solo, sin recargar a mano. No dibuja nada. Sólo refresca con la pestaña visible, así una
 * pestaña olvidada en segundo plano no consulta al servidor.
 */
export function AutoRefresh({ intervalMs, enabled = true }: { intervalMs: number; enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refreshIfVisible, intervalMs);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [enabled, intervalMs, router]);
  return null;
}
