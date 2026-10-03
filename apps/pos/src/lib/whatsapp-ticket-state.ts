/**
 * Estado del envío del ticket por WhatsApp (D-059). Lógica pura: sin red, sin Supabase, sin Tauri, sin
 * React (por eso se prueba sin credenciales). El POS sólo muestra lo que el BACKEND contestó; jamás
 * decide si un ticket "se envió" ni qué dice.
 */

import { WHATSAPP_QR_OFFLINE_MESSAGE } from "./whatsapp-claim-state";

// Fallback (envío iniciado por el negocio con teléfono): hoy fuera de la UI normal del POS.
export const WHATSAPP_OFFLINE_MESSAGE = "WhatsApp requiere conexión a Internet";
export const WHATSAPP_ERROR_TITLE = "No se pudo enviar el ticket";
export const WHATSAPP_SENT_MESSAGE = "✓ Ticket enviado por WhatsApp";
export const WHATSAPP_ALREADY_SENT_MESSAGE = "Este ticket ya fue enviado.";
export const WHATSAPP_RESEND_QUESTION = "¿Querés reenviarlo?";

export type WhatsAppSendOutcome =
  | { kind: "sent"; phoneMasked: string | null }
  | { kind: "already_sent"; phoneMasked: string | null }
  | { kind: "invalid_phone"; message: string }
  | { kind: "offline" }
  | { kind: "error"; message: string; canRetry: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Normaliza la respuesta de `whatsapp-send-ticket` (sobre `{ ok, code, message, ... }`). Algo raro => error. */
export function parseSendResponse(body: unknown): WhatsAppSendOutcome {
  const record = asRecord(body);
  if (!record) return { kind: "error", message: "Respuesta inesperada del servidor.", canRetry: true };
  const delivery = asRecord(record.delivery);
  const phoneMasked = typeof delivery?.phoneMasked === "string" ? delivery.phoneMasked : null;
  if (record.ok === true) return { kind: "sent", phoneMasked };
  const message = typeof record.message === "string" ? record.message : "No se pudo completar el envío.";
  switch (record.code) {
    case "ALREADY_SENT":
      return { kind: "already_sent", phoneMasked };
    case "INVALID_PHONE":
      return { kind: "invalid_phone", message };
    case "SALE_NOT_FOUND":
      return { kind: "error", message: "La venta todavía se está sincronizando con el servidor. Reintentá en unos segundos.", canRetry: true };
    case "SALE_NOT_COMPLETED":
    case "PAYMENT_NOT_CONFIRMED":
    case "FORBIDDEN":
      // Reintentar no cambia nada: el servidor explica por qué.
      return { kind: "error", message, canRetry: false };
    case "WHATSAPP_NOT_CONFIGURED":
      return { kind: "error", message: "El envío por WhatsApp todavía no está configurado.", canRetry: false };
    default:
      return { kind: "error", message, canRetry: true };
  }
}

/** ¿Se ofrece el botón de WhatsApp para esta venta? (el servidor igual decide: esto sólo evita ofrecer lo obvio) */
export function canOfferTicket(sale: { status: string; provider: string | null; verificationStatus: string | null }): boolean {
  if (sale.status !== "COMPLETED") return false;
  return sale.provider === null || sale.verificationStatus === "CONFIRMED";
}

export interface WhatsAppAvailabilityInput {
  desktop: boolean;
  hasDevice: boolean;
  hasOperator: boolean;
  /** Sesión de Supabase real (no la autorización en caché sin Internet). */
  hasOnlineSession: boolean;
  online: boolean;
}

export type WhatsAppAvailability =
  | { visible: false }
  | { visible: true; usable: true }
  | { visible: true; usable: false; message: string };

/** Ticket por WhatsApp (QR del cliente) es una acción explícita ONLINE: nunca entra a la outbox offline. */
export function resolveWhatsAppAvailability(input: WhatsAppAvailabilityInput): WhatsAppAvailability {
  if (!input.desktop || !input.hasDevice || !input.hasOperator) return { visible: false };
  if (!input.online || !input.hasOnlineSession) return { visible: true, usable: false, message: WHATSAPP_QR_OFFLINE_MESSAGE };
  return { visible: true, usable: true };
}

// ---------------------------------------------------------------------------
// Modal: máquina de estados
// ---------------------------------------------------------------------------

export type TicketSendPhase = "editing" | "sending" | "sent" | "confirm_resend" | "error";

export interface TicketSendState {
  phase: TicketSendPhase;
  phone: string;
  /** Se manda `resend: true` al backend (el empleado confirmó el reenvío). */
  resend: boolean;
  fieldError: string | null;
  errorMessage: string | null;
  canRetry: boolean;
  phoneMasked: string | null;
}

/** Una venta con un envío ya hecho arranca pidiendo confirmación, antes de tipear nada. */
export function initialTicketSendState(previouslySent: boolean): TicketSendState {
  return {
    phase: previouslySent ? "confirm_resend" : "editing",
    phone: "", resend: false, fieldError: null, errorMessage: null, canRetry: true, phoneMasked: null
  };
}

export type TicketSendAction =
  | { type: "edit"; phone: string }
  | { type: "invalid"; message: string }
  | { type: "sending" }
  | { type: "outcome"; outcome: WhatsAppSendOutcome }
  | { type: "confirmResend" }
  | { type: "backToEdit" };

export function ticketSendReducer(state: TicketSendState, action: TicketSendAction): TicketSendState {
  switch (action.type) {
    case "edit":
      return { ...state, phone: action.phone, fieldError: null };
    case "invalid":
      return { ...state, phase: "editing", fieldError: action.message };
    case "sending":
      return { ...state, phase: "sending", fieldError: null, errorMessage: null };
    case "confirmResend":
      return { ...state, phase: "editing", resend: true, fieldError: null, errorMessage: null };
    case "backToEdit":
      return { ...state, phase: "editing", errorMessage: null };
    case "outcome": {
      const outcome = action.outcome;
      switch (outcome.kind) {
        case "sent":
          return { ...state, phase: "sent", phoneMasked: outcome.phoneMasked, fieldError: null, errorMessage: null };
        case "already_sent":
          // El servidor sabe de un envío anterior: se pide confirmación antes de enviar otra vez.
          return { ...state, phase: "confirm_resend", resend: false, phoneMasked: outcome.phoneMasked };
        case "invalid_phone":
          return { ...state, phase: "editing", fieldError: outcome.message };
        case "offline":
          return { ...state, phase: "error", errorMessage: WHATSAPP_OFFLINE_MESSAGE, canRetry: true };
        case "error":
          return { ...state, phase: "error", errorMessage: outcome.message, canRetry: outcome.canRetry };
      }
    }
  }
}
