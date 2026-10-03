// Proveedor de WhatsApp (D-059): interfaz mínima + implementación Meta Cloud API + mock, configuración
// leída SÓLO de secrets de Edge Functions, y utilidades del webhook (verificación y parseo).
//
// La lógica de negocio (handlers) habla con `WhatsAppProvider`, nunca con `graph.facebook.com`: así se
// prueba sin Meta real, se simulan `sent`/`failed`, se cambian detalles de la Graph API sin tocar el flujo
// del POS y más adelante se puede enviar un PDF/documento (`header`) sin reescribir nada.
//
// Ningún secreto se loguea, se devuelve ni llega al POS.

export interface WhatsAppTemplateMessage {
  /** Destino en formato `to` de la Cloud API: sólo dígitos con código de país (sin "+"). */
  to: string;
  templateName: string;
  languageCode: string;
  /** Valores de `{{1}}..{{n}}` del cuerpo. Una sola línea cada uno (ver `sanitizeTemplateParameter`). */
  bodyParameters: readonly string[];
  /** Futuro PDF: encabezado de tipo documento (aún no lo usa ninguna plantilla). */
  header?: { type: "document"; link: string; filename: string };
}

export type WhatsAppSendResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      /** Código del proveedor (ej. `131030`) o interno (`NETWORK`, `TIMEOUT`, `HTTP_500`). Seguro de guardar. */
      code: string;
      message: string;
      /** El error es transitorio (red, 5xx, límite de tasa): reintentar puede funcionar. */
      retryable: boolean;
    };

/** Mensaje de texto libre: sólo válido dentro de la ventana de servicio (el cliente escribió primero). */
export interface WhatsAppTextMessage {
  to: string;
  body: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  /** Mensaje de plantilla (iniciado por el negocio). Fallback; el flujo principal no lo usa. */
  sendTemplate(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  /** Mensaje de servicio/free-form (respuesta a un mensaje del cliente). Sin plantilla. */
  sendText(message: WhatsAppTextMessage): Promise<WhatsAppSendResult>;
}

// ---------------------------------------------------------------------------
// Configuración (secrets). Nada de esto vive en Postgres ni en el repo.
// ---------------------------------------------------------------------------

export interface WhatsAppConfig {
  provider: WhatsAppProvider;
  templateName: string;
  languageCode: string;
}

export type WhatsAppConfigResult =
  | { ok: true; config: WhatsAppConfig }
  | { ok: false; missing: string[] };

export interface WhatsAppEnv {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
}

const GRAPH_TIMEOUT_MS = 10_000;
const REQUIRED_SENDING_SECRETS = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_GRAPH_VERSION",
  "WHATSAPP_TEMPLATE_NAME",
  "WHATSAPP_TEMPLATE_LANGUAGE"
] as const;

/**
 * Arma el proveedor desde los secrets. `WHATSAPP_PROVIDER=mock` (sólo desarrollo) envía a ninguna parte y
 * devuelve un id falso, para probar el flujo completo sin credenciales. En el MVP hay UNA configuración para
 * toda la organización; `branchId` queda como punto de extensión para un número distinto por sucursal
 * (resolver el `phoneNumberId` por sucursal sin tocar el flujo).
 */
export function resolveWhatsAppConfig(deps: WhatsAppEnv, _options: { branchId?: string } = {}): WhatsAppConfigResult {
  const templateName = deps.env("WHATSAPP_TEMPLATE_NAME")?.trim();
  const languageCode = deps.env("WHATSAPP_TEMPLATE_LANGUAGE")?.trim();
  if (deps.env("WHATSAPP_PROVIDER")?.trim().toLowerCase() === "mock") {
    return { ok: true, config: { provider: createMockProvider(), templateName: templateName || "ticket_compra", languageCode: languageCode || "es_AR" } };
  }
  const missing = REQUIRED_SENDING_SECRETS.filter((name) => !deps.env(name)?.trim());
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    config: {
      provider: createMetaCloudProvider({
        fetch: deps.fetch,
        accessToken: deps.env("WHATSAPP_ACCESS_TOKEN")?.trim() ?? "",
        phoneNumberId: deps.env("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "",
        graphVersion: deps.env("WHATSAPP_GRAPH_VERSION")?.trim() ?? ""
      }),
      templateName: templateName ?? "",
      languageCode: languageCode ?? ""
    }
  };
}

const REQUIRED_PROVIDER_SECRETS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_GRAPH_VERSION"] as const;

/**
 * Proveedor SIN plantilla: lo que necesita responder a un mensaje del cliente (flujo del QR). Sólo exige
 * token, `phone_number_id` y versión de la Graph API; nombre/idioma de plantilla no hacen falta.
 */
