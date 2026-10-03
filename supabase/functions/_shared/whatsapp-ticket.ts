// Lógica PURA del ticket digital por WhatsApp (D-059): normalización del teléfono, elegibilidad de la
// venta, modelo del ticket, texto legible y parámetros de la plantilla. Sin red, sin Supabase, sin Deno,
// sin React: la usan la Edge Function (Deno), el POS (validación del teléfono en pantalla) y los tests, y
// es la base de un futuro PDF (el PDF sólo necesita renderizar el mismo `TicketModel`).
//
// Reglas:
//   * Los datos salen de la venta REAL del servidor (RPC `wa_prepare_ticket`); nada de lo que manda el POS
//     (total, líneas, precios) entra al ticket.
//   * Nunca incluye costo, proveedor, margen, stock ni datos del empleado: `parseTicketSource` sólo
//     conserva los campos de la lista blanca de abajo, así que aunque el servidor devolviera más, no pasan.

// ---------------------------------------------------------------------------
// Teléfono
// ---------------------------------------------------------------------------

export type PhoneErrorCode =
  | "EMPTY"
  | "INVALID_CHARACTERS"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "MISSING_AREA_CODE"
  | "INVALID_AREA_CODE"
  | "AMBIGUOUS";

export type PhoneResult =
  | {
      ok: true;
      /** E.164 con "+": lo que se guarda en `ticket_deliveries.recipient_phone`. */
      e164: string;
      /** Sólo dígitos (formato `to` de la Cloud API). */
      waId: string;
      /** Legible para mostrar de vuelta al empleado, ej. `+54 9 3496 123456`. */
      display: string;
    }
  | { ok: false; code: PhoneErrorCode; message: string };

const PHONE_MESSAGES: Record<PhoneErrorCode, string> = {
  EMPTY: "Ingresá el teléfono del cliente.",
  INVALID_CHARACTERS: "El teléfono sólo puede tener números, espacios, guiones y un + al inicio.",
  TOO_SHORT: "El número está incompleto. Ingresá el código de área y el número completo (ej. +54 9 3496 123456).",
  TOO_LONG: "El número tiene dígitos de más. Revisalo (ej. +54 9 3496 123456).",
  MISSING_AREA_CODE: "Falta el código de área. Ingresá el número completo (ej. +54 9 3496 123456).",
  INVALID_AREA_CODE: "El código de área no es válido. Ingresá el número completo (ej. +54 9 3496 123456).",
  AMBIGUOUS: "No se pudo determinar el número con certeza. Ingresalo completo, sin 0 ni 15 (ej. +54 9 3496 123456)."
};

function phoneError(code: PhoneErrorCode): PhoneResult {
  return { ok: false, code, message: PHONE_MESSAGES[code] };
}

/** Códigos de área argentinos: 11 (AMBA) o 2xx/3xx (3 dígitos) o 2xxx/3xxx (4 dígitos). */
function plausibleAreaCode(area: string): boolean {
  if (area.length === 2) return area === "11";
  return (area.length === 3 || area.length === 4) && /^[23]/.test(area);
}

/**
 * `AAAA15SSSSSS` (12 dígitos, área + 15 + abonado). El largo del área es 2, 3 o 4: se prueban las tres
 * posiciones y sólo se acepta si queda UN resultado distinto; si no, es ambiguo y se pide el número completo.
 */
function resolveFifteenPrefix(twelveDigits: string): string | "AMBIGUOUS" | null {
  const candidates = new Set<string>();
  for (const areaLength of [2, 3, 4]) {
    const area = twelveDigits.slice(0, areaLength);
    if (plausibleAreaCode(area) && twelveDigits.slice(areaLength, areaLength + 2) === "15") {
      candidates.add(area + twelveDigits.slice(areaLength + 2));
    }
  }
  if (candidates.size === 1) return [...candidates][0] ?? null;
  return candidates.size === 0 ? null : "AMBIGUOUS";
}

