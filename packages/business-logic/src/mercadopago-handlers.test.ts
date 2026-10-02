import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleAdminSetup,
  handleCancelOrder,
  handleCreateOrder,
  handleOrderStatus,
  handleWebhook,
  type HandlerDeps
} from "../../../supabase/functions/_shared/handlers.ts";

// Todos los valores sensibles de este archivo son falsos: nunca se usa una credencial real.
const FAKE_ACCESS_TOKEN = "APP_USR-fake-access-token-for-tests";
const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-for-tests";
const FAKE_SERVICE_KEY = "fake-service-role-key";
const SUPABASE_URL = "https://project.supabase.test";

const DEVICE = "c4000000-0000-4000-8000-000000000001";
const SALE = "c7000000-0000-4000-8000-000000000001";
const OPERATOR = "c1000000-0000-4000-8000-000000000003";
const TOKEN64 = "c".repeat(64);
const MP_ORDER = "ORD01TEST0000000000000000001";
const ORDER_ID = "d0000000-0000-4000-8000-000000000001";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown } | Error;
type Route = (call: Call) => Reply;

let calls: Call[];
let routes: Map<string, Route>;
let nowMs: number;

const env: Record<string, string | undefined> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "fake-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
  MERCADOPAGO_ACCESS_TOKEN: FAKE_ACCESS_TOKEN,
  MERCADOPAGO_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET
};

function route(key: string, handler: Route | Reply) {
  routes.set(key, typeof handler === "function" ? handler : () => handler);
}

function deps(overrides: Partial<Record<string, string | undefined>> = {}): HandlerDeps {
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const call: Call = { method, url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
    calls.push(call);
    const path = url.startsWith(SUPABASE_URL) ? url.slice(SUPABASE_URL.length) : url.replace("https://api.mercadopago.com", "MP");
    const handler = routes.get(`${method} ${path}`);
    if (!handler) return Promise.reject(new Error(`unexpected request ${method} ${path}`));
    const reply = handler(call);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status }));
  };
  return {
    env: (name) => (name in overrides ? overrides[name] : env[name]),
    fetch: fakeFetch,
    now: () => nowMs,
    log: () => undefined
  };
}

const rpcPath = (name: string) => `/rest/v1/rpc/${name}`;
const rpcCalls = (name: string) => calls.filter((c) => c.url.endsWith(rpcPath(name)));
const mpCalls = () => calls.filter((c) => c.url.startsWith("https://api.mercadopago.com"));

