import { describe, expect, it } from "vitest";

import {
  canOfferTicket,
  initialTicketSendState,
  parseSendResponse,
  resolveWhatsAppAvailability,
  ticketSendReducer,
  type TicketSendState,
  type WhatsAppSendOutcome
} from "./whatsapp-ticket-state";

describe("parseSendResponse", () => {
  it("reads a confirmed send with the masked phone", () => {
    expect(parseSendResponse({ ok: true, delivery: { id: "x", status: "SENT", phoneMasked: "+54*******3456" } })).toEqual({ kind: "sent", phoneMasked: "+54*******3456" });
  });

  it("recognizes a ticket that was already sent", () => {
    expect(parseSendResponse({ ok: false, code: "ALREADY_SENT", message: "Este ticket ya fue enviado.", delivery: { status: "READ", phoneMasked: "+54*******3456" } }))
      .toEqual({ kind: "already_sent", phoneMasked: "+54*******3456" });
  });

  it("keeps the server's phone message for an invalid number", () => {
    expect(parseSendResponse({ ok: false, code: "INVALID_PHONE", message: "El número está incompleto." })).toEqual({ kind: "invalid_phone", message: "El número está incompleto." });
  });

  it("a sale not yet synced is retryable; a blocked sale is not", () => {
    expect(parseSendResponse({ ok: false, code: "SALE_NOT_FOUND" })).toMatchObject({ kind: "error", canRetry: true });
    expect(parseSendResponse({ ok: false, code: "SALE_NOT_COMPLETED", message: "La venta todavía no está cobrada." })).toEqual({ kind: "error", message: "La venta todavía no está cobrada.", canRetry: false });
    expect(parseSendResponse({ ok: false, code: "PAYMENT_NOT_CONFIRMED", message: "El pago todavía no está confirmado." })).toMatchObject({ canRetry: false });
  });

  it("a provider failure is retryable", () => {
    expect(parseSendResponse({ ok: false, code: "WHATSAPP_SEND_FAILED", message: "No se pudo enviar el ticket.", retryable: true })).toEqual({ kind: "error", message: "No se pudo enviar el ticket.", canRetry: true });
  });

  it("anything unexpected is an error, never a success", () => {
    expect(parseSendResponse(null)).toMatchObject({ kind: "error" });
    expect(parseSendResponse("ok")).toMatchObject({ kind: "error" });
    expect(parseSendResponse({})).toMatchObject({ kind: "error" });
    expect(parseSendResponse({ ok: "true" })).toMatchObject({ kind: "error" });
  });
});

describe("canOfferTicket", () => {
  it("offers COMPLETED manual-payment sales and confirmed Mercado Pago sales only", () => {
    expect(canOfferTicket({ status: "COMPLETED", provider: null, verificationStatus: "NOT_REQUIRED" })).toBe(true);
    expect(canOfferTicket({ status: "COMPLETED", provider: "MERCADOPAGO", verificationStatus: "CONFIRMED" })).toBe(true);
    expect(canOfferTicket({ status: "COMPLETED", provider: "MERCADOPAGO", verificationStatus: "PENDING" })).toBe(false);
    expect(canOfferTicket({ status: "PENDING_PAYMENT", provider: "MERCADOPAGO", verificationStatus: "PENDING" })).toBe(false);
    expect(canOfferTicket({ status: "CANCELLED", provider: null, verificationStatus: null })).toBe(false);
  });
});

