import { beforeEach, describe, expect, it } from "vitest";

import {
  handleCreateClaim,
  handleWhatsAppWebhook,
  type WhatsAppHandlerDeps
} from "../../../supabase/functions/_shared/whatsapp-handlers.ts";
import {
  buildClaimLink,
  buildClaimMessage,
  CLAIM_REPLY_TEXT,
  claimReplyText,
  normalizeBusinessPhone,
  parseClaimMessage
} from "../../../supabase/functions/_shared/whatsapp-claim.ts";
import { computeMetaSignature, createMockProvider, parseInboundMessages } from "../../../supabase/functions/_shared/whatsapp.ts";
import { buildTicketModel, renderWhatsAppMessage, type TicketSource } from "../../../supabase/functions/_shared/whatsapp-ticket.ts";

// Todos los valores sensibles de este archivo son falsos: nunca se usa una credencial real ni red.
const FAKE_TOKEN = "EAAG-fake-access-token-for-tests";
const FAKE_APP_SECRET = "fake-app-secret-for-tests";
const FAKE_SERVICE_KEY = "fake-service-role-key";
const SUPABASE_URL = "https://project.supabase.test";
const BUSINESS_PHONE = "+54 9 3496 000000";

const DEVICE = "f4000000-0000-4000-8000-000000000001";
const SALE = "f7000000-0000-4000-8000-000000000001";
const OPERATOR = "f1000000-0000-4000-8000-000000000003";
const DELIVERY = "d1000000-0000-4000-8000-000000000001";
const OP_TOKEN = "f".repeat(64);
const CLAIM_TOKEN = "3F9A0C7E5B1D4A28963E7C0B5D1F8A42";
const CUSTOMER = "5493496123456";

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
  WHATSAPP_APP_SECRET: FAKE_APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "fake-verify-token",
  WHATSAPP_BUSINESS_PHONE_E164: BUSINESS_PHONE
};

function route(key: string, handler: ((call: Call) => Reply) | Reply) {
  routes.set(key, typeof handler === "function" ? handler : () => handler);
}

function deps(overrides: Partial<Record<string, string | undefined>> = {}, whatsapp?: WhatsAppHandlerDeps["whatsapp"]): WhatsAppHandlerDeps {
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
const GRAPH = "POST GRAPH/v99.0/100000000000001/messages";

const sale = (over: Record<string, unknown> = {}) => ({
  saleId: SALE, status: "COMPLETED", completedAt: "2026-10-02T17:35:00Z", totalCents: 1_650_000,
  organizationName: "Carnicerías Fran", branchName: "Avenida", timezone: "America/Argentina/Buenos_Aires",
  items: [
    { name: "Vacío", weightGrams: 1250, quantityUnits: null, unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_250_000, promotionMode: null, manualPriceApplied: false },
    { name: "Hamburguesa", weightGrams: null, quantityUnits: 4, unitPriceCents: 100_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 400_000, promotionMode: null, manualPriceApplied: false }
  ],
  payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 1_650_000 }],
  ...over
});

