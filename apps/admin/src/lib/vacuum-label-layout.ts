import { capHeightEm, textWidthPt, toLabelText, type LabelFontStyle } from "./label-font";
import type { LabelRect, LabelRule, LabelText, LabelTextAnchor } from "./label-layout";
import { EAN13_MODULE_COUNT, ean13Modules, isValidEan13, modulesToRuns } from "./vacuum-ean";
import {
  MM_PER_PT, VACUUM_FIT_STEP, VACUUM_GAPS_MM, VACUUM_INFO_TYPE, VACUUM_LABEL_PAD, VACUUM_MIN_FIT, VACUUM_PRICE_TYPE, type VacuumLabelDims
} from "./vacuum-label-spec";
import { formatIsoDate, moneyText, weightText, type VacuumPackage } from "./vacuum";

/**
 * Geometría de las DOS etiquetas del envasado. Igual que la etiqueta de góndola (`label-layout.ts`), cada etiqueta es una lista de primitivas
 * en milímetros (textos con línea base, rectángulos, líneas y barras del código): el preview las dibuja como SVG y el PDF con pdf-lib, así que
 * ambos coinciden. Las medidas salen de `VacuumLabelDims` (configurable); nada acá asume 58 × 40.
 *
 * Los datos de entrada son el SNAPSHOT del paquete (o un borrador en pantalla): nunca precios, textos ni esquemas actuales.
 */

export type VacuumLabelKind = "INFO" | "PRICE";

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
  conservationText: string | null;
  businessName: string | null;
  address: string | null;
  establishmentInfo: string | null;
  extraText: string | null;
}

export function packageToLabelData(pkg: VacuumPackage): VacuumLabelData {
  return {
    productName: pkg.productName, weightGrams: pkg.weightGrams, pricePerKgCents: pkg.pricePerKgCents, totalCents: pkg.totalCents,
    packedOn: pkg.packedOn, expiresOn: pkg.expiresOn, lot: pkg.lot, ean13: pkg.ean13, conservationText: pkg.conservationText,
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
  for (let scale = 1 - VACUUM_FIT_STEP; overflow && scale >= VACUUM_MIN_FIT - 1e-9; scale -= VACUUM_FIT_STEP) {
    result = build(scale);
    overflow = result.bottom > limit;
  }
  const { stack } = result;
  return { kind, widthMm, heightMm, texts: stack.texts, rules: stack.rules, rects: stack.rects, bars: stack.bars, overflow };
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
 * Jerarquía: corte, PRECIO FINAL (lo más grande), peso neto, precio por kg, código de barras y sus 13 dígitos. Sin información sanitaria.
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

    stack.text("weight", weightText(data.weightGrams), T.weight.pt * scale, T.weight.style, "middle", center);
    stack.advance(emHeight(T.weight.pt * scale, 1.15));
    const perKg = fitOneLine(`${moneyText(data.pricePerKgCents)}/kg`, inner, T.perKg.pt * scale, T.perKg.pt * scale * 0.6, T.perKg.style);
    stack.text("per-kg", perKg.text, perKg.pt, T.perKg.style, "middle", center);
    stack.advance(emHeight(perKg.pt, 1.15) + VACUUM_GAPS_MM.section);

    const barHeight = T.barcode.heightMm * scale;
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

/**
 * Barras + dígitos. El primer dígito va a la izquierda de las barras (fuera de la guarda), los 6 siguientes bajo la mitad izquierda y los 6
 * últimos bajo la mitad derecha, como en cualquier EAN-13 impreso. El módulo se agranda hasta ocupar el ancho útil (máx. 0,5 mm).
 */
function drawBarcode(stack: Stack, ean13: string, widthMm: number, left: number, right: number, barHeight: number, digitsPt: number): void {
  const T = VACUUM_PRICE_TYPE.barcode;
  const digitsHeight = capHeightEm("regular") * digitsPt * MM_PER_PT;
  const firstDigitSpace = mmWidth("0", digitsPt, "regular") + 0.8;
  const usable = right - left - firstDigitSpace - T.quietZoneMm;
  const moduleMm = Math.min(0.5, usable / EAN13_MODULE_COUNT);
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

export function buildVacuumLabelLayout(kind: VacuumLabelKind, data: VacuumLabelData, dims: VacuumLabelDims): VacuumLabelLayout {
  return kind === "INFO" ? buildInfoLabelLayout(data, dims) : buildPriceLabelLayout(data, dims);
}
