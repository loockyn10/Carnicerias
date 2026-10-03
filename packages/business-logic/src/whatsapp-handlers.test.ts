import { beforeEach, describe, expect, it } from "vitest";

import {
  handleSendTicket,
  handleWhatsAppWebhook,
  type WhatsAppHandlerDeps
} from "../../../supabase/functions/_shared/whatsapp-handlers.ts";
import {
  computeMetaSignature,
  createMetaCloudProvider,
  createMockProvider,
  parseStatusEvents,
  resolveWhatsAppConfig,
  verifyMetaSignature,
  type WhatsAppConfig,
  type WhatsAppProvider,
  type WhatsAppSendResult
} from "../../../supabase/functions/_shared/whatsapp.ts";

// Todos los valores sensibles de este archivo son falsos: nunca se usa una credencial real ni red.
const FAKE_TOKEN = "EAAG-fake-access-token-for-tests";
const FAKE_APP_SECRET = "fake-app-secret-for-tests";
const FAKE_VERIFY_TOKEN = "fake-verify-token-for-tests";
const FAKE_SERVICE_KEY = "fake-service-role-key";
const SUPABASE_URL = "https://project.supabase.test";

const DEVICE = "f4000000-0000-4000-8000-000000000001";
const SALE = "f7000000-0000-4000-8000-000000000001";
const OPERATOR = "f1000000-0000-4000-8000-000000000003";
const DELIVERY = "d1000000-0000-4000-8000-000000000001";
const TOKEN64 = "f".repeat(64);

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown } | Error;

let calls: Call[];
let routes: Map<string, (call: Call) => Reply>;

const env: Record<string, string | undefined> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "fake-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
  WHATSAPP_ACCESS_TOKEN: FAKE_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_GRAPH_VERSION: "v99.0",
  WHATSAPP_TEMPLATE_NAME: "ticket_compra",
  WHATSAPP_TEMPLATE_LANGUAGE: "es_AR",
  WHATSAPP_APP_SECRET: FAKE_APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: FAKE_VERIFY_TOKEN
};

function route(key: string, handler: ((call: Call) => Reply) | Reply) {
  routes.set(key, typeof handler === "function" ? handler : () => handler);
}

function deps(overrides: Partial<Record<string, string | undefined>> = {}, whatsapp?: WhatsAppConfig): WhatsAppHandlerDeps {
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const call: Call = { method, url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
    calls.push(call);
    const path = url.startsWith(SUPABASE_URL) ? url.slice(SUPABASE_URL.length) : url.replace("https://graph.facebook.com", "GRAPH");
    const handler = routes.get(`${method} ${path}`);
    if (!handler) return Promise.reject(new Error(`unexpected request ${method} ${path}`));
    const reply = handler(call);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status }));
  };
  return {
    env: (name) => (name in overrides ? overrides[name] : env[name]),
    fetch: fakeFetch,
    now: () => Date.parse("2026-10-02T17:36:00Z"),
    log: () => undefined,
    ...(whatsapp ? { whatsapp } : {})
  };
}

const rpcPath = (name: string) => `/rest/v1/rpc/${name}`;
const rpcCalls = (name: string) => calls.filter((c) => c.url.endsWith(rpcPath(name)));
const graphCalls = () => calls.filter((c) => c.url.startsWith("https://graph.facebook.com"));