export function resolveWhatsAppProvider(deps: WhatsAppEnv): { ok: true; provider: WhatsAppProvider } | { ok: false; missing: string[] } {
  if (deps.env("WHATSAPP_PROVIDER")?.trim().toLowerCase() === "mock") return { ok: true, provider: createMockProvider() };
  const missing = REQUIRED_PROVIDER_SECRETS.filter((name) => !deps.env(name)?.trim());
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    provider: createMetaCloudProvider({
      fetch: deps.fetch,
      accessToken: deps.env("WHATSAPP_ACCESS_TOKEN")?.trim() ?? "",
      phoneNumberId: deps.env("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "",
      graphVersion: deps.env("WHATSAPP_GRAPH_VERSION")?.trim() ?? ""
    })
  };
}

// ---------------------------------------------------------------------------
// Meta Cloud API
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** Códigos de Meta que indican un problema transitorio (límite de tasa / servicio): vale reintentar. */
const RETRYABLE_META_CODES = new Set(["1", "2", "4", "17", "32", "613", "80007", "130429", "131016", "131048", "131056"]);

export function createMetaCloudProvider(input: {
  fetch: typeof fetch;
  accessToken: string;
  phoneNumberId: string;
  /** Ej. `v21.0`. Se configura por secret: no queda congelada en el código. */
  graphVersion: string;
  timeoutMs?: number;
}): WhatsAppProvider {
  const version = input.graphVersion.startsWith("v") ? input.graphVersion : `v${input.graphVersion}`;

  async function post(body: JsonObject): Promise<WhatsAppSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, input.timeoutMs ?? GRAPH_TIMEOUT_MS);
    try {
      const response = await input.fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(input.phoneNumberId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await response.text();
      let parsed: JsonObject | null = null;
      try {
        parsed = raw ? asObject(JSON.parse(raw)) : null;
      } catch {
        parsed = null;
      }
      if (response.ok) {
        const messages = parsed?.messages;
        const first = Array.isArray(messages) ? asObject(messages[0]) : null;
        if (typeof first?.id === "string" && first.id !== "") return { ok: true, messageId: first.id };
        return { ok: false, code: "BAD_RESPONSE", message: "WhatsApp no devolvió el id del mensaje.", retryable: false };
      }
      const error = asObject(parsed?.error);
      const code = typeof error?.code === "number" || typeof error?.code === "string" ? String(error.code) : `HTTP_${String(response.status)}`;
      const detail = asObject(error?.error_data);
      const message = (typeof detail?.details === "string" ? detail.details : typeof error?.message === "string" ? error.message : "WhatsApp rechazó el mensaje.");
      return {
        ok: false,
        code: code.slice(0, 80),
        message: message.slice(0, 300),
        retryable: response.status >= 500 || response.status === 429 || RETRYABLE_META_CODES.has(code)
      };
    } catch (thrown) {
      const aborted = thrown instanceof Error && thrown.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "TIMEOUT" : "NETWORK",
        message: aborted ? "WhatsApp no respondió a tiempo." : "No se pudo contactar a WhatsApp.",
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "meta-cloud-api",
    sendTemplate(message) {
      const components: JsonObject[] = [];
      if (message.header) {
        components.push({
          type: "header",
          parameters: [{ type: "document", document: { link: message.header.link, filename: message.header.filename } }]
        });
      }
      components.push({ type: "body", parameters: message.bodyParameters.map((text) => ({ type: "text", text })) });
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.to,
        type: "template",
        template: { name: message.templateName, language: { code: message.languageCode }, components }
      });
    },
    sendText(message) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.to,
        type: "text",
        text: { preview_url: false, body: message.body }
      });
    }
  };
}

/** Proveedor de desarrollo: no envía nada. Devuelve un id con prefijo `wamid.MOCK.` para reconocerlo. */
export function createMockProvider(options: { outcome?: "sent" | "failed"; code?: string; message?: string } = {}): WhatsAppProvider & {
  sent: WhatsAppTemplateMessage[];
  sentTexts: WhatsAppTextMessage[];
} {
  const sent: WhatsAppTemplateMessage[] = [];
  const sentTexts: WhatsAppTextMessage[] = [];
  const outcome = (): Promise<WhatsAppSendResult> => options.outcome === "failed"
    ? Promise.resolve({ ok: false, code: options.code ?? "MOCK_FAILED", message: options.message ?? "Fallo simulado.", retryable: false })
    : Promise.resolve({ ok: true, messageId: `wamid.MOCK.${crypto.randomUUID()}` });
  return {
    name: "mock",
    sent,
    sentTexts,
    sendTemplate(message) {
      sent.push(message);
      return outcome();
    },
    sendText(message) {
      sentTexts.push(message);
      return outcome();
    }
  };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, message as BufferSource);
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/**
 * Firma `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256 del cuerpo CRUDO (bytes tal cual llegaron; Meta
 * escapa caracteres no ASCII, reserializar el JSON rompería la firma) con el **App Secret** de la app de Meta.
 */
