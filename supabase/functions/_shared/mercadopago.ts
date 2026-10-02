// Lógica pura de la integración Mercado Pago (Orders API, QR). Sin Deno, sin Supabase, sin red:
// sólo funciones deterministas, para poder correrlas igual en una Edge Function y en Vitest
// (`packages/business-logic/src/mercadopago.test.ts`). Dinero siempre en centavos enteros.
//
// Referencias (API vigente, no los endpoints legacy de QR/instore):
//   POST /v1/orders (type "qr")      GET /v1/orders/{id}      POST /v1/orders/{id}/cancel
//   webhook topic "Order (Mercado Pago)" con cabecera x-signature (HMAC-SHA256).

export type MercadoPagoQrMode = "static" | "dynamic" | "hybrid";

/** Estado propio de un intento de cobro (`mercadopago_orders.status`). */
export type MercadoPagoOrderStatus =
  | "REQUESTING"
  | "CREATED"
  | "CONFIRMED"
  | "EXPIRED"
  | "CANCELLED"
  | "REFUNDED"
  | "ERROR";

/** Estado de verificación del pago de una venta (`payments.verification_status`). */
export type PaymentVerificationStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "CONFIRMED"
  | "EXPIRED"
  | "CANCELLED"
  | "ERROR"
  | "MISMATCH"
  | "REFUNDED";

export const MERCADOPAGO_PROVIDER = "MERCADOPAGO" as const;

// ---------------------------------------------------------------------------
// Montos: centavos enteros <-> string decimal de Mercado Pago ("750.00"). Sin floats.
// ---------------------------------------------------------------------------

export function centsToDecimalString(cents: number | bigint): string {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  if (value < 0n) throw new RangeError("Amount must not be negative");
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

/** "750.00" | "750" | "750.5" -> 75000 | 75000 | 75050. Cualquier otra forma -> null. */
export function parseDecimalToCents(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const cents = whole * 100n + fraction;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

// ---------------------------------------------------------------------------
// Referencia externa: attempt 1 === sale_id exacto (trazabilidad 1:1); reintentos `<sale_id>-<n>`.
// MP: máx. 64 caracteres, alfanumérico, guion y guion bajo.
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function buildExternalReference(saleId: string, attempt: number): string {
  if (!isUuid(saleId)) throw new TypeError("saleId must be a UUID");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new RangeError("attempt out of range");
  return attempt === 1 ? saleId.toLowerCase() : `${saleId.toLowerCase()}-${String(attempt)}`;
}

export function parseExternalReference(reference: unknown): { saleId: string; attempt: number } | null {
  if (typeof reference !== "string") return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d{1,2}))?$/.exec(reference);
  if (!match) return null;
  const attempt = match[2] === undefined ? 1 : Number(match[2]);
  if (attempt < 1) return null;
  return { saleId: match[1] ?? "", attempt };
}

// ---------------------------------------------------------------------------
// Alta de la orden QR
// ---------------------------------------------------------------------------

export interface CreateQrOrderInput {
  externalReference: string;
  amountCents: number;
  externalPosId: string;
  mode: MercadoPagoQrMode;
  expirationMinutes: number;
  description?: string;
}

export interface CreateQrOrderBody {
  type: "qr";
  total_amount: string;
  description: string;
  external_reference: string;
  expiration_time: string;
  config: { qr: { external_pos_id: string; mode: MercadoPagoQrMode } };
  transactions: { payments: { amount: string }[] };
}

export function buildCreateQrOrderBody(input: CreateQrOrderInput): CreateQrOrderBody {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError("amountCents must be a positive integer");
  if (!Number.isInteger(input.expirationMinutes) || input.expirationMinutes < 1 || input.expirationMinutes > 120) {
    throw new RangeError("expirationMinutes must be between 1 and 120");
  }
  if (input.externalReference.length > 64 || !/^[A-Za-z0-9_-]+$/.test(input.externalReference)) {
    throw new TypeError("externalReference is not valid for Mercado Pago");
  }
  if (!/^[A-Za-z0-9]{1,40}$/.test(input.externalPosId)) throw new TypeError("externalPosId is not valid for Mercado Pago");
  const amount = centsToDecimalString(input.amountCents);
  return {
    type: "qr",
    total_amount: amount,
    // Sin datos personales (la API lo prohíbe); el detalle de la venta vive en nuestro sistema.
    description: (input.description ?? "Venta carniceria").slice(0, 150),
    external_reference: input.externalReference,
    expiration_time: `PT${String(input.expirationMinutes)}M`,
    config: { qr: { external_pos_id: input.externalPosId, mode: input.mode } },
    transactions: { payments: [{ amount }] }
  };
}