beforeEach(() => {
  calls = [];
  routes = new Map();
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------
describe("claim link / message", () => {
  it("the QR link carries the BUSINESS number (not the phone_number_id) and the expected text", () => {
    const business = normalizeBusinessPhone(BUSINESS_PHONE) ?? "";
    const link = buildClaimLink(business, CLAIM_TOKEN);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://wa.me/5493496000000");
    expect(url.searchParams.get("text")).toBe(`TICKET ${CLAIM_TOKEN}`);
    expect(link).not.toContain("100000000000001");
    expect(link).not.toContain("+");
  });

  it("builds the exact message and parses it back", () => {
    expect(buildClaimMessage(CLAIM_TOKEN)).toBe(`TICKET ${CLAIM_TOKEN}`);
    expect(parseClaimMessage(`TICKET ${CLAIM_TOKEN}`)).toEqual({ kind: "claim", token: CLAIM_TOKEN });
    expect(parseClaimMessage(`  ticket   ${CLAIM_TOKEN}\n`)).toEqual({ kind: "claim", token: CLAIM_TOKEN });
  });

  it("ignores ordinary messages and flags a malformed TICKET message", () => {
    expect(parseClaimMessage("hola, ¿tienen asado?")).toEqual({ kind: "ignore" });
    expect(parseClaimMessage("mi ticket")).toEqual({ kind: "ignore" });
    expect(parseClaimMessage("TICKETS 123")).toEqual({ kind: "ignore" });
    expect(parseClaimMessage(undefined)).toEqual({ kind: "ignore" });
    expect(parseClaimMessage("TICKET")).toEqual({ kind: "malformed" });
    expect(parseClaimMessage("TICKET abc def")).toEqual({ kind: "malformed" });
  });

  it("validates the business phone as E.164", () => {
    expect(normalizeBusinessPhone("+54 9 3496-000000")).toBe("+5493496000000");
    expect(normalizeBusinessPhone("3496000000")).toBeNull();
    expect(normalizeBusinessPhone(undefined)).toBeNull();
  });

  it("rejection replies are short and carry no sale data", () => {
    for (const text of Object.values(CLAIM_REPLY_TEXT)) {
      expect(text.length).toBeLessThan(140);
      expect(text).not.toMatch(/\$|total|kg|Ticket #/i);
    }
    expect(claimReplyText("EXPIRED")).toMatch(/venció/);
    expect(claimReplyText("???")).toBe(CLAIM_REPLY_TEXT.INVALID);
  });

  it("parses inbound text messages and skips other types", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [
      { from: CUSTOMER, id: "wamid.A", timestamp: "1790960000", type: "text", text: { body: "TICKET X" } },
      { from: CUSTOMER, id: "wamid.B", timestamp: "1790960001", type: "image", image: { id: "1" } }
    ] } }] }] };
    expect(parseInboundMessages(payload)).toEqual([{ messageId: "wamid.A", from: CUSTOMER, receivedAt: new Date(1790960000 * 1000).toISOString(), text: "TICKET X" }]);
  });
});

describe("renderWhatsAppMessage (free-form ticket)", () => {
  const source = (over: Partial<TicketSource> = {}): TicketSource => ({
    saleId: SALE, status: "COMPLETED", completedAt: "2026-10-02T17:35:00Z", totalCents: 1_650_000, ticketDiscountBps: 0, ticketDiscountCents: 0,
    organizationName: "Carnicerías Fran", branchName: "Avenida", timezone: "America/Argentina/Buenos_Aires",
    items: [
      { name: "Vacío", weightGrams: 1250, quantityUnits: null, unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_250_000, promotionMode: null, manualPriceApplied: false },
      { name: "Hamburguesa", weightGrams: null, quantityUnits: 4, unitPriceCents: 100_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 400_000, promotionMode: null, manualPriceApplied: false }
    ],
    payments: [{ method: "CASH", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 1_650_000 }],
    ...over
  });

  it("is a single readable message with the agreed layout", () => {
    expect(renderWhatsAppMessage(buildTicketModel(source()))).toBe([
      "🧾 *Carnicerías Fran*",
      "Sucursal Avenida",
      "",
      "Ticket #f7000000",
      "02/10/2026 14:35",
      "",
      "• Vacío 1,250 kg x $10.000/kg = $12.500",
      "• Hamburguesa 4 u. x $1.000 c/u = $4.000",
      "",
      "*TOTAL: $16.500*",
      "Medio de pago: Efectivo"
    ].join("\n"));
  });

  it("shows promotions and surcharges, and never cost, supplier, margin or stock wording", () => {
    const text = renderWhatsAppMessage(buildTicketModel(source({
      totalCents: 610_000,
      items: [{ name: "Hamburguesa", weightGrams: null, quantityUnits: 6, unitPriceCents: 100_000, promotionDiscountCents: 50_000, cardSurchargeCents: 60_000, subtotalCents: 610_000, promotionMode: "PACK_FIXED_TOTAL", manualPriceApplied: false }],
      payments: [{ method: "CREDIT", provider: null, verificationStatus: "NOT_REQUIRED", amountCents: 610_000 }]
    })));
    expect(text).toContain("promo -$500, recargo tarjeta +$600");
    expect(text).toContain("Promociones: -$500");
    expect(text).toContain("*TOTAL: $6.100*");
    expect(text).not.toMatch(/costo|proveedor|margen|stock|empleado/i);
  });

  it("strips WhatsApp formatting characters from free text so names cannot break the layout", () => {
    const text = renderWhatsAppMessage(buildTicketModel(source({ items: [{ name: "*Asado* _especial_ ~x~ `y`", weightGrams: 1000, quantityUnits: null, unitPriceCents: 1_650_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_650_000, promotionMode: null, manualPriceApplied: false }] })));
    expect(text).toContain("• Asado especial x y 1,000 kg");
  });

  it("stays within one message for a huge sale and keeps the real total", () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      name: `Producto de carnicería número ${String(index + 1)}`, weightGrams: 1000, quantityUnits: null,
      unitPriceCents: 1_000_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 1_000_000, promotionMode: null, manualPriceApplied: false
    }));
    const text = renderWhatsAppMessage(buildTicketModel(source({ items, totalCents: 300_000_000 })));
    expect(text.length).toBeLessThanOrEqual(3800);
    expect(text).toMatch(/… y \d+ productos más/);
    expect(text).toContain("*TOTAL: $3.000.000*");
  });
});

