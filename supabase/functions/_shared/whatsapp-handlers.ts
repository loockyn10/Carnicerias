// Handlers de las Edge Functions de WhatsApp (D-059 envío iniciado por el negocio, D-060 ticket iniciado
// por el cliente con QR). Igual que los de Mercado Pago, reciben sus
// dependencias (env, fetch, reloj, proveedor) por parámetro: los tests
// (`packages/business-logic/src/whatsapp-handlers.test.ts`) nunca usan credenciales reales ni red.
//
// Reglas que este archivo hace cumplir:
//   * El POS sólo manda ids, el token de operador y el teléfono. El total, las líneas, los precios y el
//     texto del ticket se reconstruyen en el servidor a partir de la venta REAL (RPC `wa_prepare_ticket`).
//   * Sólo una venta COMPLETED (con todo pago verificado en CONFIRMED) emite comprobante.
//   * El access token / app secret salen únicamente de `deps.env` (secrets de Edge Functions): nunca se
//     loguean, se devuelven ni llegan al POS. Tampoco se loguea el teléfono.
//   * El webhook valida la firma `X-Hub-Signature-256`, es idempotente y no retrocede estados.
import {
  asObject,
  bearer,
  CORS_HEADERS,
  failure,
  jsonResponse,
  readJson,
  rpc,
  type HandlerDeps,
  type RpcResult
} from "./handlers.ts";
import { isUuid } from "./mercadopago.ts";
import {
  buildTemplateParameters,
  buildTicketModel,
  evaluateTicketEligibility,
  maskPhone,
  normalizePhone,
  parseTicketSource,
  renderWhatsAppMessage
} from "./whatsapp-ticket.ts";
import { buildClaimLink, claimReplyText, normalizeBusinessPhone, parseClaimMessage } from "./whatsapp-claim.ts";
import {
  constantTimeEqual,
  parseInboundMessages,
  parseStatusEvents,
  resolveWhatsAppConfig,
  resolveWhatsAppProvider,
  verifyMetaSignature,
  type InboundTextMessage,
  type WhatsAppConfig,
  type WhatsAppProvider
} from "./whatsapp.ts";

export interface WhatsAppHandlerDeps extends HandlerDeps {
  /** Sólo para tests/desarrollo: reemplaza la configuración leída de los secrets (proveedor inyectable). */
  whatsapp?: WhatsAppConfig;
}

function prepareFailure(result: RpcResult): Response {
  if (result.errorCode === "28000" || result.status === 401) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  if (result.errorCode === "42501" || result.status === 403) return failure(403, "FORBIDDEN", "No autorizado para este dispositivo, operador o venta.");
  if (result.errorCode === "22023" || result.errorCode === "23514") return failure(422, "INVALID_REQUEST", "Los datos del envío no son válidos.");
  if (result.errorCode === "NETWORK") return failure(503, "BACKEND_UNAVAILABLE", "Servicio no disponible, reintentá.");
  return failure(500, "INTERNAL", "No se pudo preparar el ticket.");
}

const SALE_STATUS_MESSAGES: Record<string, string> = {
  PENDING_PAYMENT: "La venta todavía no está cobrada. El ticket se puede enviar cuando el pago esté confirmado.",
  CANCELLED: "La venta está anulada: no se emite comprobante.",
  REFUNDED: "La venta está devuelta: no se emite comprobante.",
  DRAFT: "La venta no está completada."
};

// ---------------------------------------------------------------------------
// POST whatsapp-send-ticket
// ---------------------------------------------------------------------------

