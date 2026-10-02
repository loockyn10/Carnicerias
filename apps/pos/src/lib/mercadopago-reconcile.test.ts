import { describe, expect, it } from "vitest";

import type { PaymentVerificationStatus } from "@carnicerias/business-logic";

import { reconcilePendingMercadoPago, type ReconcileDeps } from "./mercadopago-reconcile";
import { describeLocalPayment, type MercadoPagoActionResult, type MercadoPagoOrderState } from "./mercadopago-state";

const NOW = Date.parse("2026-10-02T20:00:00Z");
const HOUR = 3_600_000;

const order = (over: Partial<MercadoPagoOrderState> = {}): MercadoPagoOrderState => ({
  saleId: "sale", attempt: 1, status: "CREATED", verificationStatus: "PENDING", expectedAmountCents: 10_000,
  confirmedAmountCents: null, amountMismatch: false, expiresAt: null, saleStatus: "PENDING_PAYMENT", ...over
});
const ok = (value: MercadoPagoOrderState | null): MercadoPagoActionResult => ({ ok: true, order: value });
const fail: MercadoPagoActionResult = { ok: false, code: "NETWORK", message: "Sin conexión", order: null };

function harness(statuses: Record<string, MercadoPagoActionResult>, pending: { saleId: string; hoursOld: number }[], cancels: Record<string, MercadoPagoActionResult> = {}) {
  const mirrored: [string, PaymentVerificationStatus][] = [];
  const cancelled: string[] = [];
  const deps: ReconcileDeps = {
    list: () => Promise.resolve(pending.map((p) => ({ saleId: p.saleId, completedAt: new Date(NOW - p.hoursOld * HOUR).toISOString() }))),
    fetchStatus: (saleId) => Promise.resolve(statuses[saleId] ?? ok(null)),
    cancelUnpaid: (saleId) => { cancelled.push(saleId); return Promise.resolve(cancels[saleId] ?? fail); },
    mirror: (saleId, status) => { mirrored.push([saleId, status]); return Promise.resolve(); },
    nowMs: NOW,
    abandonedAfterMs: 12 * HOUR
  };
  return { deps, mirrored, cancelled };
}

