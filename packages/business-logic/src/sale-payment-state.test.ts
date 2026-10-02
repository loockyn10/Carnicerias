import { describe, expect, it } from "vitest";

import { describeSalePayment, paymentMethodLabel } from "./sale-payment-state";

const mercadoPago = (saleStatus: string, verificationStatus: string | null) =>
  describeSalePayment({ saleStatus, method: "TRANSFER", provider: "MERCADOPAGO", verificationStatus });

describe("Admin sale payment presentation", () => {
  it("shows Mercado Pago as its own method, never as 'Transferencia'", () => {
    expect(paymentMethodLabel("TRANSFER", "MERCADOPAGO")).toBe("Mercado Pago");
    expect(mercadoPago("COMPLETED", "CONFIRMED").methodLabel).toBe("Mercado Pago");
    // A genuine manual transfer (historic sales, branches without Mercado Pago) keeps its label.
    expect(paymentMethodLabel("TRANSFER", null)).toBe("Transferencia");
    expect(describeSalePayment({ saleStatus: "COMPLETED", method: "TRANSFER", provider: null, verificationStatus: "NOT_REQUIRED" }).methodLabel).toBe("Transferencia");
  });

  it("the three real test sales read differently: paid / not accredited / not accredited", () => {
    const paid = mercadoPago("COMPLETED", "CONFIRMED");
    const cancelledA = mercadoPago("CANCELLED", "CANCELLED");
    const cancelledB = mercadoPago("CANCELLED", "CANCELLED");
    expect(paid).toMatchObject({ badge: "PAGO CONFIRMADO", tone: "success", collected: true });
    expect(cancelledA).toMatchObject({ badge: "CANCELADO · NO ACREDITADO", tone: "danger", collected: false });
    expect(cancelledB.badge).toBe(cancelledA.badge);
    expect(new Set([paid.badge, cancelledA.badge]).size).toBe(2);
    for (const view of [paid, cancelledA, cancelledB]) expect(view.badge).not.toBe("COMPLETED");
  });

  it("distinguishes pending, confirmed, cancelled and expired", () => {
    expect(mercadoPago("PENDING_PAYMENT", "PENDING")).toMatchObject({ badge: "PAGO PENDIENTE", tone: "warning", collected: false });
    expect(mercadoPago("COMPLETED", "CONFIRMED")).toMatchObject({ badge: "PAGO CONFIRMADO", collected: true });
    expect(mercadoPago("CANCELLED", "CANCELLED").badge).toBe("CANCELADO · NO ACREDITADO");
    expect(mercadoPago("CANCELLED", "EXPIRED").badge).toBe("VENCIDO · NO ACREDITADO");
    const badges = ["PENDING_PAYMENT/PENDING", "COMPLETED/CONFIRMED", "CANCELLED/CANCELLED", "CANCELLED/EXPIRED"].map((pair) => {
      const [saleStatus, verification] = pair.split("/");
      return mercadoPago(saleStatus ?? "", verification ?? null).badge;
    });
    expect(new Set(badges).size).toBe(4);
  });

  it("only a completed (accredited) Mercado Pago sale counts as collected", () => {
    for (const [saleStatus, verification] of [["PENDING_PAYMENT", "PENDING"], ["PENDING_PAYMENT", "ERROR"], ["PENDING_PAYMENT", "MISMATCH"], ["CANCELLED", "CANCELLED"], ["CANCELLED", "EXPIRED"]] as const) {
      expect(mercadoPago(saleStatus, verification).collected).toBe(false);
    }
    expect(mercadoPago("COMPLETED", "CONFIRMED").collected).toBe(true);
  });

  it("flags the abnormal cases for the owner instead of hiding them", () => {
    expect(mercadoPago("PENDING_PAYMENT", "MISMATCH")).toMatchObject({ badge: "MONTO DISTINTO", tone: "danger" });
    expect(mercadoPago("CANCELLED", "CONFIRMED")).toMatchObject({ badge: "ANULADA · PAGO ACREDITADO", tone: "danger" });
    expect(mercadoPago("COMPLETED", "REFUNDED").badge).toBe("PAGO DEVUELTO");
    expect(mercadoPago("COMPLETED", "PENDING")).toMatchObject({ badge: "SIN VERIFICAR", tone: "danger" });
  });

  it("leaves non-Mercado Pago sales exactly as before", () => {
    expect(describeSalePayment({ saleStatus: "COMPLETED", method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED" })).toMatchObject({ methodLabel: "Efectivo", badge: "COMPLETADA", tone: "success", collected: true });
    expect(describeSalePayment({ saleStatus: "CANCELLED", method: "DEBIT", provider: null, verificationStatus: "NOT_REQUIRED" })).toMatchObject({ methodLabel: "Débito", badge: "ANULADA", tone: "danger", collected: false });
    expect(describeSalePayment({ saleStatus: "COMPLETED", method: null, provider: null, verificationStatus: null }).methodLabel).toBe("Sin medio informado");
  });
});