function argentinaMobile(national: string): PhoneResult {
  if (!/^[0-9]{10}$/.test(national)) return phoneError(national.length < 10 ? "TOO_SHORT" : "TOO_LONG");
  const areaOk = plausibleAreaCode(national.slice(0, 2)) || plausibleAreaCode(national.slice(0, 3)) || plausibleAreaCode(national.slice(0, 4));
  if (!areaOk) return phoneError("INVALID_AREA_CODE");
  const waId = `549${national}`;
  return { ok: true, e164: `+${waId}`, waId, display: `+54 9 ${national.slice(0, national.length - 6)} ${national.slice(-6)}` };
}

/**
 * Convierte lo que tipea la empleada al formato E.164 de WhatsApp. Argentina primero: acepta `+54 9 …`,
 * `54 …`, `0 … 15 …`, `… 15 …` y el número nacional de 10 dígitos, siempre que el resultado sea inequívoco
 * (10 dígitos nacionales con código de área plausible). Un número internacional explícito (`+` + otro país)
 * se acepta si tiene un largo E.164 válido. Nunca se completa ni se adivina un número incompleto.
 */
export function normalizePhone(raw: unknown): PhoneResult {
  if (typeof raw !== "string" || raw.trim() === "") return phoneError("EMPTY");
  const text = raw.replace(/[()]/g, "").trim();
  if (!/^\+?[0-9\s.-]+$/.test(text)) return phoneError("INVALID_CHARACTERS");
  let digits = text.replace(/[^0-9]/g, "");
  let international = text.startsWith("+");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits === "") return phoneError("EMPTY");

  // Con código de país (explícito, o `54…` de 12/13 dígitos sin el +).
  if (digits.startsWith("54") && (international || digits.length === 12 || digits.length === 13)) {
    const rest = digits.slice(2);
    if (rest.startsWith("9")) return argentinaMobile(rest.slice(1));
    if (rest.startsWith("0") || rest.length > 10) return phoneError(rest.length > 11 ? "TOO_LONG" : "AMBIGUOUS");
    return argentinaMobile(rest);
  }
  if (international) {
    if (digits.startsWith("0")) return phoneError("INVALID_AREA_CODE");
    if (digits.length < 8) return phoneError("TOO_SHORT");
    if (digits.length > 15) return phoneError("TOO_LONG");
    return { ok: true, e164: `+${digits}`, waId: digits, display: `+${digits}` };
  }

  // Número nacional argentino.
  const hadTrunk = digits.startsWith("0");
  const national = hadTrunk ? digits.slice(1) : digits;
  if (national.length === 11 && national.startsWith("9") && !hadTrunk) return argentinaMobile(national.slice(1));
  if (national.length === 12) {
    const resolved = resolveFifteenPrefix(national);
    if (resolved === "AMBIGUOUS") return phoneError("AMBIGUOUS");
    if (resolved === null) return phoneError("INVALID_AREA_CODE");
    return argentinaMobile(resolved);
  }
  if (national.length < 10) return phoneError(national.length <= 8 ? "MISSING_AREA_CODE" : "TOO_SHORT");
  if (national.length === 11) return phoneError(national.startsWith("15") ? "MISSING_AREA_CODE" : "AMBIGUOUS");
  if (national.length > 12) return phoneError("TOO_LONG");
  // `15` + 8 dígitos: número local con prefijo de celular y sin código de área.
  if (national.startsWith("15")) return phoneError("MISSING_AREA_CODE");
  return argentinaMobile(national);
}

/** `+54*******3456`: lo único que se muestra del número fuera de donde es imprescindible. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return e164;
  return `${e164.slice(0, 3)}${"*".repeat(e164.length - 7)}${e164.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Datos de la venta (salida de `wa_prepare_ticket`) — lista blanca estricta
// ---------------------------------------------------------------------------

export interface TicketSourceItem {
  name: string;
  /** Gramos (línea por peso) o null. */
  weightGrams: number | null;
  /** Unidades (línea por unidad) o null. Exactamente uno de los dos está presente. */
  quantityUnits: number | null;
  /** Precio unitario de lista/efectivo por kg o por unidad, en centavos. */
  unitPriceCents: number;
  promotionDiscountCents: number;
  cardSurchargeCents: number;
  /** Importe final de la línea (ya con promoción y recargo). */
  subtotalCents: number;
  promotionMode: string | null;
  /** D-061: el operador fijó el precio de esta línea (`unitPriceCents` ya es ese precio manual). */
  manualPriceApplied: boolean;
}

