import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClaimLink } from "@carnicerias/business-logic";

import { PostSaleBar } from "./PostSaleBar";
import { buildQrMatrix, qrPath } from "./lib/qr";
import {
  isWhatsAppLink,
  parseClaimResponse,
  qrStateFromOutcome,
  WHATSAPP_QR_OFFLINE_MESSAGE,
  type WhatsAppQrState
} from "./lib/whatsapp-claim-state";
import { WhatsAppQrModal } from "./WhatsAppQrModal";

const BUSINESS = "+5493496000000";
const TOKEN = "3F9A0C7E5B1D4A28963E7C0B5D1F8A42";
const LINK = buildClaimLink(BUSINESS, TOKEN);

function render(options: { online?: boolean; sessionOffline?: boolean; state?: WhatsAppQrState } = {}) {
  vi.stubGlobal("navigator", { onLine: options.online ?? true });
  return renderToStaticMarkup(
    <WhatsAppQrModal
      saleLabel="f7000000"
      sessionOffline={options.sessionOffline ?? false}
      requestClaim={() => Promise.resolve({ kind: "ready", link: LINK, expiresAt: null, previouslyDelivered: false })}
      onClose={() => undefined}
      initialState={options.state ?? { phase: "ready", link: LINK, expiresAt: "2026-10-03T17:36:00Z", previouslyDelivered: false }}
    />
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("WhatsAppQrModal", () => {
  it("shows the agreed screen: title, QR, instructions and Cerrar — and asks for no phone", () => {
    const html = render();
    expect(html).toContain("Recibí tu ticket por WhatsApp");
    expect(html).toContain("<svg");
    expect(html).toContain("Escaneá el código y enviá el mensaje que aparecerá en WhatsApp.");
    expect(html).toContain("Cerrar");
    expect(html).not.toMatch(/<input/);
    expect(html).not.toContain("Teléfono");
  });

  it("the QR encodes the official wa.me link with the BUSINESS number and the TICKET <token> text", () => {
    const html = render();
    const value = /data-qr-value="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "";
    expect(value).toBe(LINK);
    const url = new URL(value);
    expect(url.origin + url.pathname).toBe("https://wa.me/5493496000000");
    expect(url.searchParams.get("text")).toBe(`TICKET ${TOKEN}`);
  });

  it("generates the QR locally: no external image service is referenced", () => {
    const html = render();
    expect(html).not.toMatch(/<img|https?:\/\/(?!wa\.me\/)[^"]*(qr|chart|api)/i);
    expect(html).not.toContain("<script");
  });

  it("shows a loading state while the code is requested", () => {
    const html = render({ state: { phase: "loading" } });
    expect(html).toContain("Generando código…");
    expect(html).not.toContain("<svg");
  });

  it("warns (without blocking) when the ticket of that sale was already delivered", () => {
    const html = render({ state: { phase: "ready", link: LINK, expiresAt: null, previouslyDelivered: true } });
    expect(html).toContain("Ya se entregó un ticket de esta venta");
    expect(html).toContain("<svg");
  });

  it("without Internet it shows the agreed message, no QR, and offers to retry", () => {
    const html = render({ state: qrStateFromOutcome({ kind: "offline" }) });
    expect(html).toContain("Ticket por WhatsApp requiere conexión a Internet.");
    expect(html).not.toContain("<svg");
    expect(html).toContain("Reintentar");
  });

  it("a blocked sale shows the reason with no QR and no retry", () => {
    const html = render({ state: qrStateFromOutcome({ kind: "error", message: "La venta está anulada: no se emite comprobante.", canRetry: false }) });
    expect(html).toContain("La venta está anulada");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Reintentar");
  });
});

describe("PostSaleBar", () => {
  const props = { saleLabel: "f7000000", totalLabel: "$ 16.500", onNewSale: () => undefined, onSendTicket: () => undefined };

  it("shows 'Venta completada' with Nueva venta and Ticket por WhatsApp, without blocking the screen", () => {
    const html = renderToStaticMarkup(<PostSaleBar {...props} availability={{ visible: true, usable: true }} />);
    expect(html).toContain("Venta completada");
    expect(html).toContain("Nueva venta");
    expect(html).toContain("Ticket por WhatsApp");
    expect(html).not.toContain("aria-modal");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*Ticket por WhatsApp/);
    expect(html).not.toMatch(/Enviar ticket/);
  });

  it("offline: the WhatsApp button is disabled and explains why; Nueva venta still works", () => {
    const html = renderToStaticMarkup(<PostSaleBar {...props} availability={{ visible: true, usable: false, message: WHATSAPP_QR_OFFLINE_MESSAGE }} />);
    expect(html).toContain("Ticket por WhatsApp requiere conexión a Internet.");
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Ticket por WhatsApp/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Nueva venta/);
  });

  it("hides the WhatsApp button when it is not available on this device", () => {
    const html = renderToStaticMarkup(<PostSaleBar {...props} availability={{ visible: false }} />);
    expect(html).toContain("Nueva venta");
    expect(html).not.toContain("WhatsApp");
  });
});

describe("parseClaimResponse", () => {
  it("reads the QR link, expiry and the previous-delivery flag", () => {
    expect(parseClaimResponse({ ok: true, claim: { link: LINK, expiresAt: "2026-10-03T17:36:00Z", previouslyDelivered: true } }))
      .toEqual({ kind: "ready", link: LINK, expiresAt: "2026-10-03T17:36:00Z", previouslyDelivered: true });
  });

  it("only a wa.me link is ever drawn as a QR", () => {
    expect(isWhatsAppLink(LINK)).toBe(true);
    for (const bad of ["https://evil.test/5493496000000?text=TICKET%20X", "https://wa.me/abc?text=x", "javascript:alert(1)", "", null, 3]) {
      expect(isWhatsAppLink(bad)).toBe(false);
    }
    expect(parseClaimResponse({ ok: true, claim: { link: "https://evil.test/x" } })).toMatchObject({ kind: "error" });
  });

  it("maps blocked sales to non-retryable errors and an unsynced sale to a retryable one", () => {
    expect(parseClaimResponse({ ok: false, code: "SALE_NOT_COMPLETED", message: "La venta todavía no está cobrada." })).toEqual({ kind: "error", message: "La venta todavía no está cobrada.", canRetry: false });
    expect(parseClaimResponse({ ok: false, code: "PAYMENT_NOT_CONFIRMED", message: "x" })).toMatchObject({ canRetry: false });
    expect(parseClaimResponse({ ok: false, code: "SALE_NOT_FOUND" })).toMatchObject({ kind: "error", canRetry: true });
    expect(parseClaimResponse({ ok: false, code: "WHATSAPP_NOT_CONFIGURED" })).toMatchObject({ canRetry: false });
  });

  it("anything unexpected is an error, never a QR", () => {
    expect(parseClaimResponse(null)).toMatchObject({ kind: "error" });
    expect(parseClaimResponse({})).toMatchObject({ kind: "error" });
    expect(parseClaimResponse({ ok: true })).toMatchObject({ kind: "error" });
  });
});

describe("local QR generation", () => {
  it("builds a square matrix with the three finder patterns", () => {
    const matrix = buildQrMatrix(LINK);
    const size = matrix.length;
    expect(size).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === size)).toBe(true);
    for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      // Borde exterior oscuro, anillo claro, centro oscuro del patrón de posición 7x7.
      expect(matrix[row]?.[column]).toBe(true);
      expect(matrix[row + 1]?.[column + 1]).toBe(false);
      expect(matrix[row + 3]?.[column + 3]).toBe(true);
    }
  });

  it("is deterministic and different values give different codes", () => {
    expect(qrPath(buildQrMatrix(LINK))).toBe(qrPath(buildQrMatrix(LINK)));
    expect(qrPath(buildQrMatrix(LINK))).not.toBe(qrPath(buildQrMatrix(buildClaimLink(BUSINESS, "0".repeat(32)))));
  });
});
