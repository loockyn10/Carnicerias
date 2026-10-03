import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialTicketSendState, ticketSendReducer, type TicketSendState } from "./lib/whatsapp-ticket-state";
import { WhatsAppTicketModal } from "./WhatsAppTicketModal";

function render(options: { online?: boolean; sessionOffline?: boolean; previouslySent?: boolean; state?: TicketSendState } = {}) {
  vi.stubGlobal("navigator", { onLine: options.online ?? true });
  return renderToStaticMarkup(
    <WhatsAppTicketModal
      saleLabel="f7000000"
      previouslySent={options.previouslySent ?? false}
      sessionOffline={options.sessionOffline ?? false}
      send={() => Promise.resolve({ kind: "sent", phoneMasked: null })}
      onSent={() => undefined}
      onClose={() => undefined}
      {...(options.state ? { initialState: options.state } : {})}
    />
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("WhatsAppTicketModal", () => {
  it("shows the agreed dialog: title, phone field, Cancelar and Enviar", () => {
    const html = render();
    expect(html).toContain("Enviar ticket por WhatsApp");
    expect(html).toContain("Teléfono");
    expect(html).toContain("+54 9 3496");
    expect(html).toContain("Cancelar");
    expect(html).toContain(">Enviar<");
    expect(html).not.toContain("requiere conexión");
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("without Internet it only warns and the send button is disabled", () => {
    const html = render({ online: false });
    expect(html).toContain("WhatsApp requiere conexión a Internet");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("a cached offline Supabase session is also offline for this purpose", () => {
    const html = render({ sessionOffline: true });
    expect(html).toContain("WhatsApp requiere conexión a Internet");
  });

  it("while sending it shows 'Enviando...' and locks the form", () => {
    const state = ticketSendReducer({ ...initialTicketSendState(false), phone: "3496123456" }, { type: "sending" });
    const html = render({ state });
    expect(html).toContain("Enviando...");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("on success it shows '✓ Ticket enviado por WhatsApp'", () => {
    const state = ticketSendReducer(initialTicketSendState(false), { type: "outcome", outcome: { kind: "sent", phoneMasked: "+54*******3456" } });
    const html = render({ state });
    expect(html).toContain("✓ Ticket enviado por WhatsApp");
    expect(html).toContain("+54*******3456");
  });

  it("on failure it shows 'No se pudo enviar el ticket' with Reintentar", () => {
    const state = ticketSendReducer(initialTicketSendState(false), { type: "outcome", outcome: { kind: "error", message: "WhatsApp rechazó el mensaje.", canRetry: true } });
    const html = render({ state });
    expect(html).toContain("No se pudo enviar el ticket");
    expect(html).toContain("Reintentar");
  });

  it("a blocked sale shows the reason and no Reintentar", () => {
    const state = ticketSendReducer(initialTicketSendState(false), { type: "outcome", outcome: { kind: "error", message: "La venta está anulada: no se emite comprobante.", canRetry: false } });
    const html = render({ state });
    expect(html).toContain("La venta está anulada");
    expect(html).not.toContain("Reintentar");
  });

  it("a ticket that was already sent asks to confirm before resending (no phone field yet)", () => {
    const html = render({ previouslySent: true });
    expect(html).toContain("Este ticket ya fue enviado.");
    expect(html).toContain("¿Querés reenviarlo?");
    expect(html).toContain("Reenviar");
    expect(html).not.toContain("Teléfono");
  });

  it("the same warning appears when the server reports the duplicate", () => {
    const state = ticketSendReducer(initialTicketSendState(false), { type: "outcome", outcome: { kind: "already_sent", phoneMasked: "+54*******3456" } });
    const html = render({ state });
    expect(html).toContain("Este ticket ya fue enviado.");
    expect(html).toContain("Enviado a +54*******3456");
  });

  it("never renders a full phone number it was not given", () => {
    expect(render({ previouslySent: true })).not.toMatch(/\d{10}/);
  });
});
