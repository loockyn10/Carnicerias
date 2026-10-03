/**
 * Estado del QR de "Ticket por WhatsApp" (D-060, iniciado por el cliente). Lógica pura: sin red, sin
 * Supabase, sin React. El POS no decide nada: pide un claim al backend y dibuja el enlace que devuelve.
 */

export const WHATSAPP_QR_OFFLINE_MESSAGE = "Ticket por WhatsApp requiere conexión a Internet.";

export type WhatsAppClaimOutcome =
  | { kind: "ready"; link: string; expiresAt: string | null; previouslyDelivered: boolean }
  | { kind: "offline" }
  | { kind: "error"; message: string; canRetry: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Sólo un enlace `https://wa.me/…` es un resultado válido: cualquier otra cosa nunca se dibuja como QR. */
export function isWhatsAppLink(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/wa\.me\/[0-9]{8,15}\?text=[^\s]+$/.test(value);
}

export function parseClaimResponse(body: unknown): WhatsAppClaimOutcome {
  const record = asRecord(body);
  if (!record) return { kind: "error", message: "Respuesta inesperada del servidor.", canRetry: true };
  if (record.ok === true) {
    const claim = asRecord(record.claim);
    if (!claim || !isWhatsAppLink(claim.link)) return { kind: "error", message: "Respuesta inesperada del servidor.", canRetry: true };
    return {
      kind: "ready",
      link: claim.link,
      expiresAt: typeof claim.expiresAt === "string" ? claim.expiresAt : null,
      previouslyDelivered: claim.previouslyDelivered === true
    };
  }
  const message = typeof record.message === "string" ? record.message : "No se pudo generar el código.";
  switch (record.code) {
    case "SALE_NOT_FOUND":
      return { kind: "error", message: "La venta todavía se está sincronizando con el servidor. Reintentá en unos segundos.", canRetry: true };
    case "SALE_NOT_COMPLETED":
    case "PAYMENT_NOT_CONFIRMED":
    case "FORBIDDEN":
    case "TOO_MANY_CLAIMS":
      return { kind: "error", message, canRetry: false };
    case "WHATSAPP_NOT_CONFIGURED":
      return { kind: "error", message: "El ticket por WhatsApp todavía no está configurado.", canRetry: false };
    default:
      return { kind: "error", message, canRetry: true };
  }
}

export type WhatsAppQrState =
  | { phase: "loading" }
  | { phase: "ready"; link: string; expiresAt: string | null; previouslyDelivered: boolean }
  | { phase: "error"; message: string; canRetry: boolean };

export function qrStateFromOutcome(outcome: WhatsAppClaimOutcome): WhatsAppQrState {
  switch (outcome.kind) {
    case "ready":
      return { phase: "ready", link: outcome.link, expiresAt: outcome.expiresAt, previouslyDelivered: outcome.previouslyDelivered };
    case "offline":
      return { phase: "error", message: WHATSAPP_QR_OFFLINE_MESSAGE, canRetry: true };
    case "error":
      return { phase: "error", message: outcome.message, canRetry: outcome.canRetry };
  }
}
