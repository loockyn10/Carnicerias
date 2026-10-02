import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCreateQrOrderBody,
  buildExternalReference,
  buildPosPayload,
  buildSignatureManifest,
  buildStorePayload,
  centsToDecimalString,
  computeWebhookSignature,
  describePaymentState,
  isNotAccreditedVerification,
  isRecoverableMercadoPagoPayment,
  interpretOrder,
  parseDecimalToCents,
  parseExternalReference,
  parseNotification,
  parseSignatureHeader,
  verifyWebhookSignature
} from "./mercadopago";

const SALE = "c7000000-0000-4000-8000-000000000001";

describe("amounts (integer cents <-> MP decimal string)", () => {
  it("formats cents without floats", () => {
    expect(centsToDecimalString(7_500_000)).toBe("75000.00");
    expect(centsToDecimalString(5)).toBe("0.05");
    expect(centsToDecimalString(100n)).toBe("1.00");
    expect(centsToDecimalString(123_456)).toBe("1234.56");
  });
  it("parses MP decimals strictly", () => {
    expect(parseDecimalToCents("750.00")).toBe(75_000);
    expect(parseDecimalToCents("750")).toBe(75_000);
    expect(parseDecimalToCents("750.5")).toBe(75_050);
    expect(parseDecimalToCents(30)).toBe(3_000);
    for (const bad of ["", "1e3", "-1", "1,50", "1.234", "abc", null, undefined, {}]) expect(parseDecimalToCents(bad)).toBeNull();
  });
  it("round-trips every cent value of a sample", () => {
    for (const cents of [1, 99, 100, 101, 999_999, 12_345_678]) expect(parseDecimalToCents(centsToDecimalString(cents))).toBe(cents);
  });
  it("rejects negative amounts", () => {
    expect(() => centsToDecimalString(-1)).toThrow(RangeError);
  });
});

describe("external_reference (1:1 with the sale)", () => {
  it("attempt 1 is exactly the sale id", () => {
    expect(buildExternalReference(SALE, 1)).toBe(SALE);
    expect(parseExternalReference(SALE)).toEqual({ saleId: SALE, attempt: 1 });
  });
  it("retries are sale-id-N and fit the 64 char limit", () => {
    const ref = buildExternalReference(SALE, 12);
    expect(ref).toBe(`${SALE}-12`);
    expect(ref.length).toBeLessThanOrEqual(64);
    expect(parseExternalReference(ref)).toEqual({ saleId: SALE, attempt: 12 });
  });
  it("rejects anything that is not one of our references", () => {
    expect(parseExternalReference("ER_123456")).toBeNull();
    expect(parseExternalReference(`${SALE}-0`)).toBeNull();
    expect(parseExternalReference(undefined)).toBeNull();
    expect(() => buildExternalReference("nope", 1)).toThrow(TypeError);
    expect(() => buildExternalReference(SALE, 0)).toThrow(RangeError);
  });
});

describe("create order body (Orders API, type qr)", () => {
  const base = { externalReference: SALE, amountCents: 7_500_000, externalPosId: "AVENIDA01", mode: "static" as const, expirationMinutes: 15 };
  it("matches the documented shape", () => {
    expect(buildCreateQrOrderBody(base)).toEqual({
      type: "qr",
      total_amount: "75000.00",
      description: "Venta carniceria",
      external_reference: SALE,
      expiration_time: "PT15M",
      config: { qr: { external_pos_id: "AVENIDA01", mode: "static" } },
      transactions: { payments: [{ amount: "75000.00" }] }
    });
  });
  it("keeps the order total equal to the single payment amount", () => {
    const body = buildCreateQrOrderBody({ ...base, amountCents: 4_500_050 });
    expect(body.total_amount).toBe(body.transactions.payments[0]?.amount);
  });
  it("rejects invalid inputs", () => {
    expect(() => buildCreateQrOrderBody({ ...base, amountCents: 0 })).toThrow(RangeError);
    expect(() => buildCreateQrOrderBody({ ...base, amountCents: 1.5 })).toThrow(RangeError);
    expect(() => buildCreateQrOrderBody({ ...base, expirationMinutes: 0 })).toThrow(RangeError);
    expect(() => buildCreateQrOrderBody({ ...base, externalPosId: "bad id!" })).toThrow(TypeError);
    expect(() => buildCreateQrOrderBody({ ...base, externalReference: "a".repeat(65) })).toThrow(TypeError);
  });
});