// ---------------------------------------------------------------------------
// Interpretación de una orden devuelta por MP (GET /v1/orders/{id} o cuerpo del webhook)
// ---------------------------------------------------------------------------

export interface MercadoPagoOrderPayment {
  id?: string;
  status?: string;
  status_detail?: string;
  amount?: string | number;
  paid_amount?: string | number;
}

export interface MercadoPagoOrder {
  id?: string;
  external_reference?: string;
  status?: string;
  status_detail?: string;
  total_amount?: string | number;
  type_response?: { qr_data?: string };
  transactions?: { payments?: MercadoPagoOrderPayment[] };
}

export interface InterpretedOrder {
  /** Estado propio al que converge; "UNKNOWN" = combinación no reconocida: no cambiar nada. */
  status: MercadoPagoOrderStatus | "UNKNOWN";
  mpStatus: string | null;
  mpStatusDetail: string | null;
  mpPaymentId: string | null;
  totalAmountCents: number | null;
  paidAmountCents: number | null;
}

function lower(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

/**
 * Regla central de seguridad: SÓLO `processed` + `accredited` confirma un pago. Todo lo demás
 * (incluido `processed` con otro detalle, p. ej. `partially_refunded`) jamás se marca confirmado.
 */
export function interpretOrder(order: MercadoPagoOrder): InterpretedOrder {
  const status = lower(order.status);
  const detail = lower(order.status_detail);
  const payments = order.transactions?.payments ?? [];
  const payment = payments.find((p) => lower(p.status) === "processed") ?? payments[0];
  const paymentStatus = lower(payment?.status);

  const paidAmountCents =
    parseDecimalToCents(payment?.paid_amount) ?? parseDecimalToCents(payment?.amount);
  const base = {
    mpStatus: status,
    mpStatusDetail: detail,
    mpPaymentId: typeof payment?.id === "string" ? payment.id : null,
    totalAmountCents: parseDecimalToCents(order.total_amount),
    paidAmountCents
  };

  let mapped: InterpretedOrder["status"];
  switch (status) {
    case "processed":
      mapped = detail === "accredited" && (paymentStatus === null || paymentStatus === "processed") ? "CONFIRMED" : "UNKNOWN";
      break;
    case "refunded":
      mapped = "REFUNDED";
      break;
    case "canceled":
    case "cancelled":
      mapped = "CANCELLED";
      break;
    case "expired":
      mapped = "EXPIRED";
      break;
    case "failed":
      mapped = "ERROR";
      break;
    case "created":
    case "at_terminal":
    case "action_required":
    case "processing":
    case "pending":
      mapped = "CREATED";
      break;
    default:
      mapped = "UNKNOWN";
  }
  return { status: mapped, ...base };
}

// ---------------------------------------------------------------------------
// Webhook: notificación + firma
// ---------------------------------------------------------------------------

export interface MercadoPagoNotification {
  type: string | null;
  action: string | null;
  dataId: string | null;
}

/**
 * `data.id` viaja en la query (`?data.id=...`) y en el cuerpo. La firma se calcula con el de la
 * query cuando existe, así que ese tiene prioridad.
 */
export function parseNotification(url: string, body: unknown): MercadoPagoNotification {
  let queryId: string | null = null;
  let queryType: string | null = null;
  try {
    const parsed = new URL(url);
    queryId = parsed.searchParams.get("data.id");
    queryType = parsed.searchParams.get("type");
  } catch {
    // URL relativa o inválida: sólo cuerpo.
  }
  const record = (body !== null && typeof body === "object" ? body : {}) as {
    type?: unknown;
    action?: unknown;
    data?: { id?: unknown } | null;
  };
  const bodyId = typeof record.data?.id === "string" ? record.data.id : null;
  return {
    type: typeof record.type === "string" ? record.type : queryType,
    action: typeof record.action === "string" ? record.action : null,
    dataId: queryId ?? bodyId
  };
}

export interface SignatureParts {
  ts: string;
  v1: string;
}

export function parseSignatureHeader(header: string | null | undefined): SignatureParts | null {
  if (!header) return null;
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "v1") v1 = value;
  }
  return ts && v1 ? { ts, v1 } : null;
}

