import { capHeightEm, textWidthPt, toLabelText, type LabelFontStyle } from "./label-font";
import type { LabelRect, LabelRule, LabelText, LabelTextAnchor } from "./label-layout";
import { code128ModuleCount, code128Modules } from "./distribution/code128";
import { formatLogisticCode, isValidLogisticCode } from "./distribution/logistic-code";
import { EAN13_MODULE_COUNT, ean13Modules, isValidEan13, modulesToRuns } from "./vacuum-ean";
import {
  MM_PER_PT, THERMAL_DOT_MM, VACUUM_FIT_STEP, VACUUM_GAPS_MM, VACUUM_INFO_TYPE, VACUUM_LABEL_PAD, VACUUM_LOGISTIC, VACUUM_LOGISTIC_TYPE, VACUUM_MIN_FIT, VACUUM_PRICE_TYPE, type VacuumLabelDims
} from "./vacuum-label-spec";
import { isIsoDate } from "./date-range";
import { formatIsoDate, moneyText, weightText, type VacuumPackage } from "./vacuum";

/** La etiqueta no se puede imprimir (dato obligatorio faltante o inválido): el mensaje se muestra tal cual al operario. */
export class VacuumLabelError extends Error {}

/**
 * Las fechas de elaboración y vencimiento salen SIEMPRE del paquete registrado: no se generan ni se recalculan al imprimir. Si falta una o no es una fecha
 * válida se corta la impresión con un error claro (nunca se inventa una fecha). Se llama antes de imprimir; el layout de un borrador en pantalla no la usa.
 */
export function assertLabelDates(data: Pick<VacuumLabelData, "packedOn" | "expiresOn">): void {
  if (!isIsoDate(data.packedOn)) throw new VacuumLabelError("El paquete no tiene fecha de elaboración válida: no se imprime la etiqueta");
  if (!isIsoDate(data.expiresOn)) throw new VacuumLabelError("El paquete no tiene fecha de vencimiento válida: no se imprime la etiqueta");
  if (data.expiresOn < data.packedOn) throw new VacuumLabelError("El vencimiento del paquete es anterior a la elaboración: no se imprime la etiqueta");
}

/** «DD/MM/AAAA»; si el dato no es una fecha (borrador sin completar) deja el hueco a la vista en lugar de inventar una. */
const dateOrBlank = (value: string) => (isIsoDate(value) ? formatIsoDate(value) : "--/--/----");

/**
 * Geometría de las DOS etiquetas del envasado. Igual que la etiqueta de góndola (`label-layout.ts`), cada etiqueta es una lista de primitivas
 * en milímetros (textos con línea base, rectángulos, líneas y barras del código): el preview las dibuja como SVG y el PDF con pdf-lib, así que
 * ambos coinciden. Las medidas salen de `VacuumLabelDims` (configurable); nada acá asume 58 × 40.
 *
 * Los datos de entrada son el SNAPSHOT del paquete (o un borrador en pantalla): nunca precios, textos ni esquemas actuales.
 */

export type VacuumLabelKind = "INFO" | "PRICE" | "LOGISTIC";