export interface TicketSourcePayment {
  method: string | null;
  provider: string | null;
  verificationStatus: string | null;
  amountCents: number;
}

export interface TicketSource {
  saleId: string;
  status: string;
  completedAt: string;
  totalCents: number;
  /** D-061: descuento general del ticket (0 si no hubo): suma de líneas = total + descuento. */
  ticketDiscountBps: number;
  ticketDiscountCents: number;
  organizationName: string;
  branchName: string;
  timezone: string;
  items: TicketSourceItem[];
  payments: TicketSourcePayment[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Valida y copia (lista blanca) lo que devolvió el servidor. Cualquier forma inesperada => null. */
export function parseTicketSource(value: unknown): TicketSource | null {
  const sale = asRecord(value);
  if (!sale) return null;
  const saleId = text(sale.saleId);
  const status = text(sale.status);
  const completedAt = text(sale.completedAt);
  const organizationName = text(sale.organizationName);
  const branchName = text(sale.branchName);
  const totalCents = nonNegInt(sale.totalCents);
  // Un servidor que todavía no conoce el descuento general no manda estas claves: valen 0.
  const ticketDiscountBps = nonNegInt(sale.ticketDiscountBps ?? 0);
  const ticketDiscountCents = nonNegInt(sale.ticketDiscountCents ?? 0);
  if (!saleId || !status || !completedAt || !organizationName || !branchName || totalCents === null
      || ticketDiscountBps === null || ticketDiscountCents === null
      || !Array.isArray(sale.items) || !Array.isArray(sale.payments)) return null;

  const items: TicketSourceItem[] = [];
  for (const entry of sale.items as unknown[]) {
    const item = asRecord(entry);
    const name = text(item?.name);
    const unitPriceCents = nonNegInt(item?.unitPriceCents);
    const subtotalCents = nonNegInt(item?.subtotalCents);
    const promotionDiscountCents = nonNegInt(item?.promotionDiscountCents ?? 0);
    const cardSurchargeCents = nonNegInt(item?.cardSurchargeCents ?? 0);
    const weightGrams = item?.weightGrams === null || item?.weightGrams === undefined ? null : nonNegInt(item.weightGrams);
    const quantityUnits = item?.quantityUnits === null || item?.quantityUnits === undefined ? null : nonNegInt(item.quantityUnits);
    if (!item || !name || unitPriceCents === null || subtotalCents === null || promotionDiscountCents === null || cardSurchargeCents === null) return null;
    if ((weightGrams === null) === (quantityUnits === null)) return null;
    if ((weightGrams ?? quantityUnits ?? 0) <= 0) return null;
    items.push({
      name, weightGrams, quantityUnits, unitPriceCents, promotionDiscountCents, cardSurchargeCents, subtotalCents,
      promotionMode: typeof item.promotionMode === "string" ? item.promotionMode : null,
      manualPriceApplied: item.manualPriceApplied === true
    });
  }

  const payments: TicketSourcePayment[] = [];
  for (const entry of sale.payments as unknown[]) {
    const payment = asRecord(entry);
    const amountCents = nonNegInt(payment?.amountCents);
    if (!payment || amountCents === null) return null;
    payments.push({
      method: typeof payment.method === "string" ? payment.method : null,
      provider: typeof payment.provider === "string" ? payment.provider : null,
      verificationStatus: typeof payment.verificationStatus === "string" ? payment.verificationStatus : null,
      amountCents
    });
  }

  return {
    saleId, status, completedAt, totalCents, ticketDiscountBps, ticketDiscountCents, organizationName, branchName,
    timezone: text(sale.timezone) ?? "America/Argentina/Buenos_Aires",
    items, payments
  };
}

// ---------------------------------------------------------------------------
// Elegibilidad
// ---------------------------------------------------------------------------

export type TicketEligibilityCode = "SALE_NOT_COMPLETED" | "PAYMENT_NOT_CONFIRMED" | "EMPTY_SALE" | "TOTAL_MISMATCH";

export type TicketEligibility = { ok: true } | { ok: false; code: TicketEligibilityCode };

/**
 * ¿Se puede emitir el comprobante FINAL? Sólo una venta realmente cobrada y completada: `COMPLETED`
 * (nunca PENDING_PAYMENT, CANCELLED, REFUNDED ni DRAFT) con todo pago verificado por proveedor
 * (Mercado Pago) en `CONFIRMED`, y con líneas cuya suma coincide con el total del servidor (un ticket
 * con un total distinto del real no se envía jamás).
 */
export function evaluateTicketEligibility(source: TicketSource): TicketEligibility {
  if (source.status !== "COMPLETED") return { ok: false, code: "SALE_NOT_COMPLETED" };
  if (source.payments.some((payment) => payment.provider !== null && payment.verificationStatus !== "CONFIRMED")) {
    return { ok: false, code: "PAYMENT_NOT_CONFIRMED" };
  }
  if (source.items.length === 0) return { ok: false, code: "EMPTY_SALE" };
  const sum = source.items.reduce((total, item) => total + item.subtotalCents, 0);
  // Suma de líneas = total + descuento general (D-061): un ticket que no cierra con el total real no se envía jamás.
  if (sum - source.ticketDiscountCents !== source.totalCents) return { ok: false, code: "TOTAL_MISMATCH" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Formatos (es-AR, sin depender de ICU: determinístico en Deno y Node)
// ---------------------------------------------------------------------------

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** `$10.000` / `$10.000,50` (centavos sólo si existen). */
export function formatMoney(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? "-" : ""}$${groupThousands(whole)}${fraction === 0 ? "" : `,${String(fraction).padStart(2, "0")}`}`;
}

/** `500` -> `5`, `1250` -> `12,5`, `725` -> `7,25` (porcentaje legible de un valor en basis points). */
export function formatBpsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)},${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/** `Descuento general (5%): -$1.200` o null si el ticket no tuvo descuento. */
function discountRow(model: TicketModel): string | null {
  return model.ticketDiscountBps > 0 ? `Descuento general (${formatBpsPercent(model.ticketDiscountBps)}%): -${formatMoney(model.ticketDiscountCents)}` : null;
}

/** `1,250 kg` (tres decimales, igual que el POS). */
export function formatKilograms(grams: number): string {
  return `${groupThousands(Math.floor(grams / 1000))},${String(grams % 1000).padStart(3, "0")} kg`;
}

/** `02/10/2026 14:35` en la zona horaria de la organización. */
export function formatDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("es-AR", {
      timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  DEBIT: "Tarjeta de débito",
  CREDIT: "Tarjeta de crédito",
  OTHER: "Otro"
};

function paymentLabel(payments: readonly TicketSourcePayment[]): string | null {
  const labels: string[] = [];
  for (const payment of payments) {
    const label = payment.provider === "MERCADOPAGO" ? "Mercado Pago" : payment.method ? (METHOD_LABELS[payment.method] ?? null) : null;
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join(" + ") : null;
}

// ---------------------------------------------------------------------------
// Modelo y texto
// ---------------------------------------------------------------------------

export interface TicketLine {
  name: string;
  kind: "WEIGHT" | "UNIT";
  /** `1,250 kg` o `4 u.` */
  quantityLabel: string;
  /** `$10.000/kg` o `$5.000 c/u` (precio de lista/efectivo). */
  unitPriceLabel: string;
  promotionDiscountCents: number;
  cardSurchargeCents: number;
  /** Importe final de la línea (con promoción y recargo ya aplicados). */
  subtotalCents: number;
  /** D-061: el precio de la línea lo fijó el operador (`unitPriceLabel` ya es ese precio). */
  manualPrice: boolean;
}

export interface TicketModel {
  businessName: string;
  branchName: string;
  /** Primeros 8 caracteres del id de la venta (el mismo número corto que muestra el POS). */
  shortSaleId: string;
  issuedAtLabel: string;
  lines: TicketLine[];
  promotionTotalCents: number;
  cardSurchargeTotalCents: number;
  /** D-061: descuento general del ticket (0 = sin descuento) y su porcentaje en basis points. */
  ticketDiscountCents: number;
  ticketDiscountBps: number;
  totalCents: number;
  paymentLabel: string | null;
}

export function buildTicketModel(source: TicketSource): TicketModel {
  const lines: TicketLine[] = source.items.map((item) => {
    const weight = item.weightGrams !== null;
    return {
      name: item.name,
      kind: weight ? "WEIGHT" : "UNIT",
      quantityLabel: weight ? formatKilograms(item.weightGrams ?? 0) : `${String(item.quantityUnits ?? 0)} u.`,
      unitPriceLabel: weight ? `${formatMoney(item.unitPriceCents)}/kg` : `${formatMoney(item.unitPriceCents)} c/u`,
      promotionDiscountCents: item.promotionDiscountCents,
      cardSurchargeCents: item.cardSurchargeCents,
      subtotalCents: item.subtotalCents,
      manualPrice: item.manualPriceApplied
    };
  });
  return {
    businessName: source.organizationName,
    branchName: source.branchName,
    shortSaleId: source.saleId.slice(0, 8).toLowerCase(),
    issuedAtLabel: formatDateTime(source.completedAt, source.timezone),
    lines,
    promotionTotalCents: lines.reduce((total, line) => total + line.promotionDiscountCents, 0),
    cardSurchargeTotalCents: lines.reduce((total, line) => total + line.cardSurchargeCents, 0),
    ticketDiscountCents: source.ticketDiscountCents,
    ticketDiscountBps: source.ticketDiscountBps,
    totalCents: source.totalCents,
    paymentLabel: paymentLabel(source.payments)
  };
}

/** Una línea del ticket en una sola fila: `Vacío 1,250 kg x $10.000/kg = $12.500 (promo -$500)`. */
export function renderTicketLine(line: TicketLine): string {
  const notes: string[] = [];
  if (line.manualPrice) notes.push("precio manual");
  if (line.promotionDiscountCents > 0) notes.push(`promo -${formatMoney(line.promotionDiscountCents)}`);
  if (line.cardSurchargeCents > 0) notes.push(`recargo tarjeta +${formatMoney(line.cardSurchargeCents)}`);
  return `${line.name} ${line.quantityLabel} x ${line.unitPriceLabel} = ${formatMoney(line.subtotalCents)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

/** Ticket completo, multilínea y compacto. Sirve para vista previa, logs de prueba y como base de un PDF. */
export function renderTicketText(model: TicketModel): string {
  const rows = [
    model.businessName,
    `Sucursal ${model.branchName}`,
    `Ticket #${model.shortSaleId} - ${model.issuedAtLabel}`,
    "",
    ...model.lines.map(renderTicketLine)
  ];
  if (model.promotionTotalCents > 0) rows.push(`Promociones: -${formatMoney(model.promotionTotalCents)}`);
  if (model.cardSurchargeTotalCents > 0) rows.push(`Recargo tarjeta: +${formatMoney(model.cardSurchargeTotalCents)}`);
  const discountText = discountRow(model);
  if (discountText) rows.push(discountText);
  rows.push("", `TOTAL ${formatMoney(model.totalCents)}`);
  if (model.paymentLabel) rows.push(`Pago: ${model.paymentLabel}`);
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Parámetros de la plantilla (UTILITY)
// ---------------------------------------------------------------------------

/** Cantidad de variables del cuerpo de la plantilla `ticket_compra` (ver docs/WHATSAPP.md). */
export const TICKET_TEMPLATE_PARAMETER_COUNT = 7;
/** El cuerpo de una plantilla admite 1024 caracteres: el detalle se acota para no pasarse. */
export const MAX_ITEMS_PARAMETER_LENGTH = 700;

/**
 * WhatsApp rechaza (error 132018) un parámetro con saltos de línea, tabulaciones o más de 4 espacios
 * seguidos, o vacío: se normaliza todo a una sola línea.
 */
export function sanitizeTemplateParameter(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return flat === "" ? "-" : flat;
}

/**
 * Valores de las variables `{{1}}..{{7}}` de la plantilla:
 * 1 nombre comercial · 2 sucursal · 3 nº corto de venta · 4 fecha/hora · 5 detalle (una sola línea,
 * ítems separados por " | ") · 6 total · 7 medio de pago.
 */
export function buildTemplateParameters(model: TicketModel): string[] {
  const rendered = model.lines.map(renderTicketLine);
  const discountText = discountRow(model);
  if (discountText) rendered.push(discountText);
  // Se reserva lugar para el "y N más" final; siempre entra al menos la primera línea (acotada).
  const reserve = " | y 999 más".length;
  const kept: string[] = [];
  let length = 0;
  for (const [index, row] of rendered.entries()) {
    const added = (kept.length > 0 ? 3 : 0) + row.length;
    const isLast = index === rendered.length - 1;
    if (kept.length > 0 && length + added > MAX_ITEMS_PARAMETER_LENGTH - (isLast ? 0 : reserve)) {
      kept.push(`y ${String(rendered.length - index)} más`);
      break;
    }
    kept.push(row);
    length += added;
  }
  let detail = kept.join(" | ");
  if (detail.length > MAX_ITEMS_PARAMETER_LENGTH) detail = `${detail.slice(0, MAX_ITEMS_PARAMETER_LENGTH - 1)}…`;
  return [
    model.businessName,
    model.branchName,
    model.shortSaleId,
    model.issuedAtLabel,
    detail,
    formatMoney(model.totalCents),
    model.paymentLabel ?? "No informado"
  ].map(sanitizeTemplateParameter);
}

// ---------------------------------------------------------------------------
// Mensaje free-form (ticket pedido por el cliente: ventana de servicio, SIN plantilla)
// ---------------------------------------------------------------------------

/** Límite de un mensaje de texto de WhatsApp es 4096; se deja margen. */
export const MAX_WHATSAPP_MESSAGE_LENGTH = 3800;

/** `*`, `_`, `~` y comillas invertidas son formato de WhatsApp: se quitan de los textos libres (nombres). */
function stripWhatsAppFormatting(value: string): string {
  return value.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Ticket en UN solo mensaje legible para WhatsApp (negritas con `*`). Mismo modelo que la plantilla y el
 * texto plano: nunca costo, proveedor, margen, stock ni datos del empleado. Si hay demasiadas líneas se
 * recorta el detalle con "… y N productos más"; el total siempre es el real.
 */
export function renderWhatsAppMessage(model: TicketModel, maxLength: number = MAX_WHATSAPP_MESSAGE_LENGTH): string {
  const header = [
    `🧾 *${stripWhatsAppFormatting(model.businessName)}*`,
    `Sucursal ${stripWhatsAppFormatting(model.branchName)}`,
    "",
    `Ticket #${model.shortSaleId}`,
    model.issuedAtLabel,
    ""
  ];
  const footer: string[] = [""];
  if (model.promotionTotalCents > 0) footer.push(`Promociones: -${formatMoney(model.promotionTotalCents)}`);
  if (model.cardSurchargeTotalCents > 0) footer.push(`Recargo tarjeta: +${formatMoney(model.cardSurchargeTotalCents)}`);
  const discountText = discountRow(model);
  if (discountText) footer.push(discountText);
  footer.push(`*TOTAL: ${formatMoney(model.totalCents)}*`);
  if (model.paymentLabel) footer.push(`Medio de pago: ${model.paymentLabel}`);

  const rows = model.lines.map((line) => `• ${renderTicketLine({ ...line, name: stripWhatsAppFormatting(line.name) })}`);
  const fixed = header.join("\n").length + footer.join("\n").length + 2;
  const kept: string[] = [];
  let used = fixed;
  for (const [index, row] of rows.entries()) {
    const tail = `… y ${String(rows.length - index)} productos más`;
    const isLast = index === rows.length - 1;
    if (kept.length > 0 && used + row.length + 1 > maxLength - (isLast ? 0 : tail.length + 1)) {
      kept.push(tail);
      break;
    }
    kept.push(row);
    used += row.length + 1;
  }
  return [...header, ...kept, ...footer].join("\n");
}