function request(body: unknown, init: { jwt?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.jwt !== null) headers.Authorization = `Bearer ${init.jwt ?? "user-jwt"}`;
  return new Request("https://fn.test/whatsapp-send-ticket", {
    method: init.method ?? "POST",
    headers,
    ...((init.method ?? "POST") === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
}

const sendBody = { deviceId: DEVICE, saleId: SALE, operatorProfileId: OPERATOR, operatorToken: TOKEN64, phone: "+54 9 3496 123456" };

const preparedSale = (over: Record<string, unknown> = {}) => ({
  saleId: SALE, status: "COMPLETED", completedAt: "2026-10-02T17:35:00Z", totalCents: 1_650_000,
  organizationName: "Carnicerías Fran", branchName: "Avenida", timezone: "America/Argentina/Buenos_Aires",
  items: [
    { name: "Vacío", weightGrams: 1250, quantityUnits: null, unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_250_000, promotionMode: null, manualPriceApplied: false },
    { name: "Hamburguesa", weightGrams: null, quantityUnits: 4, unitPriceCents: 100_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 400_000, promotionMode: null, manualPriceApplied: false }
  ],
  payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 1_650_000 }],
  ...over
});
const prepared = (sale: Record<string, unknown> = preparedSale()) => ({ ok: true, deliveryId: DELIVERY, sale });

function expectNoSecrets(text: string, response: Response) {
  const serialized = text + JSON.stringify([...response.headers.entries()]);
  for (const secret of [FAKE_TOKEN, FAKE_APP_SECRET, FAKE_VERIFY_TOKEN, FAKE_SERVICE_KEY, "100000000000001", "5493496123456", "+5493496123456", "3496 123456"]) {
    expect(serialized).not.toContain(secret);
  }
}

beforeEach(() => {
  calls = [];
  routes = new Map();
});

describe("whatsapp-send-ticket", () => {
  const graphOk = { status: 200, body: { messaging_product: "whatsapp", contacts: [{ wa_id: "5493496123456" }], messages: [{ id: "wamid.HBgM123" }] } };

  it("sends a COMPLETED sale through the Cloud API template and records SENT", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route("POST GRAPH/v99.0/100000000000001/messages", graphOk);
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });

    const response = await handleSendTicket(request(sendBody), deps());
    const text = await response.clone().text();
    const json = JSON.parse(text) as { ok: boolean; delivery: { id: string; status: string; phoneMasked: string } };

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ ok: true, delivery: { id: DELIVERY, status: "SENT", phoneMasked: "+54*******3456" } });
    expectNoSecrets(text, response);

    // The device JWT (not the service key) authorizes the preparation, with the normalized E.164 phone.
    const prepare = rpcCalls("wa_prepare_ticket")[0];
    expect(prepare?.headers.authorization).toBe("Bearer user-jwt");
    expect(prepare?.body).toMatchObject({ p_device_id: DEVICE, p_sale_id: SALE, p_operator_profile_id: OPERATOR, p_phone: "+5493496123456", p_resend: false });
    // The Graph call: configured version, bearer token from secrets, template + 7 single-line body parameters.
    const graph = graphCalls()[0];
    expect(graph?.url).toBe("https://graph.facebook.com/v99.0/100000000000001/messages");
    expect(graph?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const sent = graph?.body as { to: string; type: string; template: { name: string; language: { code: string }; components: { type: string; parameters: { text: string }[] }[] } };
    expect(sent).toMatchObject({ to: "5493496123456", type: "template", template: { name: "ticket_compra", language: { code: "es_AR" } } });
    const params = sent.template.components[0]?.parameters.map((p) => p.text) ?? [];
    expect(params).toHaveLength(7);
    expect(params[0]).toBe("Carnicerías Fran");
    expect(params[4]).toBe("Vacío 1,250 kg x $10.000/kg = $12.500 | Hamburguesa 4 u. x $1.000 c/u = $4.000");
    expect(params[5]).toBe("$16.500");
    // The result is recorded with the service key.
    const record = rpcCalls("wa_record_send_result")[0];
    expect(record?.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);
    expect(record?.body).toMatchObject({ p_delivery_id: DELIVERY, p_provider_message_id: "wamid.HBgM123", p_error_code: null });
  });

  it("never trusts client-supplied totals, lines or text", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route("POST GRAPH/v99.0/100000000000001/messages", graphOk);
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });

    const response = await handleSendTicket(request({ ...sendBody, totalCents: 1, items: [{ name: "Gratis" }], text: "hola", total: "$1" }), deps());
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(graphCalls()[0]?.body);
    expect(serialized).toContain("$16.500");
    expect(serialized).not.toContain("Gratis");
    expect(serialized).not.toContain("hola");
    expect(JSON.stringify(rpcCalls("wa_prepare_ticket")[0]?.body)).not.toContain("Gratis");
  });

  it.each([
    ["PENDING_PAYMENT", 409, "SALE_NOT_COMPLETED"],
    ["CANCELLED", 409, "SALE_NOT_COMPLETED"]
  ])("blocks a %s sale and never calls WhatsApp", async (saleStatus, status, code) => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: { ok: false, code: "SALE_NOT_COMPLETED", saleStatus } });
    const response = await handleSendTicket(request(sendBody), deps());
    const json = await response.json() as { code: string; saleStatus: string };
    expect(response.status).toBe(status);
    expect(json).toMatchObject({ code, saleStatus });
    expect(graphCalls()).toHaveLength(0);
  });

  it("re-checks eligibility on the data it received: a non-COMPLETED sale slipping through is never sent", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared(preparedSale({ status: "PENDING_PAYMENT" })) });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    const response = await handleSendTicket(request(sendBody), deps());
    expect(response.status).toBe(409);
    expect(graphCalls()).toHaveLength(0);
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_provider_message_id: null, p_error_code: "SALE_NOT_COMPLETED" });
  });

  it("refuses to send a ticket whose lines do not add up to the server total", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared(preparedSale({ totalCents: 999 })) });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    const response = await handleSendTicket(request(sendBody), deps());
    expect(response.status).toBe(500);
    expect(graphCalls()).toHaveLength(0);
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_error_code: "TOTAL_MISMATCH" });
  });

  it("maps a sale of another branch/organization (42501) to FORBIDDEN without calling WhatsApp", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 403, body: { code: "42501", message: "Sale is not available for this device" } });
    const response = await handleSendTicket(request(sendBody), deps());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(graphCalls()).toHaveLength(0);
  });

  it("reports a sale that has not synced yet", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: { ok: false, code: "SALE_NOT_FOUND" } });
    const response = await handleSendTicket(request(sendBody), deps());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SALE_NOT_FOUND" });
  });

  it("asks for confirmation when the ticket was already sent, and resends only on request", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, (call) => (call.body as { p_resend: boolean }).p_resend
      ? { status: 200, body: prepared() }
      : { status: 200, body: { ok: false, code: "ALREADY_SENT", status: "DELIVERED", sentAt: "2026-10-02T17:36:00Z", phoneMasked: "+54*******3456" } });
    route("POST GRAPH/v99.0/100000000000001/messages", graphOk);
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });

    const first = await handleSendTicket(request(sendBody), deps());
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "ALREADY_SENT", delivery: { status: "DELIVERED", phoneMasked: "+54*******3456" } });
    expect(graphCalls()).toHaveLength(0);

    const second = await handleSendTicket(request({ ...sendBody, resend: true }), deps());
    expect(second.status).toBe(200);
    expect(rpcCalls("wa_prepare_ticket")[1]?.body).toMatchObject({ p_resend: true });
    expect(graphCalls()).toHaveLength(1);
  });

  it("validates the phone before touching the database or WhatsApp", async () => {
    for (const phone of ["", "3496 1234", "abc", "+54 9 3496"]) {
      const response = await handleSendTicket(request({ ...sendBody, phone }), deps());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "INVALID_PHONE" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a session and complete device/operator data", async () => {
    expect((await handleSendTicket(request(sendBody, { jwt: null }), deps())).status).toBe(401);
    expect((await handleSendTicket(request({ ...sendBody, operatorToken: "short" }), deps())).status).toBe(400);
    expect((await handleSendTicket(request({ ...sendBody, saleId: "nope" }), deps())).status).toBe(400);
    expect((await handleSendTicket(request("not json"), deps())).status).toBe(400);
    expect((await handleSendTicket(request(sendBody, { method: "GET" }), deps())).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("answers 503 (and touches nothing) when the WhatsApp secrets are missing", async () => {
    const response = await handleSendTicket(request(sendBody), deps({ WHATSAPP_ACCESS_TOKEN: undefined }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
    expect(calls).toHaveLength(0);
  });

  it("records FAILED and exposes only a safe error when Meta rejects the message, then a retry succeeds", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    route("POST GRAPH/v99.0/100000000000001/messages", {
      status: 400,
      body: { error: { message: "(#131030) Recipient phone number not in allowed list", type: "OAuthException", code: 131030, fbtrace_id: "ABC" } }
    });

    const failed = await handleSendTicket(request(sendBody), deps());
    const failedText = await failed.clone().text();
    expect(failed.status).toBe(502);
    expect(JSON.parse(failedText)).toMatchObject({ ok: false, code: "WHATSAPP_SEND_FAILED", providerCode: "131030", retryable: false });
    expectNoSecrets(failedText, failed);
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_provider_message_id: null, p_error_code: "131030" });

    // Retry ("Reintentar"): same request, new attempt, now Meta accepts it.
    route("POST GRAPH/v99.0/100000000000001/messages", graphOk);
    const retried = await handleSendTicket(request(sendBody), deps());
    expect(retried.status).toBe(200);
    expect(rpcCalls("wa_prepare_ticket")).toHaveLength(2);
    expect(rpcCalls("wa_record_send_result")[1]?.body).toMatchObject({ p_provider_message_id: "wamid.HBgM123" });
  });

  it("flags a network failure as retryable and records it", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    route("POST GRAPH/v99.0/100000000000001/messages", new Error("socket hang up"));
    const response = await handleSendTicket(request(sendBody), deps());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "WHATSAPP_SEND_FAILED", providerCode: "NETWORK", retryable: true });
  });

  it("works end to end with an injected provider (no Meta, no credentials)", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const mock = createMockProvider();
    const response = await handleSendTicket(request(sendBody), deps({ WHATSAPP_ACCESS_TOKEN: undefined }, { provider: mock, templateName: "ticket_compra", languageCode: "es_AR" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, simulated: true });
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toMatchObject({ to: "5493496123456", templateName: "ticket_compra" });
    expect(graphCalls()).toHaveLength(0);

    const failing = createMockProvider({ outcome: "failed", code: "MOCK_FAILED" });
    const failedResponse = await handleSendTicket(request(sendBody), deps({}, { provider: failing, templateName: "ticket_compra", languageCode: "es_AR" }));
    expect(failedResponse.status).toBe(502);
  });

  it("an injected provider that returns whatever it likes is isolated from the flow", async () => {
    route(`POST ${rpcPath("wa_prepare_ticket")}`, { status: 200, body: prepared() });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const scripted: WhatsAppSendResult = { ok: false, code: "X", message: "boom", retryable: true };
    const provider: WhatsAppProvider = { name: "scripted", sendTemplate: () => Promise.resolve(scripted), sendText: () => Promise.resolve(scripted) };
    const response = await handleSendTicket(request(sendBody), deps({}, { provider, templateName: "t", languageCode: "es_AR" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ providerCode: "X", retryable: true });
  });
});

