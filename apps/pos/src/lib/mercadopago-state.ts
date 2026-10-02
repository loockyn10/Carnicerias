import type { MercadoPagoOrderStatus, PaymentVerificationStatus } from "@carnicerias/business-logic";

/**
 * Vista del cobro Mercado Pago de una venta tal como la informa el BACKEND (Edge Functions). El POS
 * nunca decide ni "promueve" un estado: sólo normaliza lo que el servidor devolvió. Pura: sin red,
 * sin Supabase, sin Tauri (por eso se puede probar sin credenciales).
 */
export interface MercadoPagoOrderState {
  saleId: string;
  attempt: number | null;
  status: MercadoPagoOrderStatus | null;
  verificationStatus: PaymentVerificationStatus | null;
  expectedAmountCents: number | null;
  confirmedAmountCents: number | null;
  amountMismatch: boolean;
  expiresAt: string | null;
}

export type MercadoPagoActionResult =
  | { ok: true; order: MercadoPagoOrderState | null }
  | { ok: false; code: string; message: string; order: MercadoPagoOrderState | null };

/** Cada cuánto el panel consulta el estado mientras espera el pago. */
export const MERCADOPAGO_POLL_INTERVAL_MS = 3_000;

const ORDER_STATUSES: readonly string[] = ["REQUESTING", "CREATED", "CONFIRMED", "EXPIRED", "CANCELLED", "REFUNDED", "ERROR"];
const VERIFICATION_STATUSES: readonly string[] = ["NOT_REQUIRED", "PENDING", "CONFIRMED", "EXPIRED", "CANCELLED", "ERROR", "MISMATCH", "REFUNDED"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Un estado desconocido nunca se interpreta como éxito: se descarta (queda como "sin información"). */
export function normalizeOrderState(value: unknown): MercadoPagoOrderState | null {
  const record = asRecord(value);
  if (!record || typeof record.saleId !== "string") return null;
  const status = typeof record.status === "string" && ORDER_STATUSES.includes(record.status) ? (record.status as MercadoPagoOrderStatus) : null;
  const verification = typeof record.verificationStatus === "string" && VERIFICATION_STATUSES.includes(record.verificationStatus)
    ? (record.verificationStatus as PaymentVerificationStatus)
    : null;
  return {
    saleId: record.saleId,
    attempt: numberOrNull(record.attempt),
    status,
    verificationStatus: verification,
    expectedAmountCents: numberOrNull(record.expectedAmountCents),
    confirmedAmountCents: numberOrNull(record.confirmedAmountCents),
    amountMismatch: record.amountMismatch === true,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null
  };
}

/** Normaliza el sobre `{ ok, order | code+message }` de las Edge Functions; cualquier otra forma es un error. */
export function parseActionEnvelope(body: unknown): MercadoPagoActionResult {
  const record = asRecord(body);
  if (!record) return { ok: false, code: "BAD_RESPONSE", message: "Respuesta inesperada del servidor de cobros.", order: null };
  const order = normalizeOrderState(record.order);
  if (record.ok === true) return { ok: true, order };
  return {
    ok: false,
    code: typeof record.code === "string" ? record.code : "ERROR",
    message: typeof record.message === "string" ? record.message : "No se pudo completar la operación.",
    order
  };
}

/**
 * Estado de verificación para reflejar localmente (caché de SQLite). Manda lo que ya conciliaron
 * el servidor (venta + cobro); si la venta todavía no llegó al servidor, se deriva de la orden. Un
 * monto distinto jamás es "confirmado". Sin información => PENDING, nunca CONFIRMED.
 */
export function deriveLocalVerification(order: MercadoPagoOrderState | null): PaymentVerificationStatus {
  if (!order) return "PENDING";
  if (order.amountMismatch) return "MISMATCH";
  const verification = order.verificationStatus;
  if (verification && verification !== "NOT_REQUIRED") return verification;
  switch (order.status) {
    case "CONFIRMED": return "CONFIRMED";
    case "EXPIRED": return "EXPIRED";
    case "CANCELLED": return "CANCELLED";
    case "REFUNDED": return "REFUNDED";
    case "ERROR": return "ERROR";
    default: return "PENDING";
  }
}

/** ¿Ya pasó el vencimiento informado y sigue sin acreditarse? (sólo para avisar; el estado lo cambia el servidor) */
export function isPastExpiry(order: MercadoPagoOrderState | null, nowMs: number): boolean {
  if (!order?.expiresAt) return false;
  const expires = Date.parse(order.expiresAt);
  return Number.isFinite(expires) && nowMs > expires;
}
