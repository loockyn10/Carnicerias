// Handlers de las Edge Functions de Mercado Pago. Reciben sus dependencias (env, fetch, reloj) por
// parámetro para poder probarlos con mocks en Vitest sin red ni credenciales: los tests
// (`packages/business-logic/src/mercadopago-handlers.test.ts`) nunca usan un token real.
//
// Reglas que este archivo hace cumplir:
//   * El Access Token y el secreto del webhook salen únicamente de `deps.env` (secrets de la Edge
//     Function). Jamás se loguean, jamás se devuelven, jamás llegan al POS.
//   * Lo que el POS manda (monto, ids) NUNCA decide el estado de un cobro: el estado sólo cambia
//     con lo que Mercado Pago responde a una consulta autenticada (GET /v1/orders/{id}).
//   * El webhook es una notificación: se valida la firma y se re-consulta la orden.
import {
  buildCreateQrOrderBody,
  buildPosPayload,
  buildStorePayload,
  interpretOrder,
  isUuid,
  parseNotification,
  verifyWebhookSignature,
  type MercadoPagoOrder,
  type MercadoPagoQrMode,
  type PosInput,
  type StoreInput
} from "./mercadopago.ts";

export interface HandlerDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  /** Sólo para dedupe/diagnóstico; nunca recibe secretos ni cuerpos. */
  log: (message: string, extra?: Record<string, unknown>) => void;
}

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_TIMEOUT_MS = 10_000;
/** No se vuelve a consultar a MP por una orden revisada hace menos de esto (poll del POS). */
const REFRESH_MIN_INTERVAL_MS = 8_000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function failure(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return jsonResponse(status, { ok: false, code, message, ...extra });
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

async function readJson(req: Request): Promise<JsonObject | null> {
  try {
    return asObject(await req.json());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST RPC). Usuario = JWT del POS (RLS/permisos aplican); servicio = service_role.
// ---------------------------------------------------------------------------

interface RpcResult {
  ok: boolean;
  status: number;
  data: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

async function rpc(deps: HandlerDeps, fn: string, args: JsonObject, auth: { jwt: string } | { service: true }): Promise<RpcResult> {
  const url = deps.env("SUPABASE_URL");
  const anon = deps.env("SUPABASE_ANON_KEY");
  const serviceKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
  const isService = "service" in auth;
  const apikey = isService ? serviceKey : anon;
  if (!url || !apikey) return { ok: false, status: 500, data: null, errorCode: "ENV", errorMessage: "Supabase environment is not configured" };
  const token = isService ? serviceKey : auth.jwt;
  try {
    const response = await deps.fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey, Authorization: `Bearer ${token ?? ""}` },
      body: JSON.stringify(args)
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.ok) return { ok: true, status: response.status, data, errorCode: null, errorMessage: null };
    const error = asObject(data);
    return {
      ok: false,
      status: response.status,
      data: null,
      errorCode: typeof error?.code === "string" ? error.code : null,
      errorMessage: typeof error?.message === "string" ? error.message : null
    };
  } catch {
    return { ok: false, status: 503, data: null, errorCode: "NETWORK", errorMessage: "Supabase is unreachable" };
  }
}

function rpcFailure(result: RpcResult): Response {
  if (result.errorMessage === "MP_NOT_CONFIGURED") {
    return failure(409, "MP_NOT_CONFIGURED", "Mercado Pago no está habilitado para esta sucursal.");
  }
  if (result.errorCode === "28000" || result.status === 401) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  if (result.errorCode === "42501" || result.status === 403) return failure(403, "FORBIDDEN", "No autorizado para este dispositivo u operador.");
  if (result.errorCode === "22023" || result.errorCode === "23514") {
    return failure(422, "INVALID_REQUEST", "Los datos del cobro no son válidos para esta venta.");
  }
  if (result.errorCode === "NETWORK") return failure(503, "BACKEND_UNAVAILABLE", "Servicio no disponible, reintentá.");
  return failure(500, "INTERNAL", "No se pudo procesar el cobro.");
}

// ---------------------------------------------------------------------------
// Mercado Pago (autenticado desde el backend)
// ---------------------------------------------------------------------------

interface MpResponse {
  ok: boolean;
  status: number;
  body: JsonObject | null;
  /** Falla de red / timeout: resultado desconocido (la operación pudo haberse ejecutado). */
  networkError: boolean;
}

async function mpRequest(
  deps: HandlerDeps,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<MpResponse> {
  const token = deps.env("MERCADOPAGO_ACCESS_TOKEN");
  if (!token) return { ok: false, status: 0, body: null, networkError: true };
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, MP_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (options.idempotencyKey) headers["X-Idempotency-Key"] = options.idempotencyKey;
    const response = await deps.fetch(`${MP_BASE_URL}${path}`, {
      method,
      headers,
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const text = await response.text();
    let body: JsonObject | null = null;
    try {
      body = text ? asObject(JSON.parse(text)) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, networkError: false };
  } catch {
    return { ok: false, status: 0, body: null, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

function mpErrorCode(response: MpResponse): string {
  const errors = response.body?.errors;
  const first = Array.isArray(errors) ? asObject(errors[0]) : null;
  const code = typeof first?.code === "string" ? first.code : typeof response.body?.error === "string" ? response.body.error : "error";
  return `mp_${String(response.status)}_${code}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Estado público hacia el POS (sin ids internos de MP ni idempotency keys)
// ---------------------------------------------------------------------------

function publicOrder(order: unknown): JsonObject | null {
  const o = asObject(order);
  if (!o) return null;
  return {
    saleId: o.saleId ?? null,
    attempt: o.attempt ?? null,
    status: o.status ?? null,
    verificationStatus: o.verificationStatus ?? null,
    expectedAmountCents: o.expectedAmountCents ?? null,
    confirmedAmountCents: o.confirmedAmountCents ?? null,
    amountMismatch: o.amountMismatch ?? false,
    expiresAt: o.expiresAt ?? null,
    confirmedAt: o.confirmedAt ?? null
  };
}

async function applyMpOrder(deps: HandlerDeps, mpOrder: MercadoPagoOrder, source: "POLL" | "WEBHOOK" | "CANCEL"): Promise<{ result: RpcResult; found: boolean }> {
  const interpreted = interpretOrder(mpOrder);
  const result = await rpc(deps, "mp_apply_order_state", {
    p_mp_order_id: mpOrder.id ?? "",
    p_external_reference: mpOrder.external_reference ?? null,
    p_new_status: interpreted.status,
    p_mp_status: interpreted.mpStatus,
    p_mp_status_detail: interpreted.mpStatusDetail,
    p_mp_payment_id: interpreted.mpPaymentId,
    p_paid_amount_cents: interpreted.paidAmountCents,
    p_total_amount_cents: interpreted.totalAmountCents,
    p_source: source
  }, { service: true });
  const data = asObject(result.data);
  return { result, found: data?.found === true };
}

// ---------------------------------------------------------------------------
// POST mp-create-order
// ---------------------------------------------------------------------------

export async function handleCreateOrder(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const body = await readJson(req);
  if (!body) return failure(400, "BAD_REQUEST", "Cuerpo inválido.");

  const { deviceId, saleId, amountCents, operatorProfileId, operatorToken, retry } = body;
  if (!isUuid(deviceId) || !isUuid(saleId) || !isUuid(operatorProfileId)
      || typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 1_000_000_000
      || typeof operatorToken !== "string" || operatorToken.length < 32) {
    return failure(400, "BAD_REQUEST", "Datos del cobro incompletos.");
  }

  // Reserva idempotente (valida dispositivo, operador, sucursal habilitada y monto). Sin red a MP.
  const prepared = await rpc(deps, "mp_prepare_order", {
    p_device_id: deviceId, p_sale_id: saleId, p_amount_cents: amountCents,
    p_operator_profile_id: operatorProfileId, p_operator_token: operatorToken, p_retry: retry === true
  }, { jwt });
  if (!prepared.ok) return rpcFailure(prepared);
  const order = asObject(prepared.data);
  if (!order) return failure(500, "INTERNAL", "Respuesta inesperada del servidor.");

  // Ya existe (CREATED / CONFIRMED / terminal): idempotente, no se vuelve a llamar a Mercado Pago.
  if (order.status !== "REQUESTING") return jsonResponse(200, { ok: true, order: publicOrder(order) });

  if (!deps.env("MERCADOPAGO_ACCESS_TOKEN")) {
    deps.log("mp-create-order: MERCADOPAGO_ACCESS_TOKEN is not configured");
    return failure(503, "MP_SERVER_NOT_CONFIGURED", "Mercado Pago no está configurado en el servidor.", { order: publicOrder(order) });
  }

  let mpBody: ReturnType<typeof buildCreateQrOrderBody>;
  try {
    mpBody = buildCreateQrOrderBody({
      externalReference: String(order.externalReference),
      amountCents: Number(order.expectedAmountCents),
      externalPosId: String(order.externalPosId),
      mode: (typeof order.qrMode === "string" ? order.qrMode : "static") as MercadoPagoQrMode,
      expirationMinutes: Number(order.expirationMinutes)
    });
  } catch {
    return failure(422, "INVALID_REQUEST", "La configuración de Mercado Pago de la sucursal no es válida.");
  }

  const created = await mpRequest(deps, "POST", "/v1/orders", { body: mpBody, idempotencyKey: String(order.idempotencyKey) });
  if (created.networkError || created.status >= 500 || created.status === 429) {
    // Resultado desconocido: queda REQUESTING; reintentar reenvía la MISMA idempotency key.
    deps.log("mp-create-order: Mercado Pago unavailable", { status: created.status });
    return failure(502, "MP_UNAVAILABLE", "Mercado Pago no respondió. Reintentá.", { order: publicOrder(order) });
  }

  if (created.ok && typeof created.body?.id === "string") {
    const payments = asObject(created.body.transactions)?.payments;
    const firstPayment = Array.isArray(payments) ? asObject(payments[0]) : null;
    const recorded = await rpc(deps, "mp_record_order_result", {
      p_order_id: order.orderId,
      p_mp_order_id: created.body.id,
      p_mp_status: typeof created.body.status === "string" ? created.body.status : null,
      p_mp_status_detail: typeof created.body.status_detail === "string" ? created.body.status_detail : null,
      p_mp_payment_id: typeof firstPayment?.id === "string" ? firstPayment.id : null,
      p_error_code: null
    }, { service: true });
    if (!recorded.ok) {
      // La orden existe en MP pero no pudimos anotarla: el webhook/consulta la enlaza por external_reference.
      deps.log("mp-create-order: could not record created order", { code: recorded.errorCode });
      return failure(502, "RECORD_FAILED", "El cobro se generó pero no se pudo registrar. Reintentá en unos segundos.", { order: publicOrder(order) });
    }
    const typeResponse = asObject(created.body.type_response);
    return jsonResponse(200, {
      ok: true,
      order: publicOrder(recorded.data),
      // Sólo en modos dynamic/hybrid; no se persiste.
      qrData: typeof typeResponse?.qr_data === "string" ? typeResponse.qr_data : null
    });
  }

  // Rechazo definitivo de MP (400/401/404/409...): el intento queda en ERROR con un código seguro.
  const errorCode = created.status === 409 ? "mp_idempotency_conflict" : mpErrorCode(created);
  deps.log("mp-create-order: Mercado Pago rejected the order", { status: created.status, errorCode });
  const recorded = await rpc(deps, "mp_record_order_result", {
    p_order_id: order.orderId, p_mp_order_id: null, p_mp_status: null, p_mp_status_detail: null, p_mp_payment_id: null, p_error_code: errorCode
  }, { service: true });
  const message = created.status === 404
    ? "La caja de Mercado Pago configurada para esta sucursal no existe."
    : created.status === 401
      ? "Mercado Pago rechazó las credenciales del servidor."
      : "Mercado Pago rechazó el cobro.";
  return failure(422, "MP_REJECTED", message, { order: publicOrder(recorded.data) });
}

// ---------------------------------------------------------------------------
// POST mp-order-status — el POS consulta; el backend refresca contra MP si hace falta
// ---------------------------------------------------------------------------

async function loadStatus(deps: HandlerDeps, jwt: string, deviceId: string, saleId: string): Promise<RpcResult> {
  return rpc(deps, "mp_get_order_status", { p_device_id: deviceId, p_sale_id: saleId }, { jwt });
}

export async function handleOrderStatus(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const body = await readJson(req);
  if (!body || !isUuid(body.deviceId) || !isUuid(body.saleId)) return failure(400, "BAD_REQUEST", "Datos incompletos.");

  let status = await loadStatus(deps, jwt, body.deviceId, body.saleId);
  if (!status.ok) return rpcFailure(status);
  let order = asObject(status.data);
  let stale = false;

  const pending = order?.status === "CREATED" || order?.status === "REQUESTING";
  const mpOrderId = typeof order?.mpOrderId === "string" ? order.mpOrderId : null;
  if (order && pending && mpOrderId) {
    const lastChecked = typeof order.lastCheckedAt === "string" ? Date.parse(order.lastCheckedAt) : 0;
    if (deps.now() - lastChecked >= REFRESH_MIN_INTERVAL_MS) {
      const fetched = await mpRequest(deps, "GET", `/v1/orders/${encodeURIComponent(mpOrderId)}`);
      if (fetched.ok && fetched.body) {
        await applyMpOrder(deps, fetched.body as MercadoPagoOrder, "POLL");
        status = await loadStatus(deps, jwt, body.deviceId, body.saleId);
        if (!status.ok) return rpcFailure(status);
        order = asObject(status.data);
      } else {
        stale = true;
      }
    }
  }
  return jsonResponse(200, { ok: true, order: publicOrder(order), stale });
}

// ---------------------------------------------------------------------------
// POST mp-cancel-order — el empleado cancela un cobro pendiente (no borra la venta)
// ---------------------------------------------------------------------------

export async function handleCancelOrder(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const body = await readJson(req);
  if (!body || !isUuid(body.deviceId) || !isUuid(body.saleId)) return failure(400, "BAD_REQUEST", "Datos incompletos.");

  const status = await loadStatus(deps, jwt, body.deviceId, body.saleId);
  if (!status.ok) return rpcFailure(status);
  const order = asObject(status.data);
  const mpOrderId = typeof order?.mpOrderId === "string" ? order.mpOrderId : null;
  if (!order || !mpOrderId || order.status !== "CREATED") {
    return jsonResponse(200, { ok: true, order: publicOrder(order), cancelled: false });
  }

  // El estado final lo decide MP: se intenta cancelar y SIEMPRE se re-consulta (si ya estaba
  // pagada, la cancelación falla y la consulta lo refleja como CONFIRMED).
  await mpRequest(deps, "POST", `/v1/orders/${encodeURIComponent(mpOrderId)}/cancel`, { idempotencyKey: crypto.randomUUID() });
  const fetched = await mpRequest(deps, "GET", `/v1/orders/${encodeURIComponent(mpOrderId)}`);
  if (!fetched.ok || !fetched.body) return failure(502, "MP_UNAVAILABLE", "No se pudo confirmar la cancelación con Mercado Pago.", { order: publicOrder(order) });
  await applyMpOrder(deps, fetched.body as MercadoPagoOrder, "CANCEL");
  const after = await loadStatus(deps, jwt, body.deviceId, body.saleId);
  if (!after.ok) return rpcFailure(after);
  const finalOrder = asObject(after.data);
  return jsonResponse(200, { ok: true, order: publicOrder(finalOrder), cancelled: finalOrder?.status === "CANCELLED" });
}

// ---------------------------------------------------------------------------
// POST mp-webhook — notificación firmada; verify_jwt desactivado (la firma es la autenticación)
// ---------------------------------------------------------------------------

export async function handleWebhook(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const secret = deps.env("MERCADOPAGO_WEBHOOK_SECRET");
  if (!secret) {
    deps.log("mp-webhook: MERCADOPAGO_WEBHOOK_SECRET is not configured");
    return failure(500, "NOT_CONFIGURED", "Webhook no configurado."); // MP reintenta
  }
  const raw = await req.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = raw ? JSON.parse(raw) : null;
  } catch {
    parsedBody = null;
  }
  const notification = parseNotification(req.url, parsedBody);
  const requestId = req.headers.get("x-request-id");

  const authentic = await verifyWebhookSignature({
    secret,
    signatureHeader: req.headers.get("x-signature"),
    requestId,
    dataId: notification.dataId
  });
  if (!authentic) {
    // Nada se registra de un request sin firma válida (no se llena la base con basura).
    deps.log("mp-webhook: invalid signature");
    return failure(401, "INVALID_SIGNATURE", "Firma inválida.");
  }

  const dedupeKey = `${notification.action ?? "unknown"}|${notification.dataId ?? "none"}|${requestId ?? "norequest"}`;
  const recordEvent = (result: string, extra: { mpStatus?: string | null; mpStatusDetail?: string | null; externalReference?: string | null } = {}) =>
    rpc(deps, "mp_record_webhook_event", {
      p_dedupe_key: dedupeKey,
      p_action: notification.action,
      p_event_type: notification.type,
      p_mp_order_id: notification.dataId,
      p_request_id: requestId,
      p_external_reference: extra.externalReference ?? null,
      p_mp_status: extra.mpStatus ?? null,
      p_mp_status_detail: extra.mpStatusDetail ?? null,
      p_result: result
    }, { service: true });

  if ((notification.type ?? "").toLowerCase() !== "order" || !notification.dataId) {
    await recordEvent("IGNORED_EVENT_TYPE");
    return jsonResponse(200, { ok: true, ignored: true });
  }

  // El cuerpo del webhook no es la fuente de verdad: se consulta la orden a Mercado Pago.
  const fetched = await mpRequest(deps, "GET", `/v1/orders/${encodeURIComponent(notification.dataId)}`);
  if (fetched.status === 404) {
    await recordEvent("IGNORED_UNKNOWN_ORDER");
    return jsonResponse(200, { ok: true, ignored: true });
  }
  if (!fetched.ok || !fetched.body) {
    await recordEvent("FETCH_FAILED");
    return failure(502, "MP_UNAVAILABLE", "No se pudo consultar la orden."); // MP reintenta
  }
  const mpOrder = fetched.body as MercadoPagoOrder;
  const interpreted = interpretOrder(mpOrder);
  const applied = await applyMpOrder(deps, mpOrder, "WEBHOOK");
  const eventInfo = {
    mpStatus: interpreted.mpStatus,
    mpStatusDetail: interpreted.mpStatusDetail,
    externalReference: typeof mpOrder.external_reference === "string" ? mpOrder.external_reference : null
  };
  if (!applied.result.ok) {
    await recordEvent("APPLY_FAILED", eventInfo);
    return failure(500, "INTERNAL", "No se pudo aplicar la notificación."); // MP reintenta
  }
  const outcome = asObject(applied.result.data);
  await recordEvent(
    !applied.found ? "IGNORED_UNKNOWN_ORDER" : typeof outcome?.ignored === "string" ? outcome.ignored : interpreted.status === "UNKNOWN" ? "UNKNOWN_STATE" : "APPLIED",
    eventInfo
  );
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// POST mp-admin-setup — alta controlada de Store / POS (sólo admin; dry-run por defecto)
// ---------------------------------------------------------------------------

export async function handleAdminSetup(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
  const jwt = bearer(req);
  if (!jwt) return failure(401, "UNAUTHENTICATED", "Sesión no válida.");
  const admin = await rpc(deps, "mp_admin_context", {}, { jwt });
  if (!admin.ok) return rpcFailure(admin);

  const body = await readJson(req);
  const action = body?.action;
  if (!body || (action !== "store" && action !== "pos")) return failure(400, "BAD_REQUEST", "action debe ser 'store' o 'pos'.");

  // Por defecto sólo muestra el payload exacto que se enviaría. Crear requiere confirm === true.
  const confirm = body.confirm === true;
  let payload: JsonObject;
  try {
    payload = action === "store" ? buildStorePayload(body.store as StoreInput) : buildPosPayload(body.pos as PosInput);
  } catch (error) {
    return failure(422, "INVALID_REQUEST", error instanceof Error ? error.message : "Datos inválidos.");
  }
  if (!confirm) return jsonResponse(200, { ok: true, dryRun: true, wouldSend: payload, action });

  if (!deps.env("MERCADOPAGO_ACCESS_TOKEN")) return failure(503, "MP_SERVER_NOT_CONFIGURED", "Mercado Pago no está configurado en el servidor.");

  let created: MpResponse;
  if (action === "store") {
    const me = await mpRequest(deps, "GET", "/users/me");
    const userId = me.body?.id;
    if (!me.ok || (typeof userId !== "number" && typeof userId !== "string")) {
      return failure(502, "MP_UNAVAILABLE", "No se pudo identificar la cuenta de Mercado Pago.");
    }
    created = await mpRequest(deps, "POST", `/users/${String(userId)}/stores`, { body: payload });
  } else {
    created = await mpRequest(deps, "POST", "/v2/pos", { body: payload, idempotencyKey: crypto.randomUUID() });
  }
  if (!created.ok || !created.body) {
    deps.log("mp-admin-setup: Mercado Pago rejected the request", { status: created.status });
    return failure(422, "MP_REJECTED", "Mercado Pago rechazó la solicitud.", { mpStatus: created.status, mpCode: mpErrorCode(created) });
  }
  const qr = asObject(created.body.qr_response) ?? asObject(created.body.qr);
  return jsonResponse(200, {
    ok: true,
    dryRun: false,
    action,
    id: created.body.id ?? null,
    externalId: created.body.external_id ?? null,
    qrImage: typeof qr?.image === "string" ? qr.image : null,
    qrTemplateDocument: typeof qr?.template_document === "string" ? qr.template_document : null
  });
}