describe("meta cloud provider", () => {
  it("builds the template payload and parses the message id", async () => {
    route("POST GRAPH/v21.0/PN1/messages", { status: 200, body: { messages: [{ id: "wamid.ABC" }] } });
    const provider = createMetaCloudProvider({ fetch: deps().fetch, accessToken: FAKE_TOKEN, phoneNumberId: "PN1", graphVersion: "21.0" });
    const result = await provider.sendTemplate({ to: "5493496123456", templateName: "ticket_compra", languageCode: "es_AR", bodyParameters: ["a", "b"] });
    expect(result).toEqual({ ok: true, messageId: "wamid.ABC" });
    expect(graphCalls()[0]?.url).toBe("https://graph.facebook.com/v21.0/PN1/messages");
  });

  it("treats rate limits and 5xx as retryable and auth errors as not", async () => {
    const provider = createMetaCloudProvider({ fetch: deps().fetch, accessToken: FAKE_TOKEN, phoneNumberId: "PN1", graphVersion: "v21.0" });
    const message = { to: "1", templateName: "t", languageCode: "es_AR", bodyParameters: ["a"] };
    route("POST GRAPH/v21.0/PN1/messages", { status: 429, body: { error: { code: 130429, message: "Rate limit hit" } } });
    expect(await provider.sendTemplate(message)).toMatchObject({ ok: false, code: "130429", retryable: true });
    route("POST GRAPH/v21.0/PN1/messages", { status: 500, body: "" });
    expect(await provider.sendTemplate(message)).toMatchObject({ ok: false, code: "HTTP_500", retryable: true });
    route("POST GRAPH/v21.0/PN1/messages", { status: 401, body: { error: { code: 190, message: "Invalid OAuth access token" } } });
    expect(await provider.sendTemplate(message)).toMatchObject({ ok: false, code: "190", retryable: false });
    route("POST GRAPH/v21.0/PN1/messages", { status: 200, body: { messages: [] } });
    expect(await provider.sendTemplate(message)).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
  });

  it("can attach a document header (future PDF) without changing the flow", async () => {
    route("POST GRAPH/v21.0/PN1/messages", { status: 200, body: { messages: [{ id: "wamid.PDF" }] } });
    const provider = createMetaCloudProvider({ fetch: deps().fetch, accessToken: FAKE_TOKEN, phoneNumberId: "PN1", graphVersion: "v21.0" });
    await provider.sendTemplate({ to: "1", templateName: "t", languageCode: "es_AR", bodyParameters: ["a"], header: { type: "document", link: "https://x.test/t.pdf", filename: "ticket.pdf" } });
    const components = (graphCalls()[0]?.body as { template: { components: { type: string }[] } }).template.components;
    expect(components.map((c) => c.type)).toEqual(["header", "body"]);
  });
});

