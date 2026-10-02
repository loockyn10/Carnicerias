import type { PaymentVerificationStatus } from "@carnicerias/business-logic";

import { deriveLocalVerification, type MercadoPagoActionResult } from "./mercadopago-state";

/**
 * Reconciliación de los cobros Mercado Pago que quedaron pendientes en este equipo (la caja se cerró,
 * se cortó Internet o se reinició mientras esperaba el pago). Pregunta al BACKEND por cada uno
 * (`mp-order-status`, que consulta a Mercado Pago) y refleja el resultado en el caché local; el POS no
 * decide nada. Así un cobro que venció o se canceló mientras el POS estaba cerrado converge al mismo
 * resultado que si el webhook lo hubiera informado: sale de "MP pendientes" y su venta queda anulada.
 *
 * Lógica pura (dependencias inyectadas): se prueba sin red, sin SQLite y sin credenciales.
 */

export interface PendingLocalPayment {
  saleId: string;
  /** Hora de la venta (ISO): decide si un cobro sin orden viva ya es "viejo". */
  completedAt: string;
}

export interface ReconcileDeps {
  list: () => Promise<PendingLocalPayment[]>;
  fetchStatus: (saleId: string) => Promise<MercadoPagoActionResult>;
  /** `mp-cancel-order`: sin cobro vivo, anula en el servidor la venta que nunca se pagó (idempotente). */
  cancelUnpaid: (saleId: string) => Promise<MercadoPagoActionResult>;
  mirror: (saleId: string, status: PaymentVerificationStatus) => Promise<unknown>;
  nowMs: number;
  /** Una venta pendiente más vieja que esto y SIN cobro vivo se da por abandonada (no se acreditará). */
  abandonedAfterMs: number;
}

export interface ReconcileSummary {
  checked: number;
  /** Cobros que dejaron de estar pendientes (pagados, cancelados, vencidos, anulados). */
  resolved: number;
}

const TERMINAL: readonly PaymentVerificationStatus[] = ["CONFIRMED", "CANCELLED", "EXPIRED", "MISMATCH", "REFUNDED"];

export async function reconcilePendingMercadoPago(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const pending = await deps.list();
  let resolved = 0;
  for (const payment of pending) {
    const result = await deps.fetchStatus(payment.saleId);
    // Sin respuesta del servidor (sin red, sin sesión): no se concluye nada; se reintenta más tarde.
    if (!result.ok) continue;

    let order = result.order;
    const age = deps.nowMs - Date.parse(payment.completedAt);
    const hasLiveCharge = order?.status === "CREATED" || order?.status === "REQUESTING" || order?.status === "CONFIRMED";
    if (!hasLiveCharge && Number.isFinite(age) && age > deps.abandonedAfterMs) {
      const abandoned = await deps.cancelUnpaid(payment.saleId);
      if (abandoned.ok && abandoned.order) order = abandoned.order;
    }

    const verification = deriveLocalVerification(order);
    if (order && verification !== "PENDING") {
      await deps.mirror(payment.saleId, verification);
      if (TERMINAL.includes(verification)) resolved += 1;
    }
  }
  return { checked: pending.length, resolved };
}
