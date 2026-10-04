/**
 * Renderer del ticket impreso (NO fiscal): `SaleReceipt` -> `PrintDocument` (líneas de texto + estilo).
 * Lógica pura y determinista (se prueba sin impresora). Toda la alineación se resuelve acá, en columnas de una
 * fuente monoespaciada; Rust sólo codifica a ESC/POS (ver `src-tauri/src/printer`). Un carácter = un code point:
 * el codificador pone un `?` por cada carácter que el juego de caracteres no tiene, así el ancho nunca se rompe.
 */

import type { ReceiptLine, SaleReceipt } from "./receipt";

export type PrintStyle = "normal" | "bold" | "double";
export interface PrintLine { text: string; style: PrintStyle }
export interface PrintDocument { lines: PrintLine[] }

/** Columnas de la fuente A según el ancho de papel. 42 sirve tanto a las térmicas de 42 como de 48 columnas. */
export function columnsForPaperWidth(paperWidthMm: number): number {
  return paperWidthMm <= 58 ? 32 : 42;
}

export const RECEIPT_TITLE = "COMPROBANTE NO FISCAL";
export const REPRINT_BANNER = "*** REIMPRESION ***";
export const RECEIPT_THANKS = "Gracias por su compra";
const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

// ---------------------------------------------------------------------------
// Texto en columnas
// ---------------------------------------------------------------------------

/** Un carácter por code point, sin controles y con espacios colapsados (un nombre de producto no puede romper el layout). */
function clean(text: string): string[] {
  return Array.from(text.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim());
}

function fit(text: string, width: number): string {
  return clean(text).slice(0, Math.max(0, width)).join("");
}

/** Corte por palabras; una palabra más larga que el ancho se parte. Nunca devuelve una línea más ancha que `width`. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const word of clean(text).join("").split(" ")) {
    if (word === "") continue;
    let chars = Array.from(word);
    while (chars.length > width) {
      if (current.length > 0) { out.push(current.join("")); current = []; }
      out.push(chars.slice(0, width).join(""));
      chars = chars.slice(width);
    }
    if (current.length === 0) current = chars;
    else if (current.length + 1 + chars.length <= width) current = [...current, " ", ...chars];
    else { out.push(current.join("")); current = chars; }
  }
  if (current.length > 0) out.push(current.join(""));
  return out.length > 0 ? out : [""];
}

function center(text: string, width: number): string {
  const chars = fit(text, width);
  const length = Array.from(chars).length;
  return " ".repeat(Math.max(0, Math.floor((width - length) / 2))) + chars;
}

/** `izquierda` pegada a la izquierda y `derecha` a la derecha; si no entran juntas se recorta la izquierda. */
function row(left: string, right: string, width: number): string {
  const rightText = fit(right, width);
  const rightLength = Array.from(rightText).length;
  const leftText = fit(left, Math.max(0, width - rightLength - (rightLength > 0 ? 1 : 0)));
  const gap = Math.max(0, width - Array.from(leftText).length - rightLength);
  return leftText + " ".repeat(gap) + rightText;
}

const rule = (width: number) => "-".repeat(width);

// ---------------------------------------------------------------------------
// Formatos (es-AR, siempre ASCII: nada de espacios no cortables)
// ---------------------------------------------------------------------------