describe("configuration", () => {
  it("lists only the NAMES of the missing secrets", () => {
    const result = resolveWhatsAppConfig({ env: () => undefined, fetch });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.missing).toEqual(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION", "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_TEMPLATE_LANGUAGE"]);
  });

  it("does not freeze a Graph API version: it comes from the secret", () => {
    expect(resolveWhatsAppConfig({ env: (name) => (name === "WHATSAPP_GRAPH_VERSION" ? undefined : env[name]), fetch })).toMatchObject({ ok: false, missing: ["WHATSAPP_GRAPH_VERSION"] });
  });

  it("offers a credential-free mock provider only when explicitly requested", () => {
    expect(resolveWhatsAppConfig({ env: () => undefined, fetch }).ok).toBe(false);
    const mock = resolveWhatsAppConfig({ env: (name) => (name === "WHATSAPP_PROVIDER" ? "mock" : undefined), fetch });
    expect(mock.ok && mock.config.provider.name).toBe("mock");
  });
});

// ---------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------

function statusPayload(statuses: unknown[]) {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN1" }, statuses } }] }] };
}

async function webhookRequest(payload: unknown, options: { signature?: string | null; secret?: string } = {}): Promise<Request> {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = options.signature === undefined ? await computeMetaSignature(options.secret ?? FAKE_APP_SECRET, new TextEncoder().encode(raw)) : options.signature;
  return new Request("https://fn.test/whatsapp-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
    body: raw
  });
}

