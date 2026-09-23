import { describe, expect, it } from "vitest";

import { INITIAL_PAYMENT_METHOD, isSaleConfirmable, shouldDisplayTicketAmounts, validatePaymentMethodForSale } from "./ticket-payment";

describe("INITIAL_PAYMENT_METHOD", () => {
  it("ticket nuevo arranca sin método seleccionado (no CASH por defecto)", () => {
    expect(INITIAL_PAYMENT_METHOD).toBeNull();
  });
});

describe("shouldDisplayTicketAmounts", () => {
  it("sin método elegido, los importes quedan ocultos", () => {
    expect(shouldDisplayTicketAmounts(null)).toBe(false);
  });

  it("al elegir CASH, los importes pueden mostrarse", () => {
    expect(shouldDisplayTicketAmounts("CASH")).toBe(true);
  });

  it("al elegir DEBIT, los importes pueden mostrarse", () => {
    expect(shouldDisplayTicketAmounts("DEBIT")).toBe(true);
  });
});

describe("isSaleConfirmable", () => {
  const base = { ticketLength: 1, loading: false, deviceNeedsBinding: false };

  it("sin método de pago, Confirmar venta queda deshabilitado", () => {
    expect(isSaleConfirmable({ ...base, paymentMethod: null })).toBe(false);
  });

  it("con método elegido y ticket con líneas, Confirmar venta se habilita", () => {
    expect(isSaleConfirmable({ ...base, paymentMethod: "CASH" })).toBe(true);
  });

  it("sigue deshabilitado con ticket vacío aunque haya método elegido", () => {
    expect(isSaleConfirmable({ ...base, ticketLength: 0, paymentMethod: "CASH" })).toBe(false);
  });

  it("sigue deshabilitado mientras está cargando", () => {
    expect(isSaleConfirmable({ ...base, loading: true, paymentMethod: "CASH" })).toBe(false);
  });

  it("sigue deshabilitado si el dispositivo necesita vincularse", () => {
    expect(isSaleConfirmable({ ...base, deviceNeedsBinding: true, paymentMethod: "CASH" })).toBe(false);
  });
});

describe("validatePaymentMethodForSale", () => {
  it("rechaza la venta sin método de pago con un mensaje claro", () => {
    expect(validatePaymentMethodForSale(null)).toBe("Seleccioná un método de pago.");
  });

  it("no rechaza la venta cuando ya hay un método elegido", () => {
    expect(validatePaymentMethodForSale("TRANSFER")).toBeNull();
  });
});