function request(path: string, body: unknown, init: { jwt?: string | null; method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  if (init.jwt !== null) headers.Authorization = `Bearer ${init.jwt ?? "user-jwt"}`;
  return new Request(`https://fn.test/${path}`, {
    method: init.method ?? "POST",
    headers,
    ...((init.method ?? "POST") === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
}

const preparedOrder = (over: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID, saleId: SALE, attempt: 1, status: "REQUESTING", externalReference: SALE,
  idempotencyKey: "e0000000-0000-4000-8000-000000000001", externalPosId: "AVENIDA01", expirationMinutes: 15,
  expectedAmountCents: 7_500_000, confirmedAmountCents: null, amountMismatch: false, mpOrderId: null,
  expiresAt: null, createdAt: "2026-10-01T17:35:00Z", confirmedAt: null, lastCheckedAt: null, needsMpCall: true,
  qrMode: "static", isNew: true, ...over
});

const createBody = { deviceId: DEVICE, saleId: SALE, amountCents: 7_500_000, operatorProfileId: OPERATOR, operatorToken: TOKEN64 };

function expectNoSecrets(response: Response, text: string) {
  const serialized = text + JSON.stringify([...response.headers.entries()]);
  for (const secret of [FAKE_ACCESS_TOKEN, FAKE_WEBHOOK_SECRET, FAKE_SERVICE_KEY, "e0000000-0000-4000-8000-000000000001"]) {
    expect(serialized).not.toContain(secret);
  }
}

beforeEach(() => {
  calls = [];
  routes = new Map();
  nowMs = Date.parse("2026-10-01T17:36:00Z");
});

describe("mp-create-order", () => {
  it("reserves, creates the Mercado Pago order with the sale id as external_reference, and records it", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    route("POST MP/v1/orders", { status: 201, body: { id: MP_ORDER, status: "created", status_detail: "created", transactions: { payments: [{ id: "PAY1", status: "created" }] } } });
    route(`POST ${rpcPath("mp_record_order_result")}`, { status: 200, body: preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false }) });

    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    const text = await response.clone().text();
    const json = JSON.parse(text) as { ok: boolean; order: { status: string; saleId: string } };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.order).toMatchObject({ status: "CREATED", saleId: SALE });

    // The device JWT (not the service key) authorizes the reservation; the service key records the result.
    expect(rpcCalls("mp_prepare_order")[0]?.headers.authorization).toBe("Bearer user-jwt");
    expect(rpcCalls("mp_record_order_result")[0]?.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);

    const [mp] = mpCalls();
    expect(mp?.headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(mp?.headers["x-idempotency-key"]).toBe("e0000000-0000-4000-8000-000000000001");
    expect(mp?.body).toMatchObject({
      type: "qr", total_amount: "75000.00", external_reference: SALE,
      config: { qr: { external_pos_id: "AVENIDA01", mode: "static" } }, transactions: { payments: [{ amount: "75000.00" }] }
    });
    expectNoSecrets(response, text);
  });

  it("is idempotent: an order that already exists is returned without calling Mercado Pago", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false, isNew: false }) });
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    expect(response.status).toBe(200);
    expect(mpCalls()).toHaveLength(0);
    expect(rpcCalls("mp_record_order_result")).toHaveLength(0);
  });

  it("keeps the order REQUESTING and reuses the same key when Mercado Pago is down (unknown outcome)", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    route("POST MP/v1/orders", { status: 503 });
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    expect(response.status).toBe(502);
    expect((await response.json() as { code: string }).code).toBe("MP_UNAVAILABLE");
    expect(rpcCalls("mp_record_order_result")).toHaveLength(0);
  });

  it("treats a network failure / timeout like an unknown outcome, never as an error state", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    route("POST MP/v1/orders", new Error("network down"));
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    expect(response.status).toBe(502);
    expect(rpcCalls("mp_record_order_result")).toHaveLength(0);
  });

  it("records a definitive rejection with a safe error code and no secrets", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    route("POST MP/v1/orders", { status: 404, body: { errors: [{ code: "pos_not_found", message: "internal detail" }] } });
    route(`POST ${rpcPath("mp_record_order_result")}`, { status: 200, body: preparedOrder({ status: "ERROR", needsMpCall: false }) });
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    const text = await response.clone().text();
    expect(response.status).toBe(422);
    expect(rpcCalls("mp_record_order_result")[0]?.body).toMatchObject({ p_order_id: ORDER_ID, p_mp_order_id: null, p_error_code: "mp_404_pos_not_found" });
    expect(text).not.toContain("internal detail");
    expectNoSecrets(response, text);
  });

  it("does not claim success when the created order cannot be recorded", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    route("POST MP/v1/orders", { status: 201, body: { id: MP_ORDER, status: "created" } });
    route(`POST ${rpcPath("mp_record_order_result")}`, { status: 500, body: { code: "XX000", message: "boom" } });
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps());
    expect(response.status).toBe(502);
    expect((await response.json() as { code: string }).code).toBe("RECORD_FAILED");
  });

  it("maps authorization and configuration errors from the database", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 400, body: { code: "P0001", message: "MP_NOT_CONFIGURED" } });
    expect((await handleCreateOrder(request("mp-create-order", createBody), deps())).status).toBe(409);
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 403, body: { code: "42501", message: "POS operator authorization is invalid" } });
    expect((await handleCreateOrder(request("mp-create-order", createBody), deps())).status).toBe(403);
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 400, body: { code: "22023", message: "Mercado Pago order already exists with another amount" } });
    expect((await handleCreateOrder(request("mp-create-order", createBody), deps())).status).toBe(422);
    expect(mpCalls()).toHaveLength(0);
  });

  it("refuses (409 SALE_NOT_PAYABLE) a new charge for a sale that was already annulled", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 400, body: { code: "P0001", message: "SALE_NOT_PAYABLE" } });
    const response = await handleCreateOrder(request("mp-create-order", { ...createBody, retry: true }), deps());
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe("SALE_NOT_PAYABLE");
    expect(mpCalls()).toHaveLength(0);
  });

  it("rejects bad input before touching anything", async () => {
    expect((await handleCreateOrder(request("mp-create-order", createBody, { jwt: null }), deps())).status).toBe(401);
    expect((await handleCreateOrder(request("mp-create-order", { ...createBody, amountCents: -5 }), deps())).status).toBe(400);
    expect((await handleCreateOrder(request("mp-create-order", { ...createBody, amountCents: 10.5 }), deps())).status).toBe(400);
    expect((await handleCreateOrder(request("mp-create-order", { ...createBody, saleId: "nope" }), deps())).status).toBe(400);
    expect((await handleCreateOrder(request("mp-create-order", { ...createBody, operatorToken: "short" }), deps())).status).toBe(400);
    expect((await handleCreateOrder(request("mp-create-order", "not json"), deps())).status).toBe(400);
    expect((await handleCreateOrder(request("mp-create-order", {}, { method: "GET" }), deps())).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("answers CORS preflight for the desktop app", async () => {
    const response = await handleCreateOrder(new Request("https://fn.test/mp-create-order", { method: "OPTIONS" }), deps());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("fails closed (retryable, nothing recorded) when the server has no access token", async () => {
    route(`POST ${rpcPath("mp_prepare_order")}`, { status: 200, body: preparedOrder() });
    const response = await handleCreateOrder(request("mp-create-order", createBody), deps({ MERCADOPAGO_ACCESS_TOKEN: undefined }));
    expect(response.status).toBe(503);
    expect(mpCalls()).toHaveLength(0);
    expect(rpcCalls("mp_record_order_result")).toHaveLength(0);
  });
});

describe("mp-order-status", () => {
  const statusBody = { deviceId: DEVICE, saleId: SALE };
  const created = (over: Record<string, unknown> = {}) => preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false, verificationStatus: "PENDING", ...over });

  it("refreshes a stale pending order from Mercado Pago and returns the real state", async () => {
    let reads = 0;
    route(`POST ${rpcPath("mp_get_order_status")}`, () => ({ status: 200, body: reads++ === 0 ? created({ lastCheckedAt: "2026-10-01T17:30:00Z" }) : created({ status: "CONFIRMED", verificationStatus: "CONFIRMED", confirmedAmountCents: 7_500_000 }) }));
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "processed", status_detail: "accredited", total_amount: "75000.00", transactions: { payments: [{ id: "PAY1", status: "processed", paid_amount: "75000.00" }] } } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });

    const response = await handleOrderStatus(request("mp-order-status", statusBody), deps());
    const json = await response.json() as { order: { status: string; verificationStatus: string } };
    expect(json.order).toMatchObject({ status: "CONFIRMED", verificationStatus: "CONFIRMED" });
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({
      p_mp_order_id: MP_ORDER, p_external_reference: SALE, p_new_status: "CONFIRMED", p_paid_amount_cents: 7_500_000, p_total_amount_cents: 7_500_000, p_source: "POLL"
    });
    expect(rpcCalls("mp_apply_order_state")[0]?.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);
  });

  it("does not hammer Mercado Pago: a recently checked order is only read from the database", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: created({ lastCheckedAt: "2026-10-01T17:35:58Z" }) });
    const response = await handleOrderStatus(request("mp-order-status", statusBody), deps());
    expect(response.status).toBe(200);
    expect(mpCalls()).toHaveLength(0);
  });

  it("does not poll Mercado Pago for terminal orders", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: created({ status: "EXPIRED", lastCheckedAt: null }) });
    await handleOrderStatus(request("mp-order-status", statusBody), deps());
    expect(mpCalls()).toHaveLength(0);
  });

  it("returns the stored state (marked stale) if Mercado Pago cannot be reached", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: created({ lastCheckedAt: null }) });
    route(`GET MP/v1/orders/${MP_ORDER}`, new Error("offline"));
    const json = await (await handleOrderStatus(request("mp-order-status", statusBody), deps())).json() as { ok: boolean; stale: boolean; order: { status: string } };
    expect(json).toMatchObject({ ok: true, stale: true, order: { status: "CREATED" } });
  });

  it("returns null for a sale without a charge and rejects a foreign device", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: null });
    expect(await (await handleOrderStatus(request("mp-order-status", statusBody), deps())).json()).toMatchObject({ ok: true, order: null });
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 403, body: { code: "42501", message: "Device is not authorized" } });
    expect((await handleOrderStatus(request("mp-order-status", statusBody), deps())).status).toBe(403);
  });
});