/** Manifiesto firmado: `id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts>;` (omite lo ausente). */
export function buildSignatureManifest(dataId: string | null, requestId: string | null, ts: string): string {
  let manifest = "";
  if (dataId) manifest += `id:${dataId.toLowerCase()};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  return manifest;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function computeWebhookSignature(secret: string, dataId: string | null, requestId: string | null, ts: string): Promise<string> {
  return hmacSha256Hex(secret, buildSignatureManifest(dataId, requestId, ts));
}

/**
 * Autenticidad del webhook. No hay ventana de tolerancia de `ts` a propósito: MP reintenta cada
 * 15 min y rechazar reintentos legítimos es peor que aceptar un replay, porque un replay no puede
 * falsear nada — nunca confiamos en el cuerpo: siempre se re-consulta la orden a MP.
 */
export async function verifyWebhookSignature(input: {
  secret: string;
  signatureHeader: string | null | undefined;
  requestId: string | null | undefined;
  dataId: string | null | undefined;
}): Promise<boolean> {
  if (!input.secret) return false;
  const parts = parseSignatureHeader(input.signatureHeader);
  if (!parts) return false;
  const expected = await computeWebhookSignature(input.secret, input.dataId ?? null, input.requestId ?? null, parts.ts);
  return constantTimeEqual(expected, parts.v1.toLowerCase());
}

// ---------------------------------------------------------------------------
// Alta controlada de Store / POS (caja). Sólo construye el payload; nada se envía desde acá.
// ---------------------------------------------------------------------------

export interface StoreInput {
  name: string;
  externalId: string;
  streetName: string;
  streetNumber: string;
  cityName: string;
  stateName: string;
  latitude: number;
  longitude: number;
  reference?: string;
}

export function buildStorePayload(input: StoreInput): Record<string, unknown> {
  if (!/^[A-Za-z0-9]{1,60}$/.test(input.externalId)) throw new TypeError("store externalId must be alphanumeric (max 60)");
  if (!input.name.trim()) throw new TypeError("store name is required");
  if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90) throw new RangeError("latitude out of range");
  if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) throw new RangeError("longitude out of range");
  return {
    name: input.name.trim(),
    external_id: input.externalId,
    location: {
      street_number: input.streetNumber,
      street_name: input.streetName,
      city_name: input.cityName,
      state_name: input.stateName,
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.reference ? { reference: input.reference } : {})
    }
  };
}

export interface PosInput {
  name: string;
  externalId: string;
  storeId?: string;
  externalStoreId?: string;
  /** MCC opcional; sólo se envía si lo informa quien configura (no se inventa ninguno). */
  category?: number;
}

export function buildPosPayload(input: PosInput): Record<string, unknown> {
  if (!/^[A-Za-z0-9]{1,40}$/.test(input.externalId)) throw new TypeError("pos externalId must be alphanumeric (max 40)");
  if (!input.storeId && !input.externalStoreId) throw new TypeError("storeId or externalStoreId is required");
  return {
    name: input.name.trim(),
    external_id: input.externalId,
    ...(input.storeId ? { store_id: Number(input.storeId) } : { external_store_id: input.externalStoreId }),
    ...(input.category === undefined ? {} : { category: input.category })
  };
}

// ---------------------------------------------------------------------------
// Presentación (usada por el POS): qué mostrar según el estado que informa el servidor.
// El POS nunca "promueve" un estado: sólo traduce lo que el backend ya confirmó.
// ---------------------------------------------------------------------------

export type MercadoPagoPanelTone = "waiting" | "success" | "warning" | "error";

/**
 * Cómo terminó (o no) el cobro, en términos de dinero:
 *   WAITING          sigue esperando la acreditación (o hay que reintentar generar el cobro)
 *   PAID             Mercado Pago acreditó el monto exacto
 *   NOT_PAID         terminó SIN acreditación (cancelado o vencido): la venta queda anulada
 *   NEEDS_ATTENTION  dinero devuelto o monto distinto: lo resuelve el administrador
 */
export type MercadoPagoOutcome = "WAITING" | "PAID" | "NOT_PAID" | "NEEDS_ATTENTION";

export interface MercadoPagoPanelView {
  tone: MercadoPagoPanelTone;
  title: string;
  detail: string;
  outcome: MercadoPagoOutcome;
  /** Mientras sea true el POS sigue consultando. */
  polling: boolean;
  /** Permite generar un cobro nuevo para la misma venta (sólo si el alta falló; nunca tras cancelar/vencer). */
  canRetry: boolean;
  /** Permite cancelar el cobro en curso / anular la venta que no tiene cobro vivo. */
  canCancel: boolean;
  cancelLabel: string;
}

const NOT_PAID_VIEW_BASE = { tone: "warning", outcome: "NOT_PAID", polling: false, canRetry: false, canCancel: false, cancelLabel: "" } as const;

/**
 * Los estados terminales sin acreditación (CANCELLED / EXPIRED) son definitivos: la venta ya quedó
 * anulada en el servidor, así que no se ofrece "generar cobro nuevo" ni se deja el cobro "pendiente".
 */
export function describePaymentState(input: {
  status: MercadoPagoOrderStatus | null;
  verification: PaymentVerificationStatus | null;
  online: boolean;
}): MercadoPagoPanelView {
  const { status, verification } = input;
  // El estado de la venta (que ya compara montos) manda sobre el de la orden.
  if (verification === "MISMATCH") {
    return { tone: "error", title: "Monto acreditado distinto", detail: "El importe cobrado no coincide con la venta. Avisá al administrador.", outcome: "NEEDS_ATTENTION", polling: false, canRetry: false, canCancel: false, cancelLabel: "" };
  }
  if (status === "CONFIRMED" && verification !== "PENDING") {
    return { tone: "success", title: "✓ Pago confirmado", detail: "Mercado Pago acreditó el pago.", outcome: "PAID", polling: false, canRetry: false, canCancel: false, cancelLabel: "" };
  }
  if (status === "REFUNDED" || verification === "REFUNDED") {
    return { tone: "warning", title: "Pago devuelto", detail: "Mercado Pago informó una devolución.", outcome: "NEEDS_ATTENTION", polling: false, canRetry: false, canCancel: false, cancelLabel: "" };
  }
  if (status === "EXPIRED" || (status === null && verification === "EXPIRED")) {
    return { ...NOT_PAID_VIEW_BASE, title: "Cobro vencido", detail: "El tiempo para pagar terminó sin acreditación. La venta quedó anulada: no se cobró." };
  }
  if (status === "CANCELLED" || (status === null && verification === "CANCELLED")) {
    return { ...NOT_PAID_VIEW_BASE, title: "Cobro cancelado", detail: "El cobro fue cancelado sin acreditación. La venta quedó anulada: no se cobró." };
  }
  switch (status) {
    case "ERROR":
      return { tone: "error", title: "No se pudo generar el cobro", detail: "Reintentá, o anulá la venta para cobrar con otro medio.", outcome: "WAITING", polling: false, canRetry: true, canCancel: true, cancelLabel: "Anular venta (no se cobró)" };
    case "REQUESTING":
      return input.online
        ? { tone: "waiting", title: "Generando cobro…", detail: "Un momento.", outcome: "WAITING", polling: true, canRetry: false, canCancel: false, cancelLabel: "" }
        : { tone: "warning", title: "Pago pendiente", detail: "Sin conexión: el cobro se generará al reconectar.", outcome: "WAITING", polling: true, canRetry: false, canCancel: false, cancelLabel: "" };
    case "CREATED":
      return input.online
        ? { tone: "waiting", title: "Esperando pago…", detail: "Pedile al cliente que escanee el QR de la caja.", outcome: "WAITING", polling: true, canRetry: false, canCancel: true, cancelLabel: "Cancelar cobro" }
        : { tone: "warning", title: "Pago pendiente", detail: "Sin conexión: se verificará al reconectar.", outcome: "WAITING", polling: true, canRetry: false, canCancel: false, cancelLabel: "" };
    default:
      return { tone: "warning", title: "Pago pendiente", detail: "Todavía no hay un cobro generado para esta venta.", outcome: "WAITING", polling: false, canRetry: true, canCancel: true, cancelLabel: "Anular venta (no se cobró)" };
  }
}

/**
 * ¿Un cobro con este estado de verificación se puede RETOMAR desde "MP pendientes"? Sólo el que sigue
 * esperando (PENDING) o el que falló técnicamente y se puede reintentar (ERROR). Nunca un estado
 * terminal: CONFIRMED, CANCELLED, EXPIRED (sin acreditación, venta anulada), REFUNDED ni MISMATCH
 * (esos los resuelve el administrador).
 */
export function isRecoverableMercadoPagoPayment(verification: PaymentVerificationStatus | string | null | undefined): boolean {
  return verification === "PENDING" || verification === "ERROR";
}

/** Estados de verificación que anulan la venta (no acreditada): su stock deja de contar en la caja. */
export function isNotAccreditedVerification(verification: PaymentVerificationStatus | string | null | undefined): boolean {
  return verification === "CANCELLED" || verification === "EXPIRED";
}