/** Barra del código (mm desde la esquina superior izquierda de la etiqueta). */
export interface VacuumBar {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VacuumLabelLayout {
  kind: VacuumLabelKind;
  widthMm: number;
  heightMm: number;
  texts: LabelText[];
  rules: LabelRule[];
  rects: LabelRect[];
  bars: VacuumBar[];
  /** true si el contenido no entra en el alto configurado ni con la tipografía mínima: hay que aumentar el alto de la etiqueta. */
  overflow: boolean;
  /** Escala de tipografía con la que quedó (1 = tamaños de diseño). */
  fitScale: number;
  /** true si el paquete tiene código logístico pero NO entró en esta etiqueta informativa (se imprime la etiqueta logística aparte). */
  logisticOmitted: boolean;
}

/** Datos mínimos para dibujar las etiquetas (los del paquete registrado, o los del borrador del formulario). */
export interface VacuumLabelData {
  productName: string;
  weightGrams: number;
  pricePerKgCents: bigint;
  totalCents: bigint;
  packedOn: string;
  expiresOn: string;
  /** null en el borrador: el lote lo asigna el servidor al registrar. */
  lot: string | null;
  /** null = sin esquema EAN configurado (se dibuja un aviso en lugar de las barras). */
  ean13: string | null;
  /** Identificador logístico del paquete (null = el borrador todavía no lo tiene: lo asigna la base al registrar). */
  logisticCode: string | null;
  conservationText: string | null;
  businessName: string | null;
  address: string | null;
  establishmentInfo: string | null;
  extraText: string | null;
}

export function packageToLabelData(pkg: VacuumPackage): VacuumLabelData {
  return {
    productName: pkg.productName, weightGrams: pkg.weightGrams, pricePerKgCents: pkg.pricePerKgCents, totalCents: pkg.totalCents,
    packedOn: pkg.packedOn, expiresOn: pkg.expiresOn, lot: pkg.lot, ean13: pkg.ean13, logisticCode: pkg.logisticCode, conservationText: pkg.conservationText,
    businessName: pkg.businessName, address: pkg.address, establishmentInfo: pkg.establishmentInfo, extraText: pkg.extraText
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Medición y ajuste de texto
// ---------------------------------------------------------------------------------------------------------------------

const mmWidth = (text: string, pt: number, style: LabelFontStyle) => textWidthPt(text, pt, style) * MM_PER_PT;

/** Recorta con «…» hasta que entre en `maxMm`. */
function ellipsize(text: string, maxMm: number, pt: number, style: LabelFontStyle): string {
  if (mmWidth(text, pt, style) <= maxMm) return text;
  let cut = text;
  while (cut.length > 1 && mmWidth(`${cut}…`, pt, style) > maxMm) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Parte `text` en líneas de hasta `maxMm`; si excede `maxLines` la última termina en «…». Corta palabras más largas que el ancho. */
export function wrapText(raw: string, maxMm: number, pt: number, style: LabelFontStyle, maxLines: number): string[] {
  const text = toLabelText(raw);
  if (text === "") return [];
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line !== "") lines.push(line); line = ""; };
  for (const word of text.split(" ")) {
    let remaining = word;
    while (mmWidth(remaining, pt, style) > maxMm) {
      // Palabra más larga que la línea: se corta por caracteres.
      push();
      let take = remaining.length - 1;
      while (take > 1 && mmWidth(remaining.slice(0, take), pt, style) > maxMm) take -= 1;
      lines.push(remaining.slice(0, take));
      remaining = remaining.slice(take);
    }
    const candidate = line === "" ? remaining : `${line} ${remaining}`;
    if (mmWidth(candidate, pt, style) <= maxMm) line = candidate;
    else { push(); line = remaining; }
  }
  push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1] ?? ""} ${lines.slice(maxLines).join(" ")}`.trim(), maxMm, pt, style);
  return kept;
}

/** Mayor tamaño (≤ maxPt, ≥ minPt) con el que `text` entra en `maxMm` en una línea; si ni con minPt entra, se recorta. */
function fitOneLine(text: string, maxMm: number, maxPt: number, minPt: number, style: LabelFontStyle): { text: string; pt: number } {
  for (let pt = maxPt; pt >= minPt; pt -= 0.25) if (mmWidth(text, pt, style) <= maxMm) return { text, pt };
  return { text: ellipsize(text, maxMm, minPt, style), pt: minPt };
}

// ---------------------------------------------------------------------------------------------------------------------
// Constructor de la pila vertical
// ---------------------------------------------------------------------------------------------------------------------

class Stack {
  texts: LabelText[] = [];
  rules: LabelRule[] = [];
  rects: LabelRect[] = [];
  bars: VacuumBar[] = [];
  /** Borde superior del próximo bloque (mm). */
  y: number;

  constructor(top: number) { this.y = top; }

  text(id: string, text: string, pt: number, style: LabelFontStyle, anchor: LabelTextAnchor, x: number): void {
    const baseline = this.y + capHeightEm(style) * pt * MM_PER_PT;
    this.texts.push({ id, text, x, y: Math.round(baseline * 1000) / 1000, sizePt: Math.round(pt * 100) / 100, style, anchor });
  }

  advance(mm: number): void { this.y += mm; }

  rule(id: string, x1: number, x2: number, widthMm = 0.2): void {
    this.rules.push({ id, x1, x2, y1: this.y, y2: this.y, widthMm });
  }
}

type Build = (scale: number) => { stack: Stack; bottom: number };

/** Prueba escalas decrecientes de tipografía hasta que el contenido entre en el alto; si no entra, marca `overflow`. */
function composeFit(kind: VacuumLabelKind, widthMm: number, heightMm: number, build: Build): VacuumLabelLayout {
  const limit = heightMm - VACUUM_LABEL_PAD.bottomMm;
  let result = build(1);
  let overflow = result.bottom > limit;
  let fitScale = 1;
  for (let scale = 1 - VACUUM_FIT_STEP; overflow && scale >= VACUUM_MIN_FIT - 1e-9; scale -= VACUUM_FIT_STEP) {
    result = build(scale);
    fitScale = scale;
    overflow = result.bottom > limit;
  }
  const { stack } = result;
  return { kind, widthMm, heightMm, texts: stack.texts, rules: stack.rules, rects: stack.rects, bars: stack.bars, overflow, fitScale: Math.round(fitScale * 1000) / 1000, logisticOmitted: false };
}

const emHeight = (pt: number, lineHeightEm: number) => pt * MM_PER_PT * lineHeightEm;

// ---------------------------------------------------------------------------------------------------------------------
// Etiqueta A — INFORMATIVA / ELABORACIÓN
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Nombre del corte, elaboración, vencimiento, lote, peso neto, texto de conservación y los datos del establecimiento configurados.
 * No afirma ningún cumplimiento regulatorio: sólo imprime lo que la organización cargó.
 */
export function buildInfoLabelLayout(data: VacuumLabelData, dims: VacuumLabelDims): VacuumLabelLayout {
  const code = data.logisticCode;
  if (code === null || !isValidLogisticCode(code)) return buildInfoBase(data, dims, null);
  const inner = dims.widthMm - 2 * VACUUM_LABEL_PAD.xMm;
  if (code128ModuleCount(code.length) * VACUUM_LOGISTIC.moduleMm > inner) return { ...buildInfoBase(data, dims, null), logisticOmitted: true };
  const withCode = buildInfoBase(data, dims, code);
  if (!withCode.overflow && withCode.fitScale >= VACUUM_LOGISTIC.minFit) return withCode;
  // No entra con holgura: la informativa queda exactamente como era (sin achicar nada por culpa del código nuevo).
  return { ...buildInfoBase(data, dims, null), logisticOmitted: true };
}

function buildInfoBase(data: VacuumLabelData, dims: VacuumLabelDims, logisticCode: string | null): VacuumLabelLayout {
  const T = VACUUM_INFO_TYPE;
  const { widthMm, infoHeightMm } = dims;
  const left = VACUUM_LABEL_PAD.xMm;
  const right = widthMm - VACUUM_LABEL_PAD.xMm;
  const inner = right - left;
  const middle = left + inner / 2 + 1;

  return composeFit("INFO", widthMm, infoHeightMm, (scale) => {
    const stack = new Stack(VACUUM_LABEL_PAD.topMm);
    const name = toLabelText(data.productName);
    const namePt = fitNamePt(name, inner, T.name.maxPt * scale, T.name.minPt * scale, T.name.maxLines, T.name.style);
    const nameLines = wrapText(name, inner, namePt, T.name.style, T.name.maxLines);
    nameLines.forEach((line, index) => {
      stack.text(`name-${String(index + 1)}`, line, namePt, T.name.style, "start", left);
      stack.advance(emHeight(namePt, T.name.lineHeightEm));
    });
    stack.advance(VACUUM_GAPS_MM.line);
    stack.rule("rule-top", left, right);
    stack.advance(VACUUM_GAPS_MM.section);

    const captionPt = T.caption.pt * scale;
    const valuePt = T.value.pt * scale;
    const pair = (id: string, leftCaption: string, leftValue: string, rightCaption: string, rightValue: string) => {
      stack.text(`${id}-caption-left`, leftCaption, captionPt, T.caption.style, "start", left);
      stack.text(`${id}-caption-right`, rightCaption, captionPt, T.caption.style, "start", middle);
      stack.advance(emHeight(captionPt, 1.15));
      const maxLeft = middle - left - 1;
      const maxRight = right - middle;
      const l = fitOneLine(toLabelText(leftValue), maxLeft, valuePt, valuePt * 0.6, T.value.style);
      const r = fitOneLine(toLabelText(rightValue), maxRight, valuePt, valuePt * 0.6, T.value.style);
      stack.text(`${id}-value-left`, l.text, l.pt, T.value.style, "start", left);
      stack.text(`${id}-value-right`, r.text, r.pt, T.value.style, "start", middle);
      stack.advance(emHeight(Math.max(l.pt, r.pt), 1.2) + VACUUM_GAPS_MM.line);
    };
    pair("dates", "ELABORACIÓN", formatIsoDate(data.packedOn), "VENCIMIENTO", formatIsoDate(data.expiresOn));
    pair("lot", "LOTE", data.lot ?? "(se asigna al registrar)", "PESO NETO", weightText(data.weightGrams));

    const conservation = data.conservationText ? wrapText(data.conservationText, inner, T.body.pt * scale, T.body.style, T.body.maxLines) : [];
    if (conservation.length > 0) {
      stack.advance(VACUUM_GAPS_MM.line);
      conservation.forEach((line, index) => {
        stack.text(`conservation-${String(index + 1)}`, line, T.body.pt * scale, T.body.style, "start", left);
        stack.advance(emHeight(T.body.pt * scale, T.body.lineHeightEm));
      });
    }

    if (logisticCode !== null) {
      stack.advance(VACUUM_GAPS_MM.section * 0.6);
      drawLogisticCode(stack, logisticCode, widthMm, VACUUM_LOGISTIC.moduleMm, VACUUM_LOGISTIC.barHeightMm, VACUUM_LOGISTIC.textPt * scale, VACUUM_LOGISTIC.gapMm);
    }

    const footerParts: { id: string; text: string; style: LabelFontStyle; pt: number }[] = [];
    if (data.businessName) footerParts.push({ id: "business", text: data.businessName, style: T.footerTitle.style, pt: T.footerTitle.pt * scale });
    if (data.address) footerParts.push({ id: "address", text: data.address, style: T.footer.style, pt: T.footer.pt * scale });
    if (data.establishmentInfo) footerParts.push({ id: "establishment", text: data.establishmentInfo, style: T.footer.style, pt: T.footer.pt * scale });
    if (data.extraText) footerParts.push({ id: "extra", text: data.extraText, style: T.footer.style, pt: T.footer.pt * scale });
    if (footerParts.length > 0) {
      stack.advance(VACUUM_GAPS_MM.section * 0.6);
      stack.rule("rule-footer", left, right, 0.15);
      stack.advance(VACUUM_GAPS_MM.line + 0.4);
      for (const part of footerParts) {
        const lines = wrapText(part.text, inner, part.pt, part.style, T.footer.maxLines);
        lines.forEach((line, index) => {
          stack.text(`${part.id}-${String(index + 1)}`, line, part.pt, part.style, "start", left);
          stack.advance(emHeight(part.pt, T.footer.lineHeightEm));
        });
      }
    }
    return { stack, bottom: stack.y };
  });
}

/** Tamaño del nombre: el mayor que lo deja en `maxLines` líneas sin recortar. */
function fitNamePt(name: string, maxMm: number, maxPt: number, minPt: number, maxLines: number, style: LabelFontStyle): number {
  for (let pt = maxPt; pt >= minPt; pt -= 0.25) {
    const lines = wrapText(name, maxMm, pt, style, maxLines + 1);
    if (lines.length <= maxLines && !lines.some((line) => line.endsWith("…"))) return pt;
  }
  return minPt;
}

// ---------------------------------------------------------------------------------------------------------------------
// Etiqueta B — PRECIO / CAJA
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Etiqueta COMERCIAL. Jerarquía: corte, PRECIO FINAL (lo más grande), peso neto y precio por kg (una fila), fechas «ELAB» y «VENCE» (una fila), código
 * de barras y sus 13 dígitos. Sin información sanitaria. Las fechas son las del paquete registrado (snapshot), formateadas, nunca recalculadas.
 * Si todavía no hay esquema EAN configurado (`ean13 === null`) en lugar de las barras se dibuja un aviso: jamás se inventa un código.
 */
export function buildPriceLabelLayout(data: VacuumLabelData, dims: VacuumLabelDims): VacuumLabelLayout {
  const T = VACUUM_PRICE_TYPE;
  const { widthMm, priceHeightMm } = dims;
  const left = VACUUM_LABEL_PAD.xMm;
  const right = widthMm - VACUUM_LABEL_PAD.xMm;
  const inner = right - left;
  const center = widthMm / 2;

  return composeFit("PRICE", widthMm, priceHeightMm, (scale) => {
    const stack = new Stack(VACUUM_LABEL_PAD.topMm);
    const name = toLabelText(data.productName);
    const namePt = fitNamePt(name, inner, T.name.maxPt * scale, T.name.minPt * scale, T.name.maxLines, T.name.style);
    wrapText(name, inner, namePt, T.name.style, T.name.maxLines).forEach((line, index) => {
      stack.text(`name-${String(index + 1)}`, line, namePt, T.name.style, "middle", center);
      stack.advance(emHeight(namePt, T.name.lineHeightEm));
    });
    stack.advance(VACUUM_GAPS_MM.line);

    const price = fitOneLine(moneyText(data.totalCents), inner, T.price.maxPt * scale, T.price.minPt * scale, T.price.style);
    stack.text("price", price.text, price.pt, T.price.style, "middle", center);
    stack.advance(capHeightEm(T.price.style) * price.pt * MM_PER_PT + VACUUM_GAPS_MM.section);

    // Peso neto (izquierda) y precio por kg (derecha) en UNA fila; si no entran lado a lado ni achicados hasta el 70 %, se apilan como antes.
    const weightLabel = weightText(data.weightGrams);
    const perKgLabel = `${moneyText(data.pricePerKgCents)}/kg`;
    const sharedRow = sideBySide(
      stack,
      { id: "weight", text: weightLabel, pt: T.weight.pt * scale, style: T.weight.style },
      { id: "per-kg", text: perKgLabel, pt: T.perKg.pt * scale, style: T.perKg.style },
      left, right, T.dates.minGapMm, 0.7
    );
    if (!sharedRow) {
      stack.text("weight", weightLabel, T.weight.pt * scale, T.weight.style, "middle", center);
      stack.advance(emHeight(T.weight.pt * scale, 1.15));
      const perKg = fitOneLine(perKgLabel, inner, T.perKg.pt * scale, T.perKg.pt * scale * 0.6, T.perKg.style);
      stack.text("per-kg", perKg.text, perKg.pt, T.perKg.style, "middle", center);
      stack.advance(emHeight(perKg.pt, 1.15));
    }
    stack.advance(VACUUM_GAPS_MM.section);

    // Fechas del paquete: «ELAB» a la izquierda y «VENCE» a la derecha, mismo tamaño. Tipografía propia (no baja con `scale`): son datos obligatorios.
    const elab = `ELAB: ${dateOrBlank(data.packedOn)}`;
    const vence = `VENCE: ${dateOrBlank(data.expiresOn)}`;
    const dateRow = sideBySide(
      stack,
      { id: "elab", text: elab, pt: T.dates.maxPt, style: T.dates.style },
      { id: "vence", text: vence, pt: T.dates.maxPt, style: T.dates.style },
      left, right, T.dates.minGapMm, T.dates.minPt / T.dates.maxPt
    );
    if (!dateRow) {
      // Rótulos muy angostos: dos filas centradas al tamaño mínimo legible, nunca recortadas.
      stack.text("elab", elab, T.dates.minPt, T.dates.style, "middle", center);
      stack.advance(emHeight(T.dates.minPt, 1.15));
      stack.text("vence", vence, T.dates.minPt, T.dates.style, "middle", center);
      stack.advance(emHeight(T.dates.minPt, 1.15));
    }
    stack.advance(VACUUM_GAPS_MM.section);

    // El EAN-13 aprovecha el alto que sobra (hasta `maxHeightMm`): más alto = lectura más tolerante a un barrido inclinado. Nunca baja del 90 % del diseño.
    const baseBarHeight = T.barcode.heightMm * Math.max(scale, T.barcode.minHeightScale);
    const belowBars = T.barcode.digitsGapMm +capHeightEm("regular") * T.digits.pt * scale * MM_PER_PT + 0.55;
    const room = priceHeightMm - VACUUM_LABEL_PAD.bottomMm - stack.y - belowBars;
    const barHeight = Math.min(T.barcode.maxHeightMm, Math.max(baseBarHeight, room));
    if (data.ean13 !== null && isValidEan13(data.ean13)) {
      drawBarcode(stack, data.ean13, widthMm, left, right, barHeight, T.digits.pt * scale);
    } else {
      // Sin esquema EAN: se muestra el faltante, nunca un código inventado.
      stack.rects.push({ id: "ean-missing-box", x: left, y: stack.y, width: inner, height: barHeight, fill: false, strokeMm: 0.2 });
      const notice = fitOneLine("EAN-13 SIN CONFIGURAR", inner - 2, T.notice.pt * scale, T.notice.pt * scale * 0.6, T.notice.style);
      stack.text("ean-missing", notice.text, notice.pt, T.notice.style, "middle", center);
      stack.advance(barHeight);
    }
    return { stack, bottom: stack.y };
  });
}

interface RowPart {
  id: string;
  text: string;
  pt: number;
  style: LabelFontStyle;
}

/**
 * Dos textos en la MISMA línea base: `a` pegado al margen izquierdo y `b` al derecho. Prueba tamaños decrecientes (cada paso baja un 2 % ambos, hasta
 * `minScale` del tamaño pedido) y dibuja en el primero donde entran con al menos `gapMm` de separación. Si no entran, no dibuja nada y devuelve false.
 */
function sideBySide(stack: Stack, a: RowPart, b: RowPart, left: number, right: number, gapMm: number, minScale: number): boolean {
  for (let s = 1; s >= minScale - 1e-9; s -= 0.02) {
    const aPt = a.pt * s;
    const bPt = b.pt * s;
    if (mmWidth(a.text, aPt, a.style) + mmWidth(b.text, bPt, b.style) + gapMm > right - left) continue;
    const baseline = Math.round((stack.y + Math.max(capHeightEm(a.style) * aPt, capHeightEm(b.style) * bPt) * MM_PER_PT) * 1000) / 1000;
    stack.texts.push({ id: a.id, text: a.text, x: left, y: baseline, sizePt: Math.round(aPt * 100) / 100, style: a.style, anchor: "start" });
    stack.texts.push({ id: b.id, text: b.text, x: right, y: baseline, sizePt: Math.round(bPt * 100) / 100, style: b.style, anchor: "end" });
    stack.advance(emHeight(Math.max(aPt, bPt), 1.15));
    return true;
  }
  return false;
}

/**
 * Barras + dígitos. El primer dígito va a la izquierda de las barras (fuera de la guarda), los 6 siguientes bajo la mitad izquierda y los 6
 * últimos bajo la mitad derecha, como en cualquier EAN-13 impreso. El módulo ocupa un número ENTERO de puntos de la térmica (203 dpi), el mayor que
 * entra en el ancho útil (máx. 4 puntos = 0,5 mm): así todas las barras salen del mismo grosor. Sólo si ni 1 punto entra se usa el ancho útil.
 */
function drawBarcode(stack: Stack, ean13: string, widthMm: number, left: number, right: number, barHeight: number, digitsPt: number): void {
  const T = VACUUM_PRICE_TYPE.barcode;
  const digitsHeight = capHeightEm("regular") * digitsPt * MM_PER_PT;
  const firstDigitSpace = mmWidth("0", digitsPt, "regular") + 0.8;
  const usable = right - left - firstDigitSpace - T.quietZoneMm;
  const dots = Math.min(4, Math.floor(usable / EAN13_MODULE_COUNT / THERMAL_DOT_MM));
  const moduleMm = dots >= 1 ? dots * THERMAL_DOT_MM : usable / EAN13_MODULE_COUNT;
  const barsWidth = moduleMm * EAN13_MODULE_COUNT;
  const startX = widthMm / 2 - barsWidth / 2 + firstDigitSpace / 2;
  const top = stack.y;
  const runs = modulesToRuns(ean13Modules(ean13));
  const guardExtra = Math.min(1.2, barHeight * 0.12);
  for (const run of runs) {
    // Las guardas (inicio, centro, fin) bajan un poco más que el resto, como en el estándar.
    const isGuard = run.start < 3 || (run.start >= 45 && run.start < 50) || run.start >= 92;
    stack.bars.push({
      x: Math.round((startX + run.start * moduleMm) * 1000) / 1000, y: top, width: Math.round(run.width * moduleMm * 1000) / 1000,
      height: barHeight + (isGuard ? guardExtra : 0)
    });
  }
  const digitsY = top + barHeight + guardExtra * 0.2 + T.digitsGapMm;
  const baseline = digitsY + digitsHeight;
  const y = Math.round(baseline * 1000) / 1000;
  const digits = Array.from(ean13);
  const pt = Math.round(digitsPt * 100) / 100;
  stack.texts.push({ id: "ean-digit-first", text: digits[0] ?? "", x: Math.round((startX - 0.8) * 1000) / 1000, y, sizePt: pt, style: "regular", anchor: "end" });
  stack.texts.push({ id: "ean-digits-left", text: digits.slice(1, 7).join(""), x: Math.round((startX + (3 + 21) * moduleMm) * 1000) / 1000, y, sizePt: pt, style: "regular", anchor: "middle" });
  stack.texts.push({ id: "ean-digits-right", text: digits.slice(7).join(""), x: Math.round((startX + (50 + 21) * moduleMm) * 1000) / 1000, y, sizePt: pt, style: "regular", anchor: "middle" });
  stack.y = baseline + 0.3;
}

/**
 * Code 128 centrado + el código legible debajo («ID LOGÍSTICO 7K3M-9QX4-S»). Las barras NO se escalan con la tipografía: un módulo más fino que 0,25 mm
 * dejaría de ser nítido en una térmica de 203 dpi.
 */
function drawLogisticCode(stack: Stack, code: string, widthMm: number, moduleMm: number, barHeightMm: number, textPt: number, gapMm: number): void {
  const modules = code128Modules(code);
  const barsWidth = modules.length * moduleMm;
  const startX = widthMm / 2 - barsWidth / 2;
  const top = stack.y;
  for (const run of modulesToRuns(modules)) {
    stack.bars.push({ x: Math.round((startX + run.start * moduleMm) * 1000) / 1000, y: top, width: Math.round(run.width * moduleMm * 1000) / 1000, height: barHeightMm });
  }
  stack.advance(barHeightMm + gapMm * 0.6);
  stack.text("logistic-code", `ID LOGÍSTICO ${formatLogisticCode(code)}`, textPt, "bold", "middle", widthMm / 2);
  stack.advance(emHeight(textPt, 1.1) + gapMm);
}

// ---------------------------------------------------------------------------------------------------------------------
// Etiqueta C — LOGÍSTICA (adicional)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Etiqueta de trazabilidad interna: el código logístico grande, con el corte, lote, peso y fechas para identificar el paquete en una caja. No es el código
 * de venta. Usa el alto de la etiqueta informativa (es el mismo papel). Si el paquete todavía no tiene código se dibuja un aviso, nunca uno inventado.
 */
export function buildLogisticLabelLayout(data: VacuumLabelData, dims: VacuumLabelDims): VacuumLabelLayout {
  const T = VACUUM_LOGISTIC_TYPE;
  const { widthMm, infoHeightMm } = dims;
  const left = VACUUM_LABEL_PAD.xMm;
  const right = widthMm - VACUUM_LABEL_PAD.xMm;
  const inner = right - left;
  const center = widthMm / 2;
  const code = data.logisticCode !== null && isValidLogisticCode(data.logisticCode) ? data.logisticCode : null;

  return composeFit("LOGISTIC", widthMm, infoHeightMm, (scale) => {
    const stack = new Stack(VACUUM_LABEL_PAD.topMm);
    stack.text("title", "TRAZABILIDAD INTERNA", T.title.pt * scale, T.title.style, "middle", center);
    stack.advance(emHeight(T.title.pt * scale, 1.2) + VACUUM_GAPS_MM.line);
    const name = toLabelText(data.productName);
    const namePt = fitNamePt(name, inner, T.name.maxPt * scale, T.name.minPt * scale, T.name.maxLines, T.name.style);
    wrapText(name, inner, namePt, T.name.style, T.name.maxLines).forEach((line, index) => {
      stack.text(`name-${String(index + 1)}`, line, namePt, T.name.style, "middle", center);
      stack.advance(emHeight(namePt, T.name.lineHeightEm));
    });
    stack.advance(VACUUM_GAPS_MM.section);

    if (code !== null) {
      const moduleMm = Math.min(T.barcode.moduleMm, inner / code128ModuleCount(code.length));
      const modules = code128Modules(code);
      const startX = center - (modules.length * moduleMm) / 2;
      for (const run of modulesToRuns(modules)) {
        stack.bars.push({ x: Math.round((startX + run.start * moduleMm) * 1000) / 1000, y: stack.y, width: Math.round(run.width * moduleMm * 1000) / 1000, height: T.barcode.barHeightMm });
      }
      stack.advance(T.barcode.barHeightMm + VACUUM_GAPS_MM.line);
      const label = fitOneLine(formatLogisticCode(code), inner, T.code.maxPt * scale, T.code.minPt * scale, T.code.style);
      stack.text("logistic-code", label.text, label.pt, T.code.style, "middle", center);
      stack.advance(emHeight(label.pt, 1.15) + VACUUM_GAPS_MM.section);
    } else {
      stack.rects.push({ id: "logistic-missing-box", x: left, y: stack.y, width: inner, height: T.barcode.barHeightMm, fill: false, strokeMm: 0.2 });
      const notice = fitOneLine("SIN CÓDIGO LOGÍSTICO", inner - 2, 8 * scale, 5, "bold");
      stack.text("logistic-missing", notice.text, notice.pt, "bold", "middle", center);
      stack.advance(T.barcode.barHeightMm + VACUUM_GAPS_MM.section);
    }

    stack.rule("rule-detail", left, right, 0.15);
    stack.advance(VACUUM_GAPS_MM.section);
    const lines = [
      `Lote ${data.lot ?? "—"} · ${weightText(data.weightGrams)}`,
      `Elab. ${formatIsoDate(data.packedOn)} · Venc. ${formatIsoDate(data.expiresOn)}`
    ];
    lines.forEach((line, index) => {
      const fit = fitOneLine(toLabelText(line), inner, T.detail.pt * scale, T.detail.pt * scale * 0.6, T.detail.style);
      stack.text(`detail-${String(index + 1)}`, fit.text, fit.pt, T.detail.style, "middle", center);
      stack.advance(emHeight(fit.pt, T.detail.lineHeightEm));
    });
    stack.advance(VACUUM_GAPS_MM.section);
    const footer = fitOneLine("Uso interno · no es el código de venta", inner, T.footer.pt * scale, T.footer.pt * scale * 0.7, T.footer.style);
    stack.text("footer", footer.text, footer.pt, T.footer.style, "middle", center);
    stack.advance(emHeight(footer.pt, 1.2));
    return { stack, bottom: stack.y };
  });
}

export function buildVacuumLabelLayout(kind: VacuumLabelKind, data: VacuumLabelData, dims: VacuumLabelDims): VacuumLabelLayout {
  if (kind === "INFO") return buildInfoLabelLayout(data, dims);
  if (kind === "LOGISTIC") return buildLogisticLabelLayout(data, dims);
  return buildPriceLabelLayout(data, dims);
}
