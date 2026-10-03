// Ticket por WhatsApp iniciado por el CLIENTE (D-060): lógica PURA del claim. El POS muestra un QR con un
// enlace `wa.me` que abre WhatsApp con el mensaje `TICKET <token>`; el webhook interpreta ese mensaje.
// Sin red, sin Supabase, sin Deno: la usan la Edge Function, el POS (sólo para tests de contenido del QR) y
// los tests.
//
// El token NUNCA contiene el id de la venta: es aleatorio (128 bits, generado en Postgres) y sólo su hash
// se guarda. Conocer un `sale_id` no sirve para obtener un ticket.

export const CLAIM_KEYWORD = "TICKET";

/** `+5493496123456` (o con espacios/guiones) → `+5493496123456`; null si no es un E.164 válido. */
export function normalizeBusinessPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(compact) ? compact : null;
}

export function buildClaimMessage(token: string): string {
  return `${CLAIM_KEYWORD} ${token}`;
}

/**
 * Enlace oficial de click-to-chat de WhatsApp (`https://wa.me/<número sin +>?text=<mensaje>`): al escanear
 * el QR se abre WhatsApp del cliente con el mensaje prearmado. El número es el NÚMERO COMERCIAL visible
 * (`WHATSAPP_BUSINESS_PHONE_E164`), no el `WHATSAPP_PHONE_NUMBER_ID` de la Cloud API.
 */
export function buildClaimLink(businessPhoneE164: string, token: string): string {
  const digits = businessPhoneE164.replace(/^\+/, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(buildClaimMessage(token))}`;
}

export type ClaimMessage =
  /** Texto que no es del flujo: se ignora sin responder (no es un chatbot). */
  | { kind: "ignore" }
  /** Empieza con TICKET pero no trae un token utilizable: se responde un "código inválido" breve. */
  | { kind: "malformed" }
  | { kind: "claim"; token: string };

/** `TICKET <token>` (mayúsculas/minúsculas indistintas). El formato del token lo valida Postgres. */
export function parseClaimMessage(text: unknown): ClaimMessage {
  if (typeof text !== "string") return { kind: "ignore" };
  const trimmed = text.trim();
  if (!new RegExp(`^${CLAIM_KEYWORD}(\\s|$)`, "i").test(trimmed)) return { kind: "ignore" };
  const match = new RegExp(`^${CLAIM_KEYWORD}\\s+(\\S+)$`, "i").exec(trimmed);
  return match?.[1] ? { kind: "claim", token: match[1] } : { kind: "malformed" };
}

export type ClaimReplyKind = "INVALID" | "EXPIRED" | "USED" | "ALREADY_SENT" | "NOT_AVAILABLE";

/** Respuestas breves de rechazo: nunca incluyen datos de la venta. */
export const CLAIM_REPLY_TEXT: Record<ClaimReplyKind, string> = {
  INVALID: "No pudimos validar este código. Pedí que te muestren de nuevo el QR del ticket en el local.",
  EXPIRED: "Este enlace venció. Pedí que te generen un nuevo QR del ticket en el local.",
  USED: "Este código ya fue utilizado. Pedí un nuevo QR del ticket en el local.",
  ALREADY_SENT: "Ya te enviamos este ticket. Revisá este mismo chat.",
  NOT_AVAILABLE: "No pudimos emitir el comprobante de esta compra. Consultá en el local."
};

export function claimReplyText(kind: unknown): string {
  return typeof kind === "string" && kind in CLAIM_REPLY_TEXT ? CLAIM_REPLY_TEXT[kind as ClaimReplyKind] : CLAIM_REPLY_TEXT.INVALID;
}
