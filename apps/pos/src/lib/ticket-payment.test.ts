import { describe, expect, it } from "vitest";

import { filterPaymentMethodButtons, INITIAL_PAYMENT_METHOD, initialPaymentMethodFor, isSaleConfirmable, shouldDisplayTicketAmounts, validatePaymentMethodForSale } from "./ticket-payment";

describe("INITIAL_PAYMENT_METHOD", () => {
  it("ticket nuevo arranca sin método seleccionado (no CASH por defecto)", () => {
    expect(INITIAL_PAYMENT_METHOD).toBeNull();
  });
});

describe("initialPaymentMethodFor (D-061)", () => {
  it("Central (sucursal productiva) arranca cada ticket en Efectivo y los importes se ven desde el inicio", () => {
    expect(initialPaymentMethodFor(true)).toBe("CASH");
    expect(shouldDisplayTicketAmounts(initialPaymentMethodFor(true))).toBe(true);
  });

  it("Avenida/Janssen no cambian: sin método elegido hasta que la empleada lo toque", () => {
    expect(initialPaymentMethodFor(false)).toBeNull();
    expect(initialPaymentMethodFor(false)).toBe(INITIAL_PAYMENT_METHOD);
    expect(shouldDisplayTicketAmounts(initialPaymentMethodFor(false))).toBe(false);
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

  it("un total a cobrar de $0 (descuento general del 100%) no se confirma; uno positivo sí", () => {
    expect(isSaleConfirmable({ ...base, paymentMethod: "CASH", totalCents: 0n })).toBe(false);
    expect(isSaleConfirmable({ ...base, paymentMethod: "CASH", totalCents: 2_280_000n })).toBe(true);
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

describe("filterPaymentMethodButtons — manual transfer only where Mercado Pago is not mandatory", () => {
  const buttons = [{ value: "CASH" as const }, { value: "TRANSFER" as const }, { value: "DEBIT" as const }];
  it("Central-like branch keeps Efectivo, Transferencia and Tarjeta", () => {
    expect(filterPaymentMethodButtons(buttons, true).map((button) => button.value)).toEqual(["CASH", "TRANSFER", "DEBIT"]);
  });
  it("Avenida-like branch (Mercado Pago required) shows no manual Transferencia but keeps cash and card", () => {
    expect(filterPaymentMethodButtons(buttons, false).map((button) => button.value)).toEqual(["CASH", "DEBIT"]);
  });
});