describe("reconcilePendingMercadoPago — a POS that was closed converges to the same result as the webhook", () => {
  it("a charge that expired while the POS was closed is mirrored as EXPIRED (it leaves 'MP pendientes')", async () => {
    const h = harness({ s1: ok(order({ status: "EXPIRED", verificationStatus: "EXPIRED", saleStatus: "CANCELLED" })) }, [{ saleId: "s1", hoursOld: 1 }]);
    const summary = await reconcilePendingMercadoPago(h.deps);
    expect(h.mirrored).toEqual([["s1", "EXPIRED"]]);
    expect(summary).toEqual({ checked: 1, resolved: 1 });
  });

  it("a charge cancelled elsewhere, one paid and one still waiting", async () => {
    const h = harness({
      cancelled: ok(order({ status: "CANCELLED", verificationStatus: "CANCELLED", saleStatus: "CANCELLED" })),
      paid: ok(order({ status: "CONFIRMED", verificationStatus: "CONFIRMED", saleStatus: "COMPLETED", confirmedAmountCents: 10_000 })),
      waiting: ok(order())
    }, [{ saleId: "cancelled", hoursOld: 1 }, { saleId: "paid", hoursOld: 1 }, { saleId: "waiting", hoursOld: 1 }]);
    const summary = await reconcilePendingMercadoPago(h.deps);
    expect(h.mirrored).toEqual([["cancelled", "CANCELLED"], ["paid", "CONFIRMED"]]);
    expect(summary).toEqual({ checked: 3, resolved: 2 });
  });

  it("a still-waiting charge is left alone (it stays in 'MP pendientes')", async () => {
    const h = harness({ s1: ok(order()) }, [{ saleId: "s1", hoursOld: 0.2 }]);
    await reconcilePendingMercadoPago(h.deps);
    expect(h.mirrored).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it("concludes nothing without an answer from the server (offline / no session)", async () => {
    const h = harness({ s1: fail }, [{ saleId: "s1", hoursOld: 30 }]);
    const summary = await reconcilePendingMercadoPago(h.deps);
    expect(h.mirrored).toEqual([]);
    expect(h.cancelled).toEqual([]);
    expect(summary.resolved).toBe(0);
  });

  it("a fresh sale without a charge yet is not touched (the cashier may be creating it right now)", async () => {
    const h = harness({ s1: ok(null) }, [{ saleId: "s1", hoursOld: 0.1 }]);
    await reconcilePendingMercadoPago(h.deps);
    expect(h.cancelled).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  it("an old sale with no live charge is abandoned in the backend and then leaves the list", async () => {
    const h = harness({ s1: ok(order({ status: "ERROR", verificationStatus: "ERROR" })) }, [{ saleId: "s1", hoursOld: 20 }], {
      s1: ok(order({ status: null, verificationStatus: "CANCELLED", saleStatus: "CANCELLED" }))
    });
    const summary = await reconcilePendingMercadoPago(h.deps);
    expect(h.cancelled).toEqual(["s1"]);
    expect(h.mirrored).toEqual([["s1", "CANCELLED"]]);
    expect(summary.resolved).toBe(1);
  });

  it("an old sale whose charge is still alive is never abandoned (the money may still arrive)", async () => {
    const h = harness({ s1: ok(order()) }, [{ saleId: "s1", hoursOld: 20 }]);
    await reconcilePendingMercadoPago(h.deps);
    expect(h.cancelled).toEqual([]);
  });

  it("an old technical ERROR is kept as ERROR when the backend refuses to abandon it", async () => {
    const h = harness({ s1: ok(order({ status: "ERROR", verificationStatus: "ERROR" })) }, [{ saleId: "s1", hoursOld: 20 }], { s1: fail });
    const summary = await reconcilePendingMercadoPago(h.deps);
    expect(h.mirrored).toEqual([["s1", "ERROR"]]);
    expect(summary.resolved).toBe(0);
  });

  it("running it twice reports the same final state (idempotent)", async () => {
    const statuses = { s1: ok(order({ status: "EXPIRED", verificationStatus: "EXPIRED", saleStatus: "CANCELLED" })) };
    const first = harness(statuses, [{ saleId: "s1", hoursOld: 1 }]);
    const second = harness(statuses, [{ saleId: "s1", hoursOld: 1 }]);
    await reconcilePendingMercadoPago(first.deps);
    await reconcilePendingMercadoPago(second.deps);
    expect(first.mirrored).toEqual(second.mirrored);
  });
});

describe("describeLocalPayment — the receipts never call an unpaid sale paid", () => {
  it("is silent for manual payments", () => {
    expect(describeLocalPayment(null, "NOT_REQUIRED")).toBeNull();
    expect(describeLocalPayment(null, null)).toBeNull();
  });
  it("only CONFIRMED reads as paid", () => {
    for (const status of ["PENDING", "ERROR", "CANCELLED", "EXPIRED", "MISMATCH", "REFUNDED", null]) {
      expect(describeLocalPayment("MERCADOPAGO", status)?.label).not.toContain("confirmado");
      expect(describeLocalPayment("MERCADOPAGO", status)?.tone).not.toBe("ok");
    }
    expect(describeLocalPayment("MERCADOPAGO", "CONFIRMED")).toMatchObject({ tone: "ok" });
  });
  it("cancelled and expired are shown as annulled, not as pending", () => {
    expect(describeLocalPayment("MERCADOPAGO", "CANCELLED")?.label).toContain("anulada");
    expect(describeLocalPayment("MERCADOPAGO", "EXPIRED")?.label).toContain("anulada");
    expect(describeLocalPayment("MERCADOPAGO", "PENDING")?.tone).toBe("wait");
  });
});
