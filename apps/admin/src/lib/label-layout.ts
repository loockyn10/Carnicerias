import { capHeightEm, textWidthPt, type LabelFontStyle } from "./label-font";
import {
  LABEL_FIT_STEP, LABEL_GAPS_MM, LABEL_HEIGHT_MM, LABEL_MIN_FIT, LABEL_PAD_BOTTOM_MM, LABEL_PAD_TOP_MM, LABEL_PAD_X_MM, LABEL_TYPE,
  LABEL_WIDTH_MM, MM_PER_PT, PT_PER_MM
} from "./label-spec";
import type { ProductLabelData, ProductLabelVariant } from "./product-label";

/**
 * Geometría de UNA etiqueta de 70 × 50 mm: a partir del contenido (`ProductLabelData`) y de las medidas de `label-spec.ts` decide dónde va
 * cada texto (coordenadas en mm, línea base) y a qué tamaño (pt). El resultado es una lista de primitivas simples:
 *   - el preview las dibuja como SVG (viewBox en mm);
 *   - el PDF las dibuja con pdf-lib, mm → pt.
 * Como las dos salidas parten del MISMO layout (y miden con las mismas métricas de Helvetica), el PDF y la vista previa coinciden.
 */

export type LabelTextAnchor = "start" | "middle" | "end";

export interface LabelText {
  /** Rol del texto (`headline`, `name-1`, `condition`, `price`…): para pruebas y atributos de los dibujos. */
  id: string;
  text: string;
  /** Posición horizontal en mm desde el borde izquierdo de la etiqueta (según `anchor`). */
  x: number;
  /** LÍNEA BASE en mm desde el borde superior de la etiqueta. */
  y: number;
  sizePt: number;
  style: LabelFontStyle;
  anchor: LabelTextAnchor;
}

export interface LabelRule {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  widthMm: number;
}