describe("interpretOrder — only processed+accredited confirms", () => {
  it("confirms an accredited payment and extracts the paid amount", () => {
    const result = interpretOrder({
      id: "ORD1", status: "processed", status_detail: "accredited", total_amount: "750.00",
      transactions: { payments: [{ id: "PAY1", status: "processed", status_detail: "accredited", amount: "750.00", paid_amount: "750.00" }] }
    });
    expect(result).toMatchObject({ status: "CONFIRMED", paidAmountCents: 75_000, totalAmountCents: 75_000, mpPaymentId: "PAY1" });
  });
  it("accepts the notification-body shape (no payments array)", () => {
    expect(interpretOrder({ status: "processed", status_detail: "accredited", total_amount: "30.00" }).status).toBe("CONFIRMED");
  });
  it("never confirms processed with another detail or a non-processed payment", () => {
    expect(interpretOrder({ status: "processed", status_detail: "partially_refunded" }).status).toBe("UNKNOWN");
    expect(interpretOrder({ status: "processed", status_detail: "accredited", transactions: { payments: [{ status: "created" }] } }).status).toBe("UNKNOWN");
    expect(interpretOrder({ status: "processed" }).status).toBe("UNKNOWN");
  });
  it("maps the other documented states", () => {
    expect(interpretOrder({ status: "created", status_detail: "created" }).status).toBe("CREATED");
    expect(interpretOrder({ status: "expired" }).status).toBe("EXPIRED");
    expect(interpretOrder({ status: "canceled" }).status).toBe("CANCELLED");
    expect(interpretOrder({ status: "refunded" }).status).toBe("REFUNDED");
    expect(interpretOrder({ status: "failed" }).status).toBe("ERROR");
    expect(interpretOrder({ status: "something_new" }).status).toBe("UNKNOWN");
    expect(interpretOrder({}).status).toBe("UNKNOWN");
  });
});

describe("webhook signature", () => {
  const secret = "test-webhook-secret-not-real";
  const dataId = "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3";
  const requestId = "req-abc-123";
  const ts = "1704908010";
  // Independent implementation of the documented manifest (id lowercased; request-id; ts).
  const reference = createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");

  it("builds the documented manifest", () => {
    expect(buildSignatureManifest(dataId, requestId, ts)).toBe("id:ord01jq4s4ky8hwq6na5pxb65b3d3;request-id:req-abc-123;ts:1704908010;");
  });
  it("omits absent manifest parts", () => {
    expect(buildSignatureManifest(null, null, ts)).toBe("ts:1704908010;");
    expect(buildSignatureManifest(dataId, null, ts)).toBe("id:ord01jq4s4ky8hwq6na5pxb65b3d3;ts:1704908010;");
  });
  it("matches an independent HMAC-SHA256", async () => {
    expect(await computeWebhookSignature(secret, dataId, requestId, ts)).toBe(reference);
  });
  it("accepts a valid signature, whatever the case of data.id", async () => {
    const header = `ts=${ts},v1=${reference}`;
    expect(await verifyWebhookSignature({ secret, signatureHeader: header, requestId, dataId })).toBe(true);
    expect(await verifyWebhookSignature({ secret, signatureHeader: header, requestId, dataId: dataId.toLowerCase() })).toBe(true);
  });
  it("rejects wrong secret, tampering, missing or malformed headers", async () => {
    const header = `ts=${ts},v1=${reference}`;
    expect(await verifyWebhookSignature({ secret: "other", signatureHeader: header, requestId, dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: header, requestId, dataId: "ORDOTHER" })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: header, requestId: "other", dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: `ts=${ts}x,v1=${reference}`, requestId, dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: `ts=${ts},v1=${"0".repeat(64)}`, requestId, dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: null, requestId, dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret, signatureHeader: "garbage", requestId, dataId })).toBe(false);
    expect(await verifyWebhookSignature({ secret: "", signatureHeader: header, requestId, dataId })).toBe(false);
  });
  it("parses the header", () => {
    expect(parseSignatureHeader(" ts=1 , v1=ab ")).toEqual({ ts: "1", v1: "ab" });
    expect(parseSignatureHeader("v1=ab")).toBeNull();
  });
});

describe("notification parsing", () => {
  it("prefers data.id from the query (the one that is signed)", () => {
    expect(parseNotification("https://x.test/mp-webhook?data.id=ORDQ&type=order", { type: "order", action: "order.processed", data: { id: "ORDB" } }))
      .toEqual({ type: "order", action: "order.processed", dataId: "ORDQ" });
  });
  it("falls back to the body and tolerates garbage", () => {
    expect(parseNotification("https://x.test/mp-webhook", { type: "order", data: { id: "ORDB" } }).dataId).toBe("ORDB");
    expect(parseNotification("not a url", null)).toEqual({ type: null, action: null, dataId: null });
  });
});