describe("mp-cancel-order", () => {
  const body = { deviceId: DEVICE, saleId: SALE };
  const created = preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false });

  it("cancels at Mercado Pago, then re-reads the real state before applying it", async () => {
    let reads = 0;
    route(`POST ${rpcPath("mp_get_order_status")}`, () => ({ status: 200, body: reads++ === 0 ? created : { ...created, status: "CANCELLED" } }));
    route(`POST MP/v1/orders/${MP_ORDER}/cancel`, { status: 200, body: { status: "canceled" } });
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "canceled", status_detail: "canceled" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean };
    expect(json.cancelled).toBe(true);
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({ p_new_status: "CANCELLED", p_source: "CANCEL" });
  });

  it("if the customer already paid, the cancel fails at Mercado Pago and the payment is confirmed instead", async () => {
    let reads = 0;
    route(`POST ${rpcPath("mp_get_order_status")}`, () => ({ status: 200, body: reads++ === 0 ? created : { ...created, status: "CONFIRMED" } }));
    route(`POST MP/v1/orders/${MP_ORDER}/cancel`, { status: 409, body: { errors: [{ code: "cannot_cancel_order" }] } });
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "processed", status_detail: "accredited", total_amount: "75000.00" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean; order: { status: string } };
    expect(json.cancelled).toBe(false);
    expect(json.order.status).toBe("CONFIRMED");
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({ p_new_status: "CONFIRMED" });
  });

  it("does nothing for an order that is not awaiting payment", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: { ...created, status: "CONFIRMED" } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean };
    expect(json.cancelled).toBe(false);
    expect(mpCalls()).toHaveLength(0);
    expect(rpcCalls("mp_abandon_unpaid_sale")).toHaveLength(0);
  });

  it("reports the annulled sale to the POS after a successful cancellation (so it can close the panel)", async () => {
    let reads = 0;
    route(`POST ${rpcPath("mp_get_order_status")}`, () => ({ status: 200, body: reads++ === 0 ? created : { ...created, status: "CANCELLED", verificationStatus: "CANCELLED", saleStatus: "CANCELLED" } }));
    route(`POST MP/v1/orders/${MP_ORDER}/cancel`, { status: 200, body: { status: "canceled" } });
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "canceled", status_detail: "canceled" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean; order: { status: string; verificationStatus: string; saleStatus: string } };
    expect(json.cancelled).toBe(true);
    expect(json.order).toMatchObject({ status: "CANCELLED", verificationStatus: "CANCELLED", saleStatus: "CANCELLED" });
  });

  it("an order still CREATED after the attempt (Mercado Pago did not cancel) is NOT reported as cancelled", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: created });
    route(`POST MP/v1/orders/${MP_ORDER}/cancel`, { status: 500 });
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "created", status_detail: "created" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean; order: { status: string } };
    expect(json.cancelled).toBe(false);
    expect(json.order.status).toBe("CREATED");
  });

  it("with no live charge (failed creation) the unpaid sale is annulled in the backend, never at Mercado Pago", async () => {
    let reads = 0;
    route(`POST ${rpcPath("mp_get_order_status")}`, () => ({ status: 200, body: reads++ === 0 ? { ...created, status: "ERROR", mpOrderId: null } : { saleId: SALE, status: null, verificationStatus: "CANCELLED", saleStatus: "CANCELLED" } }));
    route(`POST ${rpcPath("mp_abandon_unpaid_sale")}`, { status: 200, body: { saleId: SALE, abandoned: true, changed: true, saleStatus: "CANCELLED" } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean; order: { saleStatus: string } };
    expect(json.cancelled).toBe(true);
    expect(json.order.saleStatus).toBe("CANCELLED");
    expect(mpCalls()).toHaveLength(0);
    // The device JWT authorizes it (the RPC validates device/branch), not the service key.
    expect(rpcCalls("mp_abandon_unpaid_sale")[0]?.headers.authorization).toBe("Bearer user-jwt");
  });

  it("is idempotent for an already finished charge: cancelling again changes nothing and still answers 'cancelled'", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: { ...created, status: "CANCELLED", verificationStatus: "CANCELLED", saleStatus: "CANCELLED" } });
    route(`POST ${rpcPath("mp_abandon_unpaid_sale")}`, { status: 200, body: { saleId: SALE, abandoned: true, changed: false, saleStatus: "CANCELLED" } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean };
    expect(json.cancelled).toBe(true);
    expect(mpCalls()).toHaveLength(0);
  });

  it("does not annul a sale whose charge is still being created (it might be paid any moment)", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: { ...created, status: "REQUESTING", mpOrderId: null } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean };
    expect(json.cancelled).toBe(false);
    expect(rpcCalls("mp_abandon_unpaid_sale")).toHaveLength(0);
    expect(mpCalls()).toHaveLength(0);
  });

  it("asks the cashier to wait when the sale has not reached the server yet", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: null });
    route(`POST ${rpcPath("mp_abandon_unpaid_sale")}`, { status: 200, body: { saleId: SALE, abandoned: false, reason: "SALE_NOT_SYNCED" } });
    const response = await handleCancelOrder(request("mp-cancel-order", body), deps());
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe("SALE_NOT_SYNCED");
  });

  it("never reports a sale as cancelled when the backend refuses to abandon it (paid / not pending)", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: { ...created, status: "ERROR", mpOrderId: null } });
    route(`POST ${rpcPath("mp_abandon_unpaid_sale")}`, { status: 200, body: { saleId: SALE, abandoned: false, reason: "NOT_PENDING", saleStatus: "COMPLETED" } });
    const json = await (await handleCancelOrder(request("mp-cancel-order", body), deps())).json() as { cancelled: boolean };
    expect(json.cancelled).toBe(false);
  });
});