export async function verifyMetaSignature(input: { appSecret: string; signatureHeader: string | null | undefined; rawBody: Uint8Array }): Promise<boolean> {
  if (!input.appSecret || !input.signatureHeader) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(input.signatureHeader.trim());
  if (!match?.[1]) return false;
  const expected = await hmacSha256Hex(input.appSecret, input.rawBody);
  return constantTimeEqual(expected, match[1].toLowerCase());
}

export async function computeMetaSignature(appSecret: string, rawBody: Uint8Array): Promise<string> {
  return `sha256=${await hmacSha256Hex(appSecret, rawBody)}`;
}

export type DeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

export interface StatusEvent {
  providerMessageId: string;
  /** Estado normalizado, o `null` si Meta mandó uno que no modelamos (`deleted`, `warning`…). */
  status: DeliveryStatus | null;
  /** Estado crudo de Meta, para la auditoría. */
  rawStatus: string;
  /** ISO-8601 a partir del `timestamp` (segundos epoch) de Meta; null si no vino. */
  occurredAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Clave de idempotencia: mensaje + estado + timestamp. */
  dedupeKey: string;
}

const STATUS_MAP: Record<string, DeliveryStatus> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/**
 * Extrae los eventos de estado de un payload de webhook (`entry[].changes[].value.statuses[]`). Los mensajes
 * entrantes de clientes y cualquier otra cosa se ignoran (esta integración es sólo de comprobantes).
 */
export function parseStatusEvents(payload: unknown): StatusEvent[] {
  const events: StatusEvent[] = [];
  const root = asObject(payload);
  if (!root || !Array.isArray(root.entry)) return events;
  for (const entryValue of root.entry as unknown[]) {
    const changes = asObject(entryValue)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const changeValue of changes as unknown[]) {
      const statuses = asObject(asObject(changeValue)?.value)?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const statusValue of statuses as unknown[]) {
        const status = asObject(statusValue);
        const id = typeof status?.id === "string" ? status.id : null;
        const rawStatus = typeof status?.status === "string" ? status.status.toLowerCase() : null;
        if (!status || !id || !rawStatus) continue;
        const seconds = typeof status.timestamp === "string" || typeof status.timestamp === "number" ? Number(status.timestamp) : NaN;
        const occurredAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
        const firstError = Array.isArray(status.errors) ? asObject(status.errors[0]) : null;
        const detail = asObject(firstError?.error_data);
        const errorMessage = typeof detail?.details === "string" ? detail.details : typeof firstError?.message === "string" ? firstError.message : typeof firstError?.title === "string" ? firstError.title : null;
        events.push({
          providerMessageId: id,
          status: STATUS_MAP[rawStatus] ?? null,
          rawStatus,
          occurredAt,
          errorCode: typeof firstError?.code === "number" || typeof firstError?.code === "string" ? String(firstError.code).slice(0, 80) : null,
          errorMessage: errorMessage ? errorMessage.slice(0, 300) : null,
          dedupeKey: `${id}|${rawStatus}|${occurredAt ?? "none"}`
        });
      }
    }
  }
  return events;
}

export interface InboundTextMessage {
  /** `message.id` de Meta: clave de deduplicación (Meta puede reenviar el evento). */
  messageId: string;
  /** Remitente (`from`), sólo dígitos con código de país: de acá sale el teléfono del destinatario. */
  from: string;
  /** ISO-8601 a partir del `timestamp` (segundos epoch) de Meta; null si no vino. */
  receivedAt: string | null;
  text: string;
}

/** Mensajes de TEXTO entrantes (`entry[].changes[].value.messages[]`). Otros tipos (imagen, audio…) se ignoran. */
export function parseInboundMessages(payload: unknown): InboundTextMessage[] {
  const messages: InboundTextMessage[] = [];
  const root = asObject(payload);
  if (!root || !Array.isArray(root.entry)) return messages;
  for (const entryValue of root.entry as unknown[]) {
    const changes = asObject(entryValue)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const changeValue of changes as unknown[]) {
      const inbound = asObject(asObject(changeValue)?.value)?.messages;
      if (!Array.isArray(inbound)) continue;
      for (const messageValue of inbound as unknown[]) {
        const message = asObject(messageValue);
        const id = typeof message?.id === "string" ? message.id : null;
        const from = typeof message?.from === "string" ? message.from : null;
        const body = asObject(message?.text)?.body;
        if (!message || !id || !from || message.type !== "text" || typeof body !== "string") continue;
        const seconds = typeof message.timestamp === "string" || typeof message.timestamp === "number" ? Number(message.timestamp) : NaN;
        messages.push({
          messageId: id,
          from,
          receivedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
          text: body
        });
      }
    }
  }
  return messages;
}
