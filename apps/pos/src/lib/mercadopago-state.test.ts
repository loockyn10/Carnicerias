import { describe, expect, it } from "vitest";

import {
  deriveLocalVerification,
  isPastExpiry,
  normalizeOrderState,
  parseActionEnvelope,
  type MercadoPagoOrderState
} from "./mercadopago-state";

const order = (over: Partial<MercadoPagoOrderState> = {}): MercadoPagoOrderState => ({
  saleId: "sale", attempt: 1, status: "CREATED", verificationStatus: null, expectedAmountCents: 7_500_000,
  confirmedAmountCents: null, amountMismatch: false, expiresAt: null, ...over
});

describe("normalizeOrderState", () => {
  it("keeps the fields the backend reports and drops everything else", () => {
    expect(normalizeOrderState({ saleId: "s", attempt: 2, status: "CREATED", verificationStatus: "PENDING", expectedAmountCents: 100, confirmedAmountCents: null, amountMismatch: false, expiresAt: "2026-10-01T18:00:00Z", mpOrderId: "ORD1", idempotencyKey: "secret-ish" }))
      .toEqual({ saleId: "s", attempt: 2, status: "CREATED", verificationStatus: "PENDING", expectedAmountCents: 100, confirmedAmountCents: null, amountMismatch: false, expiresAt: "2026-10-01T18:00:00Z" });
  });
  it("never turns an unknown status into a success", () => {
    expect(normalizeOrderState({ saleId: "s", status: "PAID", verificationStatus: "VERIFIED" })).toMatchObject({ status: null, verificationStatus: null });
  });
  it("returns null for anything that is not an order", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { status: "CONFIRMED" }]) expect(normalizeOrderState(bad)).toBeNull();
  });
});

describe("parseActionEnvelope", () => {
  it("parses success and failure envelopes", () => {
    expect(parseActionEnvelope({ ok: true, order: { saleId: "s", status: "CREATED" } })).toMatchObject({ ok: true, order: { status: "CREATED" } });
    expect(parseActionEnvelope({ ok: false, code: "MP_REJECTED", message: "Mercado Pago rechazó el cobro.", order: { saleId: "s", status: "ERROR" } }))
      .toMatchObject({ ok: false, code: "MP_REJECTED", order: { status: "ERROR" } });
  });
  it("treats garbage as a failure, never as success", () => {
    expect(parseActionEnvelope(null)).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
    expect(parseActionEnvelope({ order: { saleId: "s", status: "CONFIRMED" } })).toMatchObject({ ok: false });
    expect(parseActionEnvelope({ ok: "true" })).toMatchObject({ ok: false });
  });
});

describe("deriveLocalVerification — CONFIRMED only when the backend says so", () => {
  it("returns PENDING without information", () => {
    expect(deriveLocalVerification(null)).toBe("PENDING");
    expect(deriveLocalVerification(order({ status: null }))).toBe("PENDING");
    expect(deriveLocalVerification(order({ status: "REQUESTING" }))).toBe("PENDING");
    expect(deriveLocalVerification(order({ status: "CREATED" }))).toBe("PENDING");
  });
  it("trusts the reconciled sale status first", () => {
    expect(deriveLocalVerification(order({ status: "CONFIRMED", verificationStatus: "CONFIRMED" }))).toBe("CONFIRMED");
    expect(deriveLocalVerification(order({ status: "CONFIRMED", verificationStatus: "PENDING" }))).toBe("PENDING");
    expect(deriveLocalVerification(order({ status: "EXPIRED", verificationStatus: "EXPIRED" }))).toBe("EXPIRED");
  });
  it("derives from the order while the sale has not reached the server yet", () => {
    expect(deriveLocalVerification(order({ status: "CONFIRMED" }))).toBe("CONFIRMED");
    expect(deriveLocalVerification(order({ status: "CANCELLED" }))).toBe("CANCELLED");
    expect(deriveLocalVerification(order({ status: "ERROR" }))).toBe("ERROR");
  });
  it("a different amount is never confirmed, even if the order says CONFIRMED", () => {
    expect(deriveLocalVerification(order({ status: "CONFIRMED", verificationStatus: "CONFIRMED", amountMismatch: true }))).toBe("MISMATCH");
  });
});

describe("expiry", () => {
  it("detects a passed expiry without changing any state", () => {
    const o = order({ expiresAt: "2026-10-01T18:00:00Z" });
    expect(isPastExpiry(o, Date.parse("2026-10-01T17:59:59Z"))).toBe(false);
    expect(isPastExpiry(o, Date.parse("2026-10-01T18:00:01Z"))).toBe(true);
    expect(isPastExpiry(order(), Date.now())).toBe(false);
    expect(isPastExpiry(null, Date.now())).toBe(false);
  });
});