describe("resolveWhatsAppAvailability", () => {
  const base = { desktop: true, hasDevice: true, hasOperator: true, hasOnlineSession: true, online: true };

  it("is usable online with a device and an operator", () => {
    expect(resolveWhatsAppAvailability(base)).toEqual({ visible: true, usable: true });
  });

  it("without Internet (or with only the cached session) it is visible but disabled with the agreed message", () => {
    expect(resolveWhatsAppAvailability({ ...base, online: false })).toEqual({ visible: true, usable: false, message: "Ticket por WhatsApp requiere conexión a Internet." });
    expect(resolveWhatsAppAvailability({ ...base, hasOnlineSession: false })).toEqual({ visible: true, usable: false, message: "Ticket por WhatsApp requiere conexión a Internet." });
  });

  it("is hidden when there is no device or operator (or outside the desktop POS)", () => {
    expect(resolveWhatsAppAvailability({ ...base, desktop: false })).toEqual({ visible: false });
    expect(resolveWhatsAppAvailability({ ...base, hasDevice: false })).toEqual({ visible: false });
    expect(resolveWhatsAppAvailability({ ...base, hasOperator: false })).toEqual({ visible: false });
  });
});

describe("ticketSendReducer", () => {
  const run = (state: TicketSendState, ...actions: Parameters<typeof ticketSendReducer>[1][]) => actions.reduce(ticketSendReducer, state);
  const sent: WhatsAppSendOutcome = { kind: "sent", phoneMasked: "+54*******3456" };

  it("starts editing for a new ticket", () => {
    expect(initialTicketSendState(false)).toMatchObject({ phase: "editing", phone: "", resend: false });
  });

  it("send success shows the confirmation", () => {
    const state = run(initialTicketSendState(false), { type: "edit", phone: "3496123456" }, { type: "sending" });
    expect(state.phase).toBe("sending");
    expect(run(state, { type: "outcome", outcome: sent })).toMatchObject({ phase: "sent", phoneMasked: "+54*******3456" });
  });

  it("an already-sent ticket requires confirmation before any new send (server told us)", () => {
    const sending = run(initialTicketSendState(false), { type: "edit", phone: "3496123456" }, { type: "sending" });
    const confirm = run(sending, { type: "outcome", outcome: { kind: "already_sent", phoneMasked: "+54*******3456" } });
    expect(confirm).toMatchObject({ phase: "confirm_resend", resend: false });
    // Only after the deliberate confirmation does the next request carry resend = true, with the typed phone kept.
    const confirmed = run(confirm, { type: "confirmResend" });
    expect(confirmed).toMatchObject({ phase: "editing", resend: true, phone: "3496123456" });
  });

  it("a ticket already sent in this session asks before even showing the phone field", () => {
    expect(initialTicketSendState(true).phase).toBe("confirm_resend");
    expect(run(initialTicketSendState(true), { type: "confirmResend" })).toMatchObject({ phase: "editing", resend: true });
  });

  it("a failure shows the error with Reintentar and keeps the typed number", () => {
    const state = run(initialTicketSendState(false), { type: "edit", phone: "3496123456" }, { type: "sending" }, { type: "outcome", outcome: { kind: "error", message: "No se pudo enviar el ticket.", canRetry: true } });
    expect(state).toMatchObject({ phase: "error", canRetry: true, phone: "3496123456", errorMessage: "No se pudo enviar el ticket." });
    expect(run(state, { type: "sending" }).phase).toBe("sending");
  });

  it("offline shows the agreed message", () => {
    expect(run(initialTicketSendState(false), { type: "outcome", outcome: { kind: "offline" } })).toMatchObject({ phase: "error", errorMessage: "WhatsApp requiere conexión a Internet" });
  });

  it("an invalid phone goes back to editing with the message", () => {
    expect(run(initialTicketSendState(false), { type: "sending" }, { type: "outcome", outcome: { kind: "invalid_phone", message: "Falta el código de área." } })).toMatchObject({ phase: "editing", fieldError: "Falta el código de área." });
    expect(run(initialTicketSendState(false), { type: "invalid", message: "x" })).toMatchObject({ phase: "editing", fieldError: "x" });
  });

  it("editing clears the field error", () => {
    expect(run({ ...initialTicketSendState(false), fieldError: "x" }, { type: "edit", phone: "1" }).fieldError).toBeNull();
  });
});