export interface LabelLayout {
  widthMm: number;
  heightMm: number;
  variant: ProductLabelVariant;
  texts: LabelText[];
  rules: LabelRule[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const ptToMm = (pt: number) => pt * MM_PER_PT;
const capMm = (pt: number, style: LabelFontStyle) => ptToMm(pt) * capHeightEm(style);

const INNER_WIDTH_MM = LABEL_WIDTH_MM - 2 * LABEL_PAD_X_MM;
const INNER_WIDTH_PT = INNER_WIDTH_MM * PT_PER_MM;
const CENTER_X_MM = LABEL_WIDTH_MM / 2;
const AVAILABLE_HEIGHT_MM = LABEL_HEIGHT_MM - LABEL_PAD_TOP_MM - LABEL_PAD_BOTTOM_MM;
const ELLIPSIS = "...";

interface Output {
  texts: LabelText[];
  rules: LabelRule[];
}

/** Un bloque vertical de la etiqueta: su alto (de línea base a línea base de sus textos) y cómo se dibuja a partir de su borde superior. */
interface Block {
  heightMm: number;
  gapBeforeMm: number;
  draw: (topMm: number, out: Output) => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Nombre: hasta 2 líneas, el tamaño más grande que entre
// ---------------------------------------------------------------------------------------------------------------------

function wrapWords(text: string, sizePt: number, style: LabelFontStyle, maxLines: number): string[] | null {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (textWidthPt(word, sizePt, style) > INNER_WIDTH_PT) return null;
    const candidate = current ? `${current} ${word}` : word;
    if (textWidthPt(candidate, sizePt, style) <= INNER_WIDTH_PT) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : null;
}

/** Último recurso (nombre kilométrico incluso al tamaño mínimo): llena `maxLines` líneas y corta la última con «...». */
function clampLines(text: string, sizePt: number, style: LabelFontStyle, maxLines: number): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  for (let index = 0; index < maxLines && rest; index += 1) {
    let take = rest.length;
    while (take > 0 && textWidthPt(rest.slice(0, take), sizePt, style) > INNER_WIDTH_PT) take -= 1;
    if (take === 0) take = 1;
    if (take < rest.length) {
      const lastSpace = rest.lastIndexOf(" ", take);
      if (lastSpace > 0) take = lastSpace;
    }
    if (index === maxLines - 1 && take < rest.length) {
      let cut = take;
      while (cut > 0 && textWidthPt(`${rest.slice(0, cut).trimEnd()}${ELLIPSIS}`, sizePt, style) > INNER_WIDTH_PT) cut -= 1;
      lines.push(`${rest.slice(0, cut).trimEnd()}${ELLIPSIS}`);
      return lines;
    }
    lines.push(rest.slice(0, take).trim());
    rest = rest.slice(take).trim();
  }
  return lines;
}

function nameBlock(name: string, fit: number): Block {
  const spec = LABEL_TYPE.name;
  const style = spec.style;
  let sizePt = spec.maxPt * fit;
  let lines: string[] | null = null;
  while (sizePt >= spec.minPt) {
    lines = wrapWords(name, sizePt, style, spec.maxLines);
    if (lines) break;
    sizePt = round2(sizePt - spec.stepPt);
  }
  if (!lines) {
    sizePt = spec.minPt;
    lines = clampLines(name, sizePt, style, spec.maxLines);
  }
  const resolved = lines;
  const size = sizePt;
  const pitchMm = ptToMm(size) * spec.lineHeightEm;
  return {
    heightMm: capMm(size, style) + Math.max(0, resolved.length - 1) * pitchMm,
    gapBeforeMm: 0,
    draw: (top, out) => {
      resolved.forEach((line, index) => {
        out.texts.push({ id: `name-${String(index + 1)}`, text: line, x: CENTER_X_MM, y: round2(top + capMm(size, style) + index * pitchMm), sizePt: round2(size), style, anchor: "middle" });
      });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Otros bloques
// ---------------------------------------------------------------------------------------------------------------------

function textBlock(id: string, text: string, sizePt: number, style: LabelFontStyle, options: { underline?: boolean } = {}): Block {
  return {
    heightMm: capMm(sizePt, style),
    gapBeforeMm: 0,
    draw: (top, out) => {
      const baseline = top + capMm(sizePt, style);
      out.texts.push({ id, text, x: CENTER_X_MM, y: round2(baseline), sizePt: round2(sizePt), style, anchor: "middle" });
      if (options.underline) {
        const widthMm = textWidthPt(text, sizePt, style) * MM_PER_PT;
        const y = baseline + ptToMm(sizePt) * LABEL_TYPE.underline.offsetEm;
        out.rules.push({
          id: `${id}-underline`, x1: round2(CENTER_X_MM - widthMm / 2), x2: round2(CENTER_X_MM + widthMm / 2), y1: round2(y), y2: round2(y),
          widthMm: round2(ptToMm(sizePt) * LABEL_TYPE.underline.thicknessEm)
        });
      }
    }
  };
}

/** El precio (y su sufijo «/kg»): el elemento MÁS GRANDE; sólo se achica si no entra a lo ancho. */
function priceBlock(data: ProductLabelData, fit: number): Block {
  const spec = LABEL_TYPE.price;
  const style = spec.style;
  const suffix = data.priceSuffix;
  const suffixScale = LABEL_TYPE.priceSuffix.scale;
  const maxPt = (data.variant === "PROMO" ? spec.promoMaxPt : data.variant === "NO_PRICE" ? 22 : spec.simpleMaxPt) * fit;
  // Ancho por punto de tamaño (el sufijo mide `suffixScale` del precio).
  const widthPerPt = textWidthPt(data.price, 1, style) + (suffix ? textWidthPt(suffix, suffixScale, LABEL_TYPE.priceSuffix.style) : 0);
  const sizePt = Math.max(8, Math.floor(Math.min(maxPt, INNER_WIDTH_PT / widthPerPt) * 10) / 10);
  const suffixPt = sizePt * suffixScale;
  return {
    heightMm: capMm(sizePt, style),
    gapBeforeMm: 0,
    draw: (top, out) => {
      const baseline = round2(top + capMm(sizePt, style));
      if (!suffix) {
        out.texts.push({ id: "price", text: data.price, x: CENTER_X_MM, y: baseline, sizePt: round2(sizePt), style, anchor: "middle" });
        return;
      }
      const priceWidthMm = textWidthPt(data.price, sizePt, style) * MM_PER_PT;
      const suffixWidthMm = textWidthPt(suffix, suffixPt, LABEL_TYPE.priceSuffix.style) * MM_PER_PT;
      const startX = CENTER_X_MM - (priceWidthMm + suffixWidthMm) / 2;
      out.texts.push({ id: "price", text: data.price, x: round2(startX), y: baseline, sizePt: round2(sizePt), style, anchor: "start" });
      out.texts.push({ id: "price-suffix", text: suffix, x: round2(startX + priceWidthMm), y: baseline, sizePt: round2(suffixPt), style: LABEL_TYPE.priceSuffix.style, anchor: "start" });
    }
  };
}

/** «PRECIO NORMAL» a la izquierda y el precio normal a la derecha, sobre la misma línea base. */
function normalRowBlock(label: string, price: string, fit: number): Block {
  const labelSpec = LABEL_TYPE.normalLabel;
  const priceSpec = LABEL_TYPE.normalPrice;
  let scale = fit;
  // Si ambos no entran con aire entre medio (precio larguísimo), se achican juntos.
  while (scale > 0.4 && (textWidthPt(label, labelSpec.pt * scale, labelSpec.style) + textWidthPt(price, priceSpec.pt * scale, priceSpec.style)) * MM_PER_PT + 3 > INNER_WIDTH_MM) scale -= 0.02;
  const labelPt = labelSpec.pt * scale;
  const pricePt = priceSpec.pt * scale;
  return {
    heightMm: capMm(pricePt, priceSpec.style),
    gapBeforeMm: 0,
    draw: (top, out) => {
      const baseline = round2(top + capMm(pricePt, priceSpec.style));
      out.texts.push({ id: "normal-label", text: label, x: LABEL_PAD_X_MM, y: baseline, sizePt: round2(labelPt), style: labelSpec.style, anchor: "start" });
      out.texts.push({ id: "normal-price", text: price, x: LABEL_WIDTH_MM - LABEL_PAD_X_MM, y: baseline, sizePt: round2(pricePt), style: priceSpec.style, anchor: "end" });
    }
  };
}

function withGap(block: Block, gapBeforeMm: number): Block {
  return { ...block, gapBeforeMm };
}

function blocksFor(data: ProductLabelData, fit: number): Block[] {
  const gaps = LABEL_GAPS_MM;
  const type = LABEL_TYPE;
  const name = nameBlock(data.name, fit);
  const price = priceBlock(data, fit);
  switch (data.variant) {
    case "PROMO": {
      return [
        textBlock("headline", data.headline ?? "", type.headline.pt * fit, type.headline.style),
        withGap(name, gaps.afterHeadline),
        withGap(textBlock("condition", data.conditionLine ?? "", type.condition.pt * fit, type.condition.style, { underline: true }), gaps.afterName),
        withGap(textBlock("discount", data.discountLine ?? "", type.discount.pt * fit, type.discount.style), gaps.conditionToDiscount),
        withGap(price, gaps.afterDiscount),
        withGap(normalRowBlock(data.normalLabel ?? "", data.normalPrice ?? "", fit), gaps.afterPrice)
      ];
    }
    case "SIMPLE": {
      return [
        name,
        withGap(textBlock("top-label", data.topLabel ?? "", type.topLabel.pt * fit, type.topLabel.style), gaps.nameToTopLabel),
        withGap(price, gaps.topLabelToPrice),
        withGap(textBlock("foot-label", data.footLabel ?? "", type.footLabel.pt * fit, type.footLabel.style), gaps.priceToFootLabel)
      ];
    }
    case "WEIGHT": {
      return [
        name,
        withGap(price, gaps.nameToTopLabel),
        withGap(textBlock("foot-label", data.footLabel ?? "", type.footLabel.pt * fit, type.footLabel.style), gaps.priceToFootLabel)
      ];
    }
    case "NO_PRICE": {
      return [name, withGap(price, gaps.nameToTopLabel)];
    }
  }
}

/** Layout de una etiqueta. Determinístico: mismos datos ⇒ mismas coordenadas (preview y PDF no pueden diferir). */
export function buildLabelLayout(data: ProductLabelData): LabelLayout {
  let fit = 1;
  let blocks = blocksFor(data, fit);
  const totalOf = (list: Block[]) => list.reduce((sum, block) => sum + block.heightMm + block.gapBeforeMm, 0);
  // Nombre largo + precio grande no entran en el alto: se reduce toda la tipografía (conserva la jerarquía) hasta que entre.
  while (totalOf(blocks) > AVAILABLE_HEIGHT_MM && fit > LABEL_MIN_FIT) {
    fit = round2(fit - LABEL_FIT_STEP);
    blocks = blocksFor(data, fit);
  }

  // Si sobra alto, las separaciones crecen (hasta el doble de su mínimo) y lo que quede se reparte arriba y abajo.
  const gapCount = blocks.filter((block) => block.gapBeforeMm > 0).length;
  const extra = Math.max(0, AVAILABLE_HEIGHT_MM - totalOf(blocks));
  const growthPerGap = gapCount > 0 ? extra / gapCount : 0;
  const out: Output = { texts: [], rules: [] };
  let used = 0;
  const placed = blocks.map((block) => {
    const gap = block.gapBeforeMm > 0 ? block.gapBeforeMm + Math.min(growthPerGap, block.gapBeforeMm * LABEL_GAPS_MM.maxGrowth) : 0;
    used += gap + block.heightMm;
    return { block, gap };
  });
  let top = LABEL_PAD_TOP_MM + Math.max(0, AVAILABLE_HEIGHT_MM - used) / 2;
  for (const { block, gap } of placed) {
    top += gap;
    block.draw(top, out);
    top += block.heightMm;
  }
  return { widthMm: LABEL_WIDTH_MM, heightMm: LABEL_HEIGHT_MM, variant: data.variant, texts: out.texts, rules: out.rules };
}

/** Extremos horizontales (mm) de un texto ya ubicado: sirve para verificar márgenes y que nada se pise. */
export function textExtentMm(text: LabelText): { left: number; right: number } {
  const width = textWidthPt(text.text, text.sizePt, text.style) * MM_PER_PT;
  if (text.anchor === "start") return { left: text.x, right: text.x + width };
  if (text.anchor === "end") return { left: text.x - width, right: text.x };
  return { left: text.x - width / 2, right: text.x + width / 2 };
}