describe("whatsapp-webhook — verification (GET)", () => {
  const get = (query: string) => new Request(`https://fn.test/whatsapp-webhook?${query}`, { method: "GET" });

  it("echoes hub.challenge when the verify token matches", async () => {
    const response = await handleWhatsAppWebhook(get(`hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1158201444`), deps());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
  });

  it("rejects a wrong token, a wrong mode or a missing challenge", async () => {
    expect((await handleWhatsAppWebhook(get("hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"), deps())).status).toBe(403);
    expect((await handleWhatsAppWebhook(get(`hub.mode=unsubscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}&hub.challenge=1`), deps())).status).toBe(403);
    expect((await handleWhatsAppWebhook(get(`hub.mode=subscribe&hub.verify_token=${FAKE_VERIFY_TOKEN}`), deps())).status).toBe(403);
  });

  it("fails closed when the verify token is not configured", async () => {
    const response = await handleWhatsAppWebhook(get("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), deps({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: undefined }));
    expect(response.status).toBe(500);
  });
});

describe("whatsapp-webhook — status events (POST)", () => {
  const apply = (result: string) => route(`POST ${rpcPath("wa_apply_status_event")}`, { status: 200, body: { result } });

  it.each([
    ["sent", "SENT"],
    ["delivered", "DELIVERED"],
    ["read", "READ"]
  ])("applies a %s event as %s through the service role", async (raw, normalized) => {
    apply("APPLIED");
    const response = await handleWhatsAppWebhook(await webhookRequest(statusPayload([{ id: "wamid.A", status: raw, timestamp: "1790960000", recipient_id: "5493496123456" }])), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 1, applied: 1 });
    const call = rpcCalls("wa_apply_status_event")[0];
    expect(call?.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);
    expect(call?.body).toMatchObject({
      p_provider_message_id: "wamid.A", p_status: normalized, p_event_at: new Date(1790960000 * 1000).toISOString(),
      p_dedupe_key: `wamid.A|${raw}|${new Date(1790960000 * 1000).toISOString()}`, p_error_code: null
    });
  });

  it("applies a failed event with the provider's diagnosis", async () => {
    apply("APPLIED");
    const payload = statusPayload([{ id: "wamid.F", status: "failed", timestamp: "1790960100", errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "Message Undeliverable." } }] }]);
    const response = await handleWhatsAppWebhook(await webhookRequest(payload), deps());
    expect(response.status).toBe(200);
    expect(rpcCalls("wa_apply_status_event")[0]?.body).toMatchObject({ p_status: "FAILED", p_error_code: "131026", p_error_message: "Message Undeliverable." });
  });

  it("is idempotent: a redelivered event reuses the same dedupe key and the database answers DUPLICATE", async () => {
    const results = ["APPLIED", "DUPLICATE"];
    route(`POST ${rpcPath("wa_apply_status_event")}`, () => ({ status: 200, body: { result: results.shift() } }));
    const payload = statusPayload([{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }]);
    const first = await handleWhatsAppWebhook(await webhookRequest(payload), deps());
    const second = await handleWhatsAppWebhook(await webhookRequest(payload), deps());
    expect(await first.json()).toMatchObject({ applied: 1 });
    expect(await second.json()).toMatchObject({ ok: true, applied: 0 });
    const keys = rpcCalls("wa_apply_status_event").map((c) => (c.body as { p_dedupe_key: string }).p_dedupe_key);
    expect(keys[0]).toBe(keys[1]);
  });

  it("an out-of-order (older) event is forwarded and the database refuses to move the state back", async () => {
    apply("IGNORED_OUT_OF_ORDER");
    const response = await handleWhatsAppWebhook(await webhookRequest(statusPayload([{ id: "wamid.A", status: "sent", timestamp: "1790959000" }])), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: 1, applied: 0 });
  });

  it("forwards several statuses in one delivery and ignores inbound customer messages", async () => {
    apply("APPLIED");
    const payload = {
      entry: [{ changes: [{ field: "messages", value: {
        messages: [{ from: "5493496123456", id: "wamid.IN", type: "text", text: { body: "hola" } }],
        statuses: [{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }, { id: "wamid.B", status: "read", timestamp: "1790960001" }]
      } }] }]
    };
    const response = await handleWhatsAppWebhook(await webhookRequest(payload), deps());
    expect(await response.json()).toEqual({ ok: true, received: 2, applied: 2 });
    expect(JSON.stringify(rpcCalls("wa_apply_status_event").map((c) => c.body))).not.toContain("hola");
  });

  it("passes unknown statuses through so they are audited, never applied", async () => {
    apply("IGNORED_STATUS");
    await handleWhatsAppWebhook(await webhookRequest(statusPayload([{ id: "wamid.A", status: "deleted", timestamp: "1790960000" }])), deps());
    expect(rpcCalls("wa_apply_status_event")[0]?.body).toMatchObject({ p_status: "DELETED" });
  });

  it("rejects a missing or wrong signature without touching the database", async () => {
    const payload = statusPayload([{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }]);
    expect((await handleWhatsAppWebhook(await webhookRequest(payload, { signature: null }), deps())).status).toBe(401);
    expect((await handleWhatsAppWebhook(await webhookRequest(payload, { secret: "another-secret" }), deps())).status).toBe(401);
    expect((await handleWhatsAppWebhook(await webhookRequest(payload, { signature: "sha256=zz" }), deps())).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects a body modified after signing", async () => {
    const original = JSON.stringify(statusPayload([{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }]));
    const signature = await computeMetaSignature(FAKE_APP_SECRET, new TextEncoder().encode(original));
    const tampered = original.replace("delivered", "read");
    const response = await handleWhatsAppWebhook(await webhookRequest(tampered, { signature }), deps());
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("fails closed (500, so Meta retries) when the app secret is not configured", async () => {
    const response = await handleWhatsAppWebhook(await webhookRequest(statusPayload([]), { signature: "sha256=" + "0".repeat(64) }), deps({ WHATSAPP_APP_SECRET: undefined }));
    expect(response.status).toBe(500);
  });

  it("answers 500 when applying fails so Meta redelivers (safe: everything is idempotent)", async () => {
    route(`POST ${rpcPath("wa_apply_status_event")}`, { status: 500, body: { code: "XX000", message: "boom" } });
    const response = await handleWhatsAppWebhook(await webhookRequest(statusPayload([{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }])), deps());
    expect(response.status).toBe(500);
  });
});

describe("meta signature helpers", () => {
  it("verifies the exact raw bytes with the app secret", async () => {
    const raw = new TextEncoder().encode('{"a":"ñ"}');
    const signature = await computeMetaSignature("secret", raw);
    expect(await verifyMetaSignature({ appSecret: "secret", signatureHeader: signature, rawBody: raw })).toBe(true);
    expect(await verifyMetaSignature({ appSecret: "secret", signatureHeader: signature, rawBody: new TextEncoder().encode('{"a":"n"}') })).toBe(false);
    expect(await verifyMetaSignature({ appSecret: "", signatureHeader: signature, rawBody: raw })).toBe(false);
    expect(await verifyMetaSignature({ appSecret: "secret", signatureHeader: null, rawBody: raw })).toBe(false);
  });

  it("parseStatusEvents tolerates garbage", () => {
    expect(parseStatusEvents(null)).toEqual([]);
    expect(parseStatusEvents({ entry: "x" })).toEqual([]);
    expect(parseStatusEvents({ entry: [{ changes: [{ value: { statuses: [{ status: "sent" }] } }] }] })).toEqual([]);
  });
});