/** Centavos -> "$12.345" (con ",NN" sólo si hay centavos). El signo va antes del "$". */
export function formatReceiptMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}$${whole}${fraction === 0n ? "" : `,${fraction.toString().padStart(2, "0")}`}`;
}

const signed = (cents: bigint, sign: "-" | "+") => `${sign}${formatReceiptMoney(cents < 0n ? -cents : cents)}`;

/** Gramos -> "1,250 kg". */
export function formatReceiptWeight(grams: number): string {
  const whole = Math.trunc(grams / 1000);
  return `${String(whole)},${String(grams % 1000).padStart(3, "0")} kg`;
}

/** Basis points -> "25%", "7,5%", "12,34%". */
export function formatReceiptPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return `${String(whole)}${fraction === "" ? "" : `,${fraction}`}%`;
}

/** "04/10/2026  18:43", siempre en hora de Argentina (la de la caja). */
export function formatReceiptDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: ARGENTINA_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "??";
  return `${part("day")}/${part("month")}/${part("year")}  ${part("hour")}:${part("minute")}`;
}

/** Etiqueta amigable del medio de pago (nunca los nombres internos TRANSFER / MERCADOPAGO). */
export function paymentLabel(method: string, provider: string | null): string {
  if (provider === "MERCADOPAGO") return "Mercado Pago";
  switch (method) {
    case "CASH": return "Efectivo";
    case "DEBIT": return "Tarjeta de débito";
    case "CREDIT": return "Tarjeta de crédito";
    case "TRANSFER": return "Transferencia";
    default: return "Otro";
  }
}

// ---------------------------------------------------------------------------
// Líneas del ticket
// ---------------------------------------------------------------------------

function discountLabel(line: ReceiptLine): string {
  const promotion = line.promotion;
  if (promotion === null) return "Descuento";
  switch (promotion.kind) {
    case "PACK": return `Pack ${formatReceiptPercent(promotion.discountBps)} OFF`;
    case "BRANCH": return `${formatReceiptPercent(promotion.discountBps)} OFF desde ${String(promotion.minimumUnits)}`;
    case "PACK_FIXED_TOTAL": return "Promo pack";
    case "PERCENTAGE": return `Promo ${formatReceiptPercent(promotion.discountBps)} OFF`;
    case "FIXED_PRICE_PER_KG": return `Promo ${formatReceiptMoney(promotion.pricePerKgCents)}/kg`;
  }
}

/**
 * Una línea de producto:
 *   nombre / detalle (cantidad x precio) / [descuento] / [recargo de tarjeta] / importe (a la derecha).
 * Con descuento se muestra el precio de LISTA de esa venta y el descuento restado, así las filas suman el importe;
 * sin descuento se muestra el precio efectivamente cobrado (que ya incluye un eventual recargo de tarjeta). Una línea
 * de precio manual muestra el precio fijado por el operador y nada más (el ticket es para el cliente, no una auditoría).
 */
function renderProductLine(line: ReceiptLine, width: number): string[] {
  const out = wrapText(line.productName, width);
  const showList = !line.manualPrice && (line.promotionDiscount > 0n || line.promotion?.kind === "PACK_FIXED_TOTAL");
  const unitPrice = line.manualPrice && line.manualUnitPrice !== null ? line.manualUnitPrice : showList ? line.originalUnitPrice : line.chargedUnitPrice;

  let detail: string;
  if (line.unitType === "WEIGHT") {
    detail = `${formatReceiptWeight(line.weightGrams ?? 0)} x ${formatReceiptMoney(unitPrice)}/kg`;
  } else if (line.packCount !== null && line.packSizeUnitsSnapshot !== null) {
    const units = line.packCount * line.packSizeUnitsSnapshot;
    detail = `${String(line.packCount)} ${line.packCount === 1 ? "pack" : "packs"} x ${String(line.packSizeUnitsSnapshot)} u${line.packCount > 1 ? ` = ${String(units)} u` : ""}`;
  } else {
    detail = `${String(line.quantityUnits ?? 0)} x ${formatReceiptMoney(unitPrice)}`;
  }
  out.push(...wrapText(detail, width));

  if (!line.manualPrice) {
    if (line.promotionDiscount > 0n) out.push(row(discountLabel(line), signed(line.promotionDiscount, "-"), width));
    if (showList && line.cardSurcharge > 0n) out.push(row("Recargo tarjeta", signed(line.cardSurcharge, "+"), width));
  }
  out.push(row("", formatReceiptMoney(line.lineSubtotal), width));
  return out;
}

export interface ReceiptRenderOptions {
  /** Columnas de la fuente A (ver `columnsForPaperWidth`). */
  columns: number;
  /** Encabezado del ticket (configuración local de la caja). */
  businessName: string;
  /** Agrega `*** REIMPRESION ***` arriba. */
  reprint?: boolean;
}

const normal = (text: string): PrintLine => ({ text, style: "normal" });
const bold = (text: string): PrintLine => ({ text, style: "bold" });

export function renderSaleReceipt(receipt: SaleReceipt, options: ReceiptRenderOptions): PrintDocument {
  const width = Math.max(20, options.columns);
  const lines: PrintLine[] = [];

  if (options.reprint) lines.push(bold(center(REPRINT_BANNER, width)), normal(""));
  for (const text of wrapText(options.businessName.toLocaleUpperCase("es-AR"), width)) lines.push(bold(center(text, width)));
  if (receipt.branchName) for (const text of wrapText(receipt.branchName.toLocaleUpperCase("es-AR"), width)) lines.push(normal(center(text, width)));
  lines.push(normal(""), bold(center(RECEIPT_TITLE, width)), normal(""));
  lines.push(normal(formatReceiptDate(receipt.soldAt)));
  lines.push(normal(`Ticket: ${receipt.saleId.slice(0, 8).toUpperCase()}`));
  if (receipt.operatorName) lines.push(...wrapText(`Atendió: ${receipt.operatorName}`, width).map(normal));
  lines.push(normal(rule(width)));

  receipt.lines.forEach((line, index) => {
    if (index > 0) lines.push(normal(""));
    lines.push(...renderProductLine(line, width).map(normal));
  });
  lines.push(normal(rule(width)));

  if (receipt.ticketDiscount > 0n) {
    lines.push(normal(row("Subtotal", formatReceiptMoney(receipt.subtotal), width)));
    lines.push(normal(row(`Desc. general ${formatReceiptPercent(receipt.ticketDiscountBps)}`, signed(receipt.ticketDiscount, "-"), width)));
    lines.push(normal(rule(width)));
  }
  // Doble ancho = la mitad de columnas.
  lines.push({ text: row("TOTAL", formatReceiptMoney(receipt.total), Math.floor(width / 2)), style: "double" });
  lines.push(normal(""));
  lines.push(...wrapText(`Pago: ${paymentLabel(receipt.paymentMethod, receipt.paymentProvider)}`, width).map(normal));
  lines.push(normal(""), normal(rule(width)), normal(center(RECEIPT_THANKS, width)));
  return { lines };
}

/** Hoja de prueba: nombre de la impresora, hora y los caracteres que más suelen salir mal. */
export function renderTestPage(input: { printerName: string; now: Date; columns: number }): PrintDocument {
  const width = Math.max(20, input.columns);
  const lines: PrintLine[] = [
    bold(center("CARNICERIAS POS", width)), normal(""),
    normal(center("Prueba de impresion", width)), normal(""),
    ...wrapText(`Impresora: ${input.printerName}`, width).map(normal),
    normal(formatReceiptDate(input.now)), normal(""),
    normal("ABC abc 123"),
    normal("$ % ñ á é í ó ú"),
    normal("Ñ Á É Í Ó Ú Ü ¿? ¡!"),
    normal(""), normal(rule(Math.min(width, 16))),
    bold("Impresion correcta")
  ];
  return { lines };
}

/** El documento como texto plano (para pruebas, ejemplos y diagnóstico). */
export function documentToText(document: PrintDocument): string {
  return document.lines.map((line) => line.text).join("\n");
}