// ---------------------------------------------------------------------------------------------
// POS: whatsapp-create-claim
// ---------------------------------------------------------------------------------------------
function claimRequest(body: unknown, init: { jwt?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.jwt !== null) headers.Authorization = `Bearer ${init.jwt ?? "user-jwt"}`;
  return new Request("https://fn.test/whatsapp-create-claim", {
    method: init.method ?? "POST", headers,
    ...((init.method ?? "POST") === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
}
const claimBody = { deviceId: DEVICE, saleId: SALE, operatorProfileId: OPERATOR, operatorToken: OP_TOKEN };
const created = { ok: true, token: CLAIM_TOKEN, expiresAt: "2026-10-03T17:36:00Z", previouslyDelivered: false };

describe("whatsapp-create-claim", () => {
  it("returns only what the POS needs to draw the QR, never the secrets or the sale id", async () => {
    route(`POST ${rpcPath("wa_create_claim")}`, { status: 200, body: created });
    const response = await handleCreateClaim(claimRequest(claimBody), deps());
    const text = await response.clone().text();
    const json = JSON.parse(text) as { ok: boolean; claim: { link: string; expiresAt: string; previouslyDelivered: boolean } };
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, claim: { link: `https://wa.me/5493496000000?text=TICKET%20${CLAIM_TOKEN}`, expiresAt: "2026-10-03T17:36:00Z", previouslyDelivered: false } });
    for (const secret of [FAKE_TOKEN, FAKE_APP_SECRET, FAKE_SERVICE_KEY, "100000000000001", SALE, SALE.slice(0, 8)]) expect(text).not.toContain(secret);
    expect(rpcCalls("wa_create_claim")[0]?.headers.authorization).toBe("Bearer user-jwt");
    expect(rpcCalls("wa_create_claim")[0]?.body).toMatchObject({ p_device_id: DEVICE, p_sale_id: SALE, p_operator_profile_id: OPERATOR });
    expect(graphCalls()).toHaveLength(0);
  });

  it("the token inside the link does not contain the sale id", async () => {
    route(`POST ${rpcPath("wa_create_claim")}`, { status: 200, body: created });
    const json = await (await handleCreateClaim(claimRequest(claimBody), deps())).json() as { claim: { link: string } };
    expect(decodeURIComponent(json.claim.link)).not.toContain(SALE.replace(/-/g, "").slice(0, 8));
    expect(json.claim.link.toLowerCase()).not.toContain(SALE.slice(0, 8));
  });

  it.each([
    ["PENDING_PAYMENT", { ok: false, code: "SALE_NOT_COMPLETED", saleStatus: "PENDING_PAYMENT" }, 409, "SALE_NOT_COMPLETED"],
    ["CANCELLED", { ok: false, code: "SALE_NOT_COMPLETED", saleStatus: "CANCELLED" }, 409, "SALE_NOT_COMPLETED"],
    ["unconfirmed payment", { ok: false, code: "PAYMENT_NOT_CONFIRMED" }, 409, "PAYMENT_NOT_CONFIRMED"],
    ["unsynced sale", { ok: false, code: "SALE_NOT_FOUND" }, 404, "SALE_NOT_FOUND"],
    ["too many claims", { ok: false, code: "TOO_MANY_CLAIMS" }, 429, "TOO_MANY_CLAIMS"]
  ])("blocks %s and returns no link", async (_name, rpcBody, status, code) => {
    route(`POST ${rpcPath("wa_create_claim")}`, { status: 200, body: rpcBody });
    const response = await handleCreateClaim(claimRequest(claimBody), deps());
    const text = await response.text();
    expect(response.status).toBe(status);
    expect(JSON.parse(text)).toMatchObject({ ok: false, code });
    expect(text).not.toContain("wa.me");
  });

  it("maps another branch/organization (42501) to FORBIDDEN", async () => {
    route(`POST ${rpcPath("wa_create_claim")}`, { status: 403, body: { code: "42501", message: "Sale is not available for this device" } });
    const response = await handleCreateClaim(claimRequest(claimBody), deps());
    expect(response.status).toBe(403);
  });

  it("answers 503 without creating a claim when the business phone is missing or invalid", async () => {
    for (const value of [undefined, "3496000000"]) {
      const response = await handleCreateClaim(claimRequest(claimBody), deps({ WHATSAPP_BUSINESS_PHONE_E164: value }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a session and complete device/operator data", async () => {
    expect((await handleCreateClaim(claimRequest(claimBody, { jwt: null }), deps())).status).toBe(401);
    expect((await handleCreateClaim(claimRequest({ ...claimBody, operatorToken: "short" }), deps())).status).toBe(400);
    expect((await handleCreateClaim(claimRequest({ ...claimBody, saleId: "nope" }), deps())).status).toBe(400);
    expect((await handleCreateClaim(claimRequest(claimBody, { method: "GET" }), deps())).status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Webhook: inbound `TICKET <token>`
// ---------------------------------------------------------------------------------------------
function inboundPayload(messages: unknown[], statuses: unknown[] = []) {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN1" }, ...(messages.length ? { messages } : {}), ...(statuses.length ? { statuses } : {}) } }] }] };
}
const textMessage = (text: string, id = "wamid.IN1", from = CUSTOMER) => ({ from, id, timestamp: "1790960000", type: "text", text: { body: text } });

async function webhook(payload: unknown, d: WhatsAppHandlerDeps, signature?: string | null): Promise<Response> {
  const raw = JSON.stringify(payload);
  const sig = signature === undefined ? await computeMetaSignature(FAKE_APP_SECRET, new TextEncoder().encode(raw)) : signature;
  return handleWhatsAppWebhook(new Request("https://fn.test/whatsapp-webhook", {
    method: "POST", headers: { "Content-Type": "application/json", ...(sig ? { "X-Hub-Signature-256": sig } : {}) }, body: raw
  }), d);
}

const sendOk = (id = "wamid.OUT1") => ({ status: 200, body: { messages: [{ id }] } });
const redeemSend = (saleJson: Record<string, unknown> = sale()) => ({ status: 200, body: { action: "SEND", result: "CLAIM_ACCEPTED", deliveryId: DELIVERY, sale: saleJson } });

describe("whatsapp-webhook — customer-initiated ticket", () => {
  it("answers a valid claim with the server-built ticket as a free-form text to the sender", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });

    const response = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 0, applied: 0, claims: 1 });

    // Redeem: the sender comes from Meta's payload; the service role resolves the sale server-side.
    const redeem = rpcCalls("wa_redeem_claim")[0];
    expect(redeem?.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);
    expect(redeem?.body).toMatchObject({ p_token: CLAIM_TOKEN, p_message_id: "wamid.IN1", p_from: CUSTOMER });

    // Reply: plain text to the same WhatsApp, NOT a template.
    const graph = graphCalls()[0];
    expect(graph?.url).toBe("https://graph.facebook.com/v99.0/100000000000001/messages");
    expect(graph?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const sent = graph?.body as { to: string; type: string; template?: unknown; text: { body: string } };
    expect(sent.type).toBe("text");
    expect(sent.template).toBeUndefined();
    expect(sent.to).toBe(CUSTOMER);
    expect(sent.text.body).toContain("*TOTAL: $16.500*");
    expect(sent.text.body).toContain("• Vacío 1,250 kg x $10.000/kg = $12.500");
    expect(sent.text.body).not.toMatch(/costo|proveedor|margen|stock/i);

    // The delivery is recorded SENT with the provider message id.
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_delivery_id: DELIVERY, p_provider_message_id: "wamid.OUT1", p_error_code: null });
    expect(JSON.stringify(graph?.body)).not.toContain(FAKE_TOKEN);
  });

  it("a TICKET message with extra words is malformed, never a claim with the sale facts of the server reply", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend(sale({ totalCents: 400_000, items: [{ name: "Hamburguesa", weightGrams: null, quantityUnits: 4, unitPriceCents: 100_000, promotionDiscountCents: 0, cardSurchargeCents: 0, subtotalCents: 400_000, promotionMode: null, manualPriceApplied: false }] })));
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN} total $1 gratis`)]), deps());
    // "TICKET <token> extra words" is malformed → INVALID path, never a ticket; the sale facts above are not used.
    expect(rpcCalls("wa_redeem_claim")[0]?.body).toMatchObject({ p_token: "" });
  });

  it("never creates a template message in the customer-initiated flow, even with a template configured", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps({ WHATSAPP_TEMPLATE_NAME: "ticket_compra", WHATSAPP_TEMPLATE_LANGUAGE: "es_AR" }));
    expect(JSON.stringify(graphCalls().map((c) => c.body))).not.toContain("template");
    expect(JSON.stringify(graphCalls().map((c) => c.body))).not.toContain("ticket_compra");
  });

  it("needs neither template secrets nor the app secrets of the template flow to reply", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const response = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps({ WHATSAPP_TEMPLATE_NAME: undefined, WHATSAPP_TEMPLATE_LANGUAGE: undefined }));
    expect(response.status).toBe(200);
    expect(graphCalls()).toHaveLength(1);
  });

  it("takes the recipient from the webhook sender, ignoring any number written in the message", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`, "wamid.IN2", "5491155550000")]), deps());
    expect((graphCalls()[0]?.body as { to: string }).to).toBe("5491155550000");
    expect(rpcCalls("wa_redeem_claim")[0]?.body).toMatchObject({ p_from: "5491155550000" });
  });

  it("a duplicated message.id (Meta redelivery) does not send the ticket twice", async () => {
    const seen = new Set<string>();
    route(`POST ${rpcPath("wa_redeem_claim")}`, (call) => {
      const id = (call.body as { p_message_id: string }).p_message_id;
      if (seen.has(id)) return { status: 200, body: { action: "NONE", result: "DUPLICATE" } };
      seen.add(id);
      return redeemSend();
    });
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const payload = inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`, "wamid.SAME")]);
    expect((await webhook(payload, deps())).status).toBe(200);
    expect((await webhook(payload, deps())).status).toBe(200);
    expect(rpcCalls("wa_redeem_claim")).toHaveLength(2);
    expect(graphCalls()).toHaveLength(1);
    expect(rpcCalls("wa_record_send_result")).toHaveLength(1);
  });

  it("an expired claim gets a short reply without any sale data", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, { status: 200, body: { action: "REPLY", kind: "EXPIRED", result: "EXPIRED" } });
    route(GRAPH, sendOk());
    const response = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps());
    expect(response.status).toBe(200);
    const body = (graphCalls()[0]?.body as { type: string; text: { body: string } });
    expect(body.type).toBe("text");
    expect(body.text.body).toBe(CLAIM_REPLY_TEXT.EXPIRED);
    expect(body.text.body).not.toMatch(/\$|Ticket #|Carnicerías/);
    expect(rpcCalls("wa_record_send_result")).toHaveLength(0);
  });

  it.each([
    ["INVALID token", { action: "REPLY", kind: "INVALID", result: "INVALID_TOKEN" }, CLAIM_REPLY_TEXT.INVALID],
    ["claim used by another phone", { action: "REPLY", kind: "USED", result: "USED_BY_OTHER" }, CLAIM_REPLY_TEXT.USED],
    ["resend limit", { action: "REPLY", kind: "ALREADY_SENT", result: "RESEND_LIMIT" }, CLAIM_REPLY_TEXT.ALREADY_SENT],
    ["sale no longer completed", { action: "REPLY", kind: "NOT_AVAILABLE", result: "SALE_NOT_AVAILABLE" }, CLAIM_REPLY_TEXT.NOT_AVAILABLE]
  ])("replies briefly for %s", async (_name, outcome, expected) => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, { status: 200, body: outcome });
    route(GRAPH, sendOk());
    await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps());
    expect((graphCalls()[0]?.body as { text: { body: string } }).text.body).toBe(expected);
  });

  it("a malformed TICKET message is rejected by the database as an invalid code", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, { status: 200, body: { action: "REPLY", kind: "INVALID", result: "INVALID_TOKEN" } });
    route(GRAPH, sendOk());
    await webhook(inboundPayload([textMessage("TICKET")]), deps());
    expect(rpcCalls("wa_redeem_claim")[0]?.body).toMatchObject({ p_token: "" });
    expect((graphCalls()[0]?.body as { text: { body: string } }).text.body).toBe(CLAIM_REPLY_TEXT.INVALID);
  });

  it("ignores ordinary customer messages: no database call, no reply (not a chatbot)", async () => {
    const response = await webhook(inboundPayload([textMessage("hola, ¿están abiertos?")]), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 0, applied: 0 });
    expect(calls).toHaveLength(0);
  });

  it("never sends a ticket for a sale that is not COMPLETED, even if the database let it through", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend(sale({ status: "PENDING_PAYMENT" })));
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps());
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_provider_message_id: null, p_error_code: "SALE_NOT_COMPLETED" });
    expect((graphCalls()[0]?.body as { text: { body: string } }).text.body).toBe(CLAIM_REPLY_TEXT.NOT_AVAILABLE);
  });

  it("records FAILED (with Meta's code) when the reply is rejected, and still answers 200", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, { status: 400, body: { error: { code: 131047, message: "Re-engagement message" } } });
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "FAILED" } });
    const response = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps());
    expect(response.status).toBe(200);
    expect(rpcCalls("wa_record_send_result")[0]?.body).toMatchObject({ p_provider_message_id: null, p_error_code: "131047" });
  });

  it("answers 500 (Meta redelivers) when the database fails, and when WhatsApp is not configured it consumes nothing", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, { status: 500, body: { code: "XX000", message: "boom" } });
    expect((await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps())).status).toBe(500);

    calls = [];
    const notConfigured = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps({ WHATSAPP_ACCESS_TOKEN: undefined }));
    expect(notConfigured.status).toBe(500);
    expect(rpcCalls("wa_redeem_claim")).toHaveLength(0);
  });

  it("requires the Meta signature for inbound messages too", async () => {
    const payload = inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]);
    expect((await webhook(payload, deps(), null)).status).toBe(401);
    expect((await webhook(payload, deps(), "sha256=" + "0".repeat(64))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("works end to end with an injected provider (no Meta, no credentials)", async () => {
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const mock = createMockProvider();
    const response = await webhook(inboundPayload([textMessage(`TICKET ${CLAIM_TOKEN}`)]), deps({ WHATSAPP_ACCESS_TOKEN: undefined }, { provider: mock, templateName: "x", languageCode: "es_AR" }));
    expect(response.status).toBe(200);
    expect(mock.sentTexts).toHaveLength(1);
    expect(mock.sentTexts[0]).toMatchObject({ to: CUSTOMER });
    expect(mock.sent).toHaveLength(0);
    expect(graphCalls()).toHaveLength(0);
  });

  it("still processes sent/delivered/read/failed statuses in the same delivery as a claim", async () => {
    route(`POST ${rpcPath("wa_apply_status_event")}`, { status: 200, body: { result: "APPLIED" } });
    route(`POST ${rpcPath("wa_redeem_claim")}`, redeemSend());
    route(GRAPH, sendOk());
    route(`POST ${rpcPath("wa_record_send_result")}`, { status: 200, body: { deliveryId: DELIVERY, status: "SENT" } });
    const payload = inboundPayload(
      [textMessage(`TICKET ${CLAIM_TOKEN}`)],
      [{ id: "wamid.A", status: "delivered", timestamp: "1790960000" }, { id: "wamid.B", status: "read", timestamp: "1790960001" },
       { id: "wamid.C", status: "failed", timestamp: "1790960002", errors: [{ code: 131026, title: "Message undeliverable" }] }]
    );
    const response = await webhook(payload, deps());
    expect(await response.json()).toEqual({ ok: true, received: 3, applied: 3, claims: 1 });
    expect(rpcCalls("wa_apply_status_event").map((c) => (c.body as { p_status: string }).p_status)).toEqual(["DELIVERED", "READ", "FAILED"]);
  });
});