export async function handleSendTicket(req: Request, deps: WhatsAppHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const body = await readJson(req);
  if (!body) return failure(400, "BAD_REQUEST", "Cuerpo inválido.");

  const { deviceId, saleId, operatorProfileId, operatorToken, phone, resend } = body;
  if (!isUuid(deviceId) || !isUuid(saleId) || !isUuid(operatorProfileId)
      || typeof operatorToken !== "string" || operatorToken.length < 32) {
    return failure(400, "BAD_REQUEST", "Datos del envío incompletos.");
  }

  const normalized = normalizePhone(phone);
  if (!normalized.ok) return failure(422, "INVALID_PHONE", normalized.message, { phoneCode: normalized.code });

  let config: WhatsAppConfig;
  if (deps.whatsapp) {
    config = deps.whatsapp;
  } else {
    const resolved = resolveWhatsAppConfig(deps);
    if (!resolved.ok) {
      // Sólo los NOMBRES de los secrets que faltan (nunca valores).
      deps.log("whatsapp-send-ticket: WhatsApp is not configured", { missing: resolved.missing });
      return failure(503, "WHATSAPP_NOT_CONFIGURED", "El envío por WhatsApp no está configurado en el servidor.");
    }
    config = resolved.config;
  }

  // Valida dispositivo + operador, la venta real, su estado y duplicados; reserva el intento (PENDING).
  const prepared = await rpc(deps, "wa_prepare_ticket", {
    p_device_id: deviceId, p_sale_id: saleId, p_operator_profile_id: operatorProfileId,
    p_operator_token: operatorToken, p_phone: normalized.e164, p_resend: resend === true
  }, { jwt });
  if (!prepared.ok) return prepareFailure(prepared);
  const result = asObject(prepared.data);
  if (!result) return failure(500, "INTERNAL", "Respuesta inesperada del servidor.");

  if (result.ok !== true) {
    switch (result.code) {
      case "SALE_NOT_FOUND":
        return failure(404, "SALE_NOT_FOUND", "La venta todavía no llegó al servidor. Esperá unos segundos y reintentá.");
      case "SALE_NOT_COMPLETED":
        return failure(409, "SALE_NOT_COMPLETED", SALE_STATUS_MESSAGES[String(result.saleStatus)] ?? "La venta no está completada.", { saleStatus: result.saleStatus ?? null });
      case "PAYMENT_NOT_CONFIRMED":
        return failure(409, "PAYMENT_NOT_CONFIRMED", "El pago todavía no está confirmado.");
      case "ALREADY_SENT":
        return failure(409, "ALREADY_SENT", "Este ticket ya fue enviado.", {
          delivery: { status: result.status ?? null, sentAt: result.sentAt ?? null, phoneMasked: result.phoneMasked ?? null }
        });
      case "IN_PROGRESS":
        return failure(409, "IN_PROGRESS", "El envío ya está en curso.");
      default:
        return failure(500, "INTERNAL", "No se pudo preparar el ticket.");
    }
  }

  const deliveryId = result.deliveryId;
  if (!isUuid(deliveryId)) return failure(500, "INTERNAL", "Respuesta inesperada del servidor.");

  const recordResult = (args: { messageId: string | null; errorCode: string | null; errorMessage: string | null }) =>
    rpc(deps, "wa_record_send_result", {
      p_delivery_id: deliveryId, p_provider_message_id: args.messageId, p_error_code: args.errorCode,
      p_error_message: args.errorMessage, p_template_name: config.templateName
    }, { service: true });

  // Reconstrucción del ticket 100% server-side, con re-chequeo de elegibilidad (defensa en profundidad).
  const source = parseTicketSource(result.sale);
  const eligibility = source ? evaluateTicketEligibility(source) : ({ ok: false, code: "INVALID_TICKET_DATA" } as const);
  if (!source || !eligibility.ok) {
    const code = eligibility.ok ? "INVALID_TICKET_DATA" : eligibility.code;
    deps.log("whatsapp-send-ticket: ticket not eligible", { code });
    await recordResult({ messageId: null, errorCode: code, errorMessage: "El ticket no pudo generarse." });
    // Estado de venta/pago: lo reporta el cliente como conflicto. Datos inconsistentes del servidor: error interno.
    return code === "SALE_NOT_COMPLETED" || code === "PAYMENT_NOT_CONFIRMED"
      ? failure(409, code, "La venta no admite comprobante en este momento.")
      : failure(500, "INTERNAL", "No se pudo generar el ticket.");
  }
  const model = buildTicketModel(source);

  const sent = await config.provider.sendTemplate({
    to: normalized.waId,
    templateName: config.templateName,
    languageCode: config.languageCode,
    bodyParameters: buildTemplateParameters(model)
  });

  if (!sent.ok) {
    deps.log("whatsapp-send-ticket: provider rejected the message", { provider: config.provider.name, code: sent.code, retryable: sent.retryable });
    await recordResult({ messageId: null, errorCode: sent.code, errorMessage: sent.message });
    return failure(502, "WHATSAPP_SEND_FAILED", "No se pudo enviar el ticket.", { retryable: sent.retryable, providerCode: sent.code });
  }

  let recorded = await recordResult({ messageId: sent.messageId, errorCode: null, errorMessage: null });
  if (!recorded.ok) recorded = await recordResult({ messageId: sent.messageId, errorCode: null, errorMessage: null });
  if (!recorded.ok) {
    // El mensaje YA salió: el cliente lo recibió. Se avisa por log; la auditoría queda en PENDING.
    deps.log("whatsapp-send-ticket: sent but could not record the result", { deliveryId, code: recorded.errorCode });
  }
  return jsonResponse(200, {
    ok: true,
    delivery: { id: deliveryId, status: "SENT", phoneMasked: maskPhone(normalized.e164) },
    ...(config.provider.name === "mock" ? { simulated: true } : {})
  });
}