describe("POS payment panel — never claims a payment that the backend has not confirmed", () => {
  const view = (status: Parameters<typeof describePaymentState>[0]["status"], verification: Parameters<typeof describePaymentState>[0]["verification"] = null, online = true) =>
    describePaymentState({ status, verification, online });

  it("shows 'Pago confirmado' only for CONFIRMED", () => {
    const confirmed = view("CONFIRMED", "CONFIRMED");
    expect(confirmed.title).toContain("Pago confirmado");
    expect(confirmed.tone).toBe("success");
    for (const status of ["REQUESTING", "CREATED", "EXPIRED", "CANCELLED", "ERROR", "REFUNDED", null] as const) {
      expect(view(status).title).not.toContain("confirmado");
      expect(view(status).tone).not.toBe("success");
    }
  });
  it("does not trust a CONFIRMED order while the sale payment is still PENDING or mismatched", () => {
    expect(view("CONFIRMED", "PENDING").tone).not.toBe("success");
    expect(view("CONFIRMED", "MISMATCH").tone).toBe("error");
  });
  it("waiting state polls and can be cancelled; offline never says confirmed and cannot cancel", () => {
    expect(view("CREATED")).toMatchObject({ title: "Esperando pago…", polling: true, canCancel: true });
    expect(view("CREATED", null, false)).toMatchObject({ title: "Pago pendiente", polling: true, canCancel: false });
  });
  it("a technical ERROR can be retried or the sale annulled; it is not a cancellation", () => {
    const v = view("ERROR");
    expect(v).toMatchObject({ canRetry: true, canCancel: true, polling: false, outcome: "WAITING", tone: "error" });
    expect(v.title).not.toContain("cancelado");
  });
  it("CANCELLED and EXPIRED are terminal and not paid: never retryable, never cancellable, never pending", () => {
    for (const status of ["EXPIRED", "CANCELLED"] as const) {
      const v = view(status);
      expect(v).toMatchObject({ outcome: "NOT_PAID", canRetry: false, canCancel: false, polling: false });
      expect(v.detail).toContain("anulada");
    }
    expect(view("CANCELLED").title).toBe("Cobro cancelado");
    expect(view("EXPIRED").title).toBe("Cobro vencido");
    // Sale annulled with no live order (abandoned before a charge existed): same final reading.
    expect(view(null, "CANCELLED")).toMatchObject({ outcome: "NOT_PAID", canRetry: false });
    expect(view(null, "EXPIRED")).toMatchObject({ outcome: "NOT_PAID", canRetry: false });
  });
  it("a pending charge is the only one the cashier can resume or cancel", () => {
    expect(view("CREATED")).toMatchObject({ outcome: "WAITING", canCancel: true, cancelLabel: "Cancelar cobro" });
    expect(view(null)).toMatchObject({ outcome: "WAITING", canRetry: true, canCancel: true });
    expect(view("CONFIRMED", "CONFIRMED").outcome).toBe("PAID");
    expect(view("CONFIRMED", "MISMATCH").outcome).toBe("NEEDS_ATTENTION");
    expect(view("REFUNDED").outcome).toBe("NEEDS_ATTENTION");
  });
});

describe("which Mercado Pago charges the cashier can resume ('MP pendientes')", () => {
  it("only a charge still waiting (PENDING) or technically failed (ERROR) is recoverable", () => {
    expect(isRecoverableMercadoPagoPayment("PENDING")).toBe(true);
    expect(isRecoverableMercadoPagoPayment("ERROR")).toBe(true);
  });
  it("no terminal state is ever recoverable", () => {
    for (const status of ["CONFIRMED", "CANCELLED", "CANCELED", "EXPIRED", "REFUNDED", "MISMATCH", "NO_ACCREDITATION", "NOT_REQUIRED", null, undefined, ""]) {
      expect(isRecoverableMercadoPagoPayment(status)).toBe(false);
    }
  });
  it("cancelled and expired charges are the 'not accredited' ones", () => {
    expect(isNotAccreditedVerification("CANCELLED")).toBe(true);
    expect(isNotAccreditedVerification("EXPIRED")).toBe(true);
    for (const status of ["PENDING", "CONFIRMED", "ERROR", "MISMATCH", "REFUNDED", null]) expect(isNotAccreditedVerification(status)).toBe(false);
  });
});

describe("Store / POS setup payloads (built only, never sent here)", () => {
  const store = { name: "Avenida", externalId: "AVENIDA", streetName: "Av. X", streetNumber: "123", cityName: "Ciudad", stateName: "Provincia", latitude: -34.6, longitude: -58.4 };
  it("builds a store payload", () => {
    expect(buildStorePayload(store)).toMatchObject({ name: "Avenida", external_id: "AVENIDA", location: { latitude: -34.6, longitude: -58.4 } });
  });
  it("validates the store", () => {
    expect(() => buildStorePayload({ ...store, externalId: "bad id" })).toThrow(TypeError);
    expect(() => buildStorePayload({ ...store, latitude: 200 })).toThrow(RangeError);
  });
  it("builds a POS payload without inventing a category", () => {
    const payload = buildPosPayload({ name: "Caja 1", externalId: "AVENIDA01", externalStoreId: "AVENIDA" });
    expect(payload).toEqual({ name: "Caja 1", external_id: "AVENIDA01", external_store_id: "AVENIDA" });
    expect(buildPosPayload({ name: "Caja 1", externalId: "AVENIDA01", storeId: "123", category: 5411 })).toMatchObject({ store_id: 123, category: 5411 });
    expect(() => buildPosPayload({ name: "x", externalId: "AVENIDA01" })).toThrow(TypeError);
  });
});