describe("mp-webhook", () => {
  const ts = "1704908010";
  const requestId = "req-1";

  function webhook(opts: { body?: unknown; dataId?: string; secret?: string; signature?: string | null; type?: string } = {}) {
    const dataId = opts.dataId ?? MP_ORDER;
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac("sha256", opts.secret ?? FAKE_WEBHOOK_SECRET).update(manifest).digest("hex");
    const headers: Record<string, string> = { "x-request-id": requestId };
    if (opts.signature !== null) headers["x-signature"] = opts.signature ?? `ts=${ts},v1=${v1}`;
    return new Request(`https://fn.test/mp-webhook?data.id=${dataId}&type=${opts.type ?? "order"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? { type: opts.type ?? "order", action: "order.processed", data: { id: dataId, status: "processed", status_detail: "accredited" } })
    });
  }

  const accreditedOrder = { id: MP_ORDER, external_reference: SALE, status: "processed", status_detail: "accredited", total_amount: "75000.00", transactions: { payments: [{ id: "PAY1", status: "processed", amount: "75000.00", paid_amount: "75000.00" }] } };

  it("rejects a bad or missing signature without touching Mercado Pago or the database", async () => {
    for (const request of [webhook({ secret: "wrong-secret" }), webhook({ signature: null }), webhook({ signature: "ts=1,v1=deadbeef" })]) {
      const response = await handleWebhook(request, deps());
      expect(response.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed (so Mercado Pago retries) when the secret is not configured", async () => {
    const response = await handleWebhook(webhook(), deps({ MERCADOPAGO_WEBHOOK_SECRET: undefined }));
    expect(response.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it("verifies, re-fetches the order from Mercado Pago, applies it and logs the event", async () => {
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: accreditedOrder });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true, status: "CONFIRMED" } });
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    const response = await handleWebhook(webhook(), deps());
    expect(response.status).toBe(200);
    expect(mpCalls()[0]?.headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({ p_new_status: "CONFIRMED", p_source: "WEBHOOK", p_paid_amount_cents: 7_500_000 });
    expect(rpcCalls("mp_record_webhook_event")[0]?.body).toMatchObject({ p_result: "APPLIED", p_mp_order_id: MP_ORDER, p_request_id: requestId, p_mp_status: "processed" });
  });

  it("never trusts the notification body: the state comes from the fetched order", async () => {
    // The (signed) body says accredited, but Mercado Pago says the order is still just created.
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { id: MP_ORDER, external_reference: SALE, status: "created", status_detail: "created", total_amount: "75000.00" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    await handleWebhook(webhook(), deps());
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({ p_new_status: "CREATED" });
  });

  it("handles duplicated deliveries: the same notification twice applies the same state", async () => {
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: accreditedOrder });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 2 });
    expect((await handleWebhook(webhook(), deps())).status).toBe(200);
    expect((await handleWebhook(webhook(), deps())).status).toBe(200);
    const [first, second] = rpcCalls("mp_apply_order_state");
    expect(first?.body).toEqual(second?.body);
    expect(rpcCalls("mp_record_webhook_event")[0]?.body).toMatchObject({ p_dedupe_key: `order.processed|${MP_ORDER}|${requestId}` });
  });

  it("applies exactly the same transition as polling: same RPC, same arguments, only the source differs", async () => {
    const orders: Record<string, unknown>[] = [
      accreditedOrder,
      { id: MP_ORDER, external_reference: SALE, status: "canceled", status_detail: "canceled", total_amount: "75000.00" },
      { id: MP_ORDER, external_reference: SALE, status: "expired", status_detail: "expired", total_amount: "75000.00" },
      { id: MP_ORDER, external_reference: SALE, status: "created", status_detail: "created", total_amount: "75000.00" }
    ];
    for (const mpOrder of orders) {
      calls = []; routes = new Map();
      route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: mpOrder });
      route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
      route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
      route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false, lastCheckedAt: "2026-10-01T17:00:00Z" }) });
      await handleWebhook(webhook(), deps());
      await handleOrderStatus(request("mp-order-status", { deviceId: DEVICE, saleId: SALE }), deps());
      const applied = rpcCalls("mp_apply_order_state").map((call) => call.body as Record<string, unknown>);
      expect(applied).toHaveLength(2);
      const { p_source: webhookSource, ...webhookArgs } = applied[0] ?? {};
      const { p_source: pollSource, ...pollArgs } = applied[1] ?? {};
      expect(webhookSource).toBe("WEBHOOK");
      expect(pollSource).toBe("POLL");
      expect(webhookArgs).toEqual(pollArgs);
    }
  });

  it("works without the webhook at all: polling alone confirms, with no signature or secret involved", async () => {
    route(`POST ${rpcPath("mp_get_order_status")}`, { status: 200, body: preparedOrder({ status: "CREATED", mpOrderId: MP_ORDER, needsMpCall: false, lastCheckedAt: "2026-10-01T17:00:00Z" }) });
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: accreditedOrder });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: true } });
    await handleOrderStatus(request("mp-order-status", { deviceId: DEVICE, saleId: SALE }), deps({ MERCADOPAGO_WEBHOOK_SECRET: undefined }));
    expect(rpcCalls("mp_apply_order_state")[0]?.body).toMatchObject({ p_new_status: "CONFIRMED", p_source: "POLL" });
  });

  it("acknowledges (200) orders that are not ours, so Mercado Pago stops retrying", async () => {
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: { ...accreditedOrder, external_reference: "SOMETHING_ELSE" } });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 200, body: { found: false } });
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    expect((await handleWebhook(webhook(), deps())).status).toBe(200);
    expect(rpcCalls("mp_record_webhook_event")[0]?.body).toMatchObject({ p_result: "IGNORED_UNKNOWN_ORDER" });
  });

  it("returns an error (so Mercado Pago retries in 15 minutes) when the order cannot be fetched", async () => {
    route(`GET MP/v1/orders/${MP_ORDER}`, new Error("timeout"));
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    expect((await handleWebhook(webhook(), deps())).status).toBe(502);
    expect(rpcCalls("mp_apply_order_state")).toHaveLength(0);
    expect(rpcCalls("mp_record_webhook_event")[0]?.body).toMatchObject({ p_result: "FETCH_FAILED" });
  });

  it("returns an error when applying fails, so the notification is retried", async () => {
    route(`GET MP/v1/orders/${MP_ORDER}`, { status: 200, body: accreditedOrder });
    route(`POST ${rpcPath("mp_apply_order_state")}`, { status: 500, body: { code: "XX000", message: "boom" } });
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    expect((await handleWebhook(webhook(), deps())).status).toBe(500);
  });

  it("ignores other event topics without calling Mercado Pago", async () => {
    route(`POST ${rpcPath("mp_record_webhook_event")}`, { status: 200, body: 1 });
    const response = await handleWebhook(webhook({ type: "payment", body: { type: "payment", action: "payment.created", data: { id: MP_ORDER } } }), deps());
    expect(response.status).toBe(200);
    expect(mpCalls()).toHaveLength(0);
    expect(rpcCalls("mp_record_webhook_event")[0]?.body).toMatchObject({ p_result: "IGNORED_EVENT_TYPE" });
  });

  it("rejects non-POST methods", async () => {
    expect((await handleWebhook(new Request("https://fn.test/mp-webhook", { method: "GET" }), deps())).status).toBe(405);
  });
});

describe("mp-admin-setup", () => {
  const store = { name: "Avenida", externalId: "AVENIDA", streetName: "Av. X", streetNumber: "123", cityName: "Ciudad", stateName: "Provincia", latitude: -34.6, longitude: -58.4 };

  it("requires an admin", async () => {
    route(`POST ${rpcPath("mp_admin_context")}`, { status: 403, body: { code: "42501", message: "Permission payments.manage is required" } });
    expect((await handleAdminSetup(request("mp-admin-setup", { action: "store", store }), deps())).status).toBe(403);
    expect(mpCalls()).toHaveLength(0);
  });

  it("is a dry run by default: shows the exact payload and sends NOTHING to Mercado Pago", async () => {
    route(`POST ${rpcPath("mp_admin_context")}`, { status: 200, body: { organizationId: "o" } });
    const response = await handleAdminSetup(request("mp-admin-setup", { action: "store", store }), deps());
    const json = await response.json() as { dryRun: boolean; wouldSend: { external_id: string } };
    expect(json.dryRun).toBe(true);
    expect(json.wouldSend.external_id).toBe("AVENIDA");
    expect(mpCalls()).toHaveLength(0);
  });

  it("only creates the production resource with explicit confirm: true", async () => {
    route(`POST ${rpcPath("mp_admin_context")}`, { status: 200, body: { organizationId: "o" } });
    route("GET MP/users/me", { status: 200, body: { id: 123456 } });
    route("POST MP/users/123456/stores", { status: 201, body: { id: 777, external_id: "AVENIDA" } });
    const response = await handleAdminSetup(request("mp-admin-setup", { action: "store", store, confirm: true }), deps());
    const text = await response.clone().text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ok: true, dryRun: false, id: 777, externalId: "AVENIDA" });
    expect(mpCalls().at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expectNoSecrets(response, text);
  });

  it("creates a POS (caja) and returns the static QR links only on confirm", async () => {
    route(`POST ${rpcPath("mp_admin_context")}`, { status: 200, body: { organizationId: "o" } });
    route("POST MP/v2/pos", { status: 201, body: { id: 55, external_id: "AVENIDA01", qr_response: { image: "https://qr.test/img.png", template_document: "https://qr.test/doc.pdf" } } });
    const pos = { name: "Caja 1", externalId: "AVENIDA01", externalStoreId: "AVENIDA" };
    const json = await (await handleAdminSetup(request("mp-admin-setup", { action: "pos", pos, confirm: true }), deps())).json() as { qrImage: string };
    expect(json.qrImage).toBe("https://qr.test/img.png");
    expect(mpCalls()[0]?.body).toEqual({ name: "Caja 1", external_id: "AVENIDA01", external_store_id: "AVENIDA" });
  });

  it("rejects invalid payloads before any call", async () => {
    route(`POST ${rpcPath("mp_admin_context")}`, { status: 200, body: { organizationId: "o" } });
    const response = await handleAdminSetup(request("mp-admin-setup", { action: "store", store: { ...store, externalId: "bad id" }, confirm: true }), deps());
    expect(response.status).toBe(422);
    expect(mpCalls()).toHaveLength(0);
  });
});