// ---------------------------------------------------------------------------
// POST whatsapp-create-claim — el POS pide el QR del ticket (flujo principal, iniciado por el cliente)
// ---------------------------------------------------------------------------
// Devuelve SÓLO lo necesario para dibujar el QR: el enlace `wa.me` (número comercial + `TICKET <token>`),
// el vencimiento y si el ticket ya se había entregado. El token en claro viaja una vez; Postgres guarda su hash.

export async function handleCreateClaim(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const body = await readJson(req);
  if (!body) return failure(400, "BAD_REQUEST", "Cuerpo inválido.");

  const { deviceId, saleId, operatorProfileId, operatorToken } = body;
  if (!isUuid(deviceId) || !isUuid(saleId) || !isUuid(operatorProfileId)
      || typeof operatorToken !== "string" || operatorToken.length < 32) {
    return failure(400, "BAD_REQUEST", "Datos del ticket incompletos.");
  }

  // El número COMERCIAL visible (no el phone_number_id de la Cloud API). Sin él no hay QR que ofrecer, y no
  // se crea ningún claim huérfano.
  const businessPhone = normalizeBusinessPhone(deps.env("WHATSAPP_BUSINESS_PHONE_E164"));
  if (!businessPhone) {
    deps.log("whatsapp-create-claim: WHATSAPP_BUSINESS_PHONE_E164 is missing or invalid");
    return failure(503, "WHATSAPP_NOT_CONFIGURED", "El ticket por WhatsApp no está configurado en el servidor.");
  }

  const created = await rpc(deps, "wa_create_claim", {
    p_device_id: deviceId, p_sale_id: saleId, p_operator_profile_id: operatorProfileId, p_operator_token: operatorToken
  }, { jwt });
  if (!created.ok) return prepareFailure(created);
  const result = asObject(created.data);
  if (!result) return failure(500, "INTERNAL", "Respuesta inesperada del servidor.");

  if (result.ok !== true) {
    switch (result.code) {
      case "SALE_NOT_FOUND":
        return failure(404, "SALE_NOT_FOUND", "La venta todavía no llegó al servidor. Esperá unos segundos y reintentá.");
      case "SALE_NOT_COMPLETED":
        return failure(409, "SALE_NOT_COMPLETED", SALE_STATUS_MESSAGES[String(result.saleStatus)] ?? "La venta no está completada.", { saleStatus: result.saleStatus ?? null });
      case "PAYMENT_NOT_CONFIRMED":
        return failure(409, "PAYMENT_NOT_CONFIRMED", "El pago todavía no está confirmado.");
      case "TOO_MANY_CLAIMS":
        return failure(429, "TOO_MANY_CLAIMS", "Ya se generaron demasiados códigos para esta venta.");
      default:
        return failure(500, "INTERNAL", "No se pudo preparar el ticket.");
    }
  }
  const token = result.token;
  if (typeof token !== "string" || !/^[0-9A-F]{32}$/.test(token) || typeof result.expiresAt !== "string") {
    return failure(500, "INTERNAL", "Respuesta inesperada del servidor.");
  }
  return jsonResponse(200, {
    ok: true,
    claim: { link: buildClaimLink(businessPhone, token), expiresAt: result.expiresAt, previouslyDelivered: result.previouslyDelivered === true }
  });
}

// ---------------------------------------------------------------------------
// whatsapp-webhook: GET = verificación de Meta, POST = eventos de estado firmados
// ---------------------------------------------------------------------------

export async function handleWhatsAppWebhook(req: Request, deps: WhatsAppHandlerDeps): Promise<Response> {
  if (req.method === "GET") {
    const verifyToken = deps.env("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    if (!verifyToken) {
      deps.log("whatsapp-webhook: WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured");
      return failure(500, "NOT_CONFIGURED", "Webhook no configurado.");
    }
    const params = new URL(req.url).searchParams;
    const challenge = params.get("hub.challenge");
    if (params.get("hub.mode") === "subscribe" && constantTimeEqual(params.get("hub.verify_token") ?? "", verifyToken) && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return failure(403, "FORBIDDEN", "Verificación rechazada.");
  }
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");

  const appSecret = deps.env("WHATSAPP_APP_SECRET");
  if (!appSecret) {
    deps.log("whatsapp-webhook: WHATSAPP_APP_SECRET is not configured");
    return failure(500, "NOT_CONFIGURED", "Webhook no configurado."); // Meta reintenta
  }
  const rawBody = new Uint8Array(await req.arrayBuffer());
  const authentic = await verifyMetaSignature({ appSecret, signatureHeader: req.headers.get("x-hub-signature-256"), rawBody });
  if (!authentic) {
    // Nada se registra de un request sin firma válida.
    deps.log("whatsapp-webhook: invalid signature");
    return failure(401, "INVALID_SIGNATURE", "Firma inválida.");
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return failure(400, "BAD_REQUEST", "Cuerpo inválido.");
  }

  const events = parseStatusEvents(payload);
  const inbound = parseInboundMessages(payload).filter((message) => parseClaimMessage(message.text).kind !== "ignore");
  let applied = 0;
  for (const event of events) {
    const outcome = await rpc(deps, "wa_apply_status_event", {
      p_provider_message_id: event.providerMessageId,
      p_status: event.status ?? event.rawStatus.toUpperCase(),
      p_event_at: event.occurredAt,
      p_error_code: event.errorCode,
      p_error_message: event.errorMessage,
      p_dedupe_key: event.dedupeKey
    }, { service: true });
    if (!outcome.ok) {
      deps.log("whatsapp-webhook: could not apply event", { code: outcome.errorCode });
      return failure(500, "INTERNAL", "No se pudo aplicar la notificación."); // Meta reintenta; todo es idempotente
    }
    if (asObject(outcome.data)?.result === "APPLIED") applied += 1;
  }

  // Mensajes del cliente `TICKET <token>` (ticket iniciado por el cliente). Todo lo demás se ignora.
  let provider: WhatsAppProvider | null = null;
  if (inbound.length > 0) {
    if (deps.whatsapp) {
      provider = deps.whatsapp.provider;
    } else {
      const resolved = resolveWhatsAppProvider(deps);
      if (resolved.ok) provider = resolved.provider;
      else deps.log("whatsapp-webhook: cannot reply, WhatsApp is not configured", { missing: resolved.missing });
    }
    // Sin proveedor no se canjea nada (el claim seguiría vigente) y Meta reintenta.
    if (!provider) return failure(500, "NOT_CONFIGURED", "No se puede responder: WhatsApp no está configurado.");
  }
  for (const message of inbound) {
    if (provider && !(await handleClaimMessage(message, deps, provider))) {
      return failure(500, "INTERNAL", "No se pudo aplicar el mensaje."); // Meta reintenta; el message.id deduplica
    }
  }
  return jsonResponse(200, { ok: true, received: events.length, applied, ...(inbound.length > 0 ? { claims: inbound.length } : {}) });
}

/**
 * Un mensaje `TICKET <token>`. Devuelve false sólo si Postgres falló (Meta debe reintentar: nada quedó
 * registrado o `message.id` ya lo deduplica). Un fallo al RESPONDER no reintenta: el delivery queda FAILED con
 * el código de Meta y el cliente puede volver a enviar el mismo mensaje (mismo teléfono = reenvío permitido).
 * La respuesta es un mensaje de servicio (texto libre): el cliente acaba de escribir, no hace falta plantilla.
 */
async function handleClaimMessage(message: InboundTextMessage, deps: HandlerDeps, provider: WhatsAppProvider): Promise<boolean> {
  const parsed = parseClaimMessage(message.text);
  const redeemed = await rpc(deps, "wa_redeem_claim", {
    // El teléfono sale del remitente del mensaje de Meta; el POS no interviene.
    p_token: parsed.kind === "claim" ? parsed.token : "",
    p_message_id: message.messageId,
    p_from: message.from,
    p_received_at: message.receivedAt
  }, { service: true });
  if (!redeemed.ok) {
    deps.log("whatsapp-webhook: could not redeem claim", { code: redeemed.errorCode });
    return false;
  }
  const outcome = asObject(redeemed.data);
  const action = outcome?.action;
  if (action === "NONE") return true; // duplicado o remitente inválido: nada que enviar

  if (action === "REPLY") {
    const sent = await provider.sendText({ to: message.from, body: claimReplyText(outcome?.kind) });
    if (!sent.ok) deps.log("whatsapp-webhook: could not send the short reply", { code: sent.code });
    return true;
  }

  const deliveryId = outcome?.deliveryId;
  if (!outcome || action !== "SEND" || !isUuid(deliveryId)) {
    deps.log("whatsapp-webhook: unexpected redeem result");
    return false;
  }
  const record = async (args: { messageId: string | null; errorCode: string | null; errorMessage: string | null }) => {
    let result = await rpc(deps, "wa_record_send_result", {
      p_delivery_id: deliveryId, p_provider_message_id: args.messageId, p_error_code: args.errorCode, p_error_message: args.errorMessage
    }, { service: true });
    if (!result.ok) result = await rpc(deps, "wa_record_send_result", {
      p_delivery_id: deliveryId, p_provider_message_id: args.messageId, p_error_code: args.errorCode, p_error_message: args.errorMessage
    }, { service: true });
    if (!result.ok) deps.log("whatsapp-webhook: sent but could not record the result", { deliveryId, code: result.errorCode });
  };

  // Ticket reconstruido en el servidor con el mismo builder y la misma elegibilidad que el envío por plantilla.
  const source = parseTicketSource(outcome.sale);
  const eligibility = source ? evaluateTicketEligibility(source) : ({ ok: false, code: "INVALID_TICKET_DATA" } as const);
  if (!source || !eligibility.ok) {
    const code = eligibility.ok ? "INVALID_TICKET_DATA" : eligibility.code;
    deps.log("whatsapp-webhook: ticket not eligible", { code });
    await record({ messageId: null, errorCode: code, errorMessage: "El ticket no pudo generarse." });
    const apology = await provider.sendText({ to: message.from, body: claimReplyText("NOT_AVAILABLE") });
    if (!apology.ok) deps.log("whatsapp-webhook: could not send the short reply", { code: apology.code });
    return true;
  }

  const sent = await provider.sendText({ to: message.from, body: renderWhatsAppMessage(buildTicketModel(source)) });
  if (!sent.ok) {
    deps.log("whatsapp-webhook: provider rejected the ticket", { provider: provider.name, code: sent.code, retryable: sent.retryable });
    await record({ messageId: null, errorCode: sent.code, errorMessage: sent.message });
    return true;
  }
  await record({ messageId: sent.messageId, errorCode: null, errorMessage: null });
  return true;
}
