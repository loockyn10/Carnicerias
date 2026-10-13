import { ANTON_WIDTHS } from "./artwork-display-metrics";
import { fitText } from "./artwork-text";
import type { OfferSign, OfferSignFormat } from "./offer-sign";

/**
 * Geometría de los carteles de ofertas impresos A4 apaisado (D-087). ÚNICA fuente de medidas: el preview en pantalla (SVG en milímetros) y el
 * PDF dibujan exactamente estas primitivas. Todo es negro sobre blanco puro; textos en Anton (la fuente de títulos de la cartelería).
 * Medidas en milímetros y tipografía en puntos; los textos se anclan por la LÍNEA BASE.
 */

export const OFFER_PAGE_MM = { width: 297, height: 210 } as const;
/** Margen seguro: una impresora de oficina no imprime los últimos ~4-5 mm; con 8 mm ningún texto ni borde queda en el límite. */
export const OFFER_MARGIN_MM = 8;
/** Separación entre los carteles de la tira (por el medio se corta). */
export const OFFER_GUTTER_MM = 5;
export const MM_PER_PT = 25.4 / 72;
/** Altura de las mayúsculas de Anton en «em» (1760 / 2048; la prueba la verifica contra la fuente). */
export const ANTON_CAP_EM = 1760 / 2048;

export const OFFER_PANEL_MM: Record<OfferSignFormat, { width: number; height: number }> = {
  STRIP: { width: (OFFER_PAGE_MM.width - 2 * OFFER_MARGIN_MM - 2 * OFFER_GUTTER_MM) / 3, height: OFFER_PAGE_MM.height - 2 * OFFER_MARGIN_MM },
  POSTER: { width: OFFER_PAGE_MM.width - 2 * OFFER_MARGIN_MM, height: OFFER_PAGE_MM.height - 2 * OFFER_MARGIN_MM }
};

export interface SignText {
  text: string;
  /** x según `anchor`; y = línea base (mm desde el borde superior del cartel). */
  x: number;
  y: number;
  sizePt: number;
  anchor: "start" | "middle" | "end";
  /** true = blanco (sobre un rectángulo negro). */
  inverse: boolean;
}

export interface SignRect { x: number; y: number; width: number; height: number; fill: boolean; strokeMm: number }
export interface SignRule { x1: number; y1: number; x2: number; y2: number; widthMm: number }

export interface SignLayout {
  width: number;
  height: number;
  texts: SignText[];
  rects: SignRect[];
  /** Caja cuadrada del logo (el logo se acomoda adentro sin deformarse); null = sin espacio de logo. */
  logo: { cx: number; cy: number; size: number } | null;
}

export interface SignBrand {
  /** Hay un logo monocromo para dibujar. Sin logo se imprime el nombre del negocio. */
  hasLogo: boolean;
  name: string;
}

/** Ancho en pt de `text` a `sizePt` con los avances reales de Anton (sin margen de seguridad: es lo que dibuja el PDF). */
export function antonWidthPt(text: string, sizePt: number): number {
  let thousandths = 0;
  for (const char of text) thousandths += ANTON_WIDTHS[char.codePointAt(0) ?? 0] ?? 500;
  return (thousandths / 1000) * sizePt;
}

interface Plan {
  padX: number;
  logo: { size: number; cx: number | "center"; cy: number };
  offer: { maxPt: number; baseline: number };
  name: { top: number; bottom: number; maxPt: number; minPt: number; maxLines: number };
  badge: { top: number; height: number; maxPt: number; minPt: number; fullWidth: boolean; padMm: number };
  price: { baseline: number; maxPt: number; maxCapMm: number };
  unit: { baseline: number; maxPt: number };
  normal: { baseline: number; maxPt: number; minPt: number };
  border: number;
}

const PLANS: Record<OfferSignFormat, Plan> = {
  STRIP: {
    padX: 6, logo: { size: 25, cx: "center", cy: 18.5 }, offer: { maxPt: 52, baseline: 50 },
    name: { top: 56, bottom: 104, maxPt: 50, minPt: 22, maxLines: 3 },
    badge: { top: 108, height: 20, maxPt: 34, minPt: 14, fullWidth: true, padMm: 4 },
    price: { baseline: 164, maxPt: 130, maxCapMm: 30 },
    unit: { baseline: 177, maxPt: 24 },
    normal: { baseline: 189, maxPt: 13, minPt: 7 },
    border: 0.8
  },
  POSTER: {
    padX: 14, logo: { size: 30, cx: 29, cy: 25 }, offer: { maxPt: 56, baseline: 33 },
    name: { top: 42, bottom: 78, maxPt: 84, minPt: 30, maxLines: 2 },
    badge: { top: 82, height: 18, maxPt: 42, minPt: 20, fullWidth: false, padMm: 12 },
    price: { baseline: 158, maxPt: 330, maxCapMm: 50 },
    unit: { baseline: 173, maxPt: 34 },
    normal: { baseline: 188, maxPt: 24, minPt: 9 },
    border: 1
  }
};

const LINE_HEIGHT = 1.1;

function oneLine(text: string, maxWidthMm: number, maxPt: number, minPt: number): { text: string; sizePt: number } {
  const fitted = fitText({ text, maxWidth: maxWidthMm / MM_PER_PT, maxLines: 1, maxSize: maxPt, minSize: minPt, weight: 400 });
  return { text: fitted.lines[0] ?? text, sizePt: fitted.size };
}

/** El precio: «$» y centavos chicos y levantados a la altura de las mayúsculas, la parte entera enorme; todo centrado. */
function priceTexts(price: OfferSign["price"], plan: Plan, width: number): SignText[] {
  const whole = price.whole;
  const cents = price.cents ? `,${price.cents}` : "";
  const small = 0.5;
  const gapEm = 0.04;
  const emWidth = (text: string) => antonWidthPt(text, 1);
  const perPt = emWidth("$") * small + gapEm + emWidth(whole) + emWidth(cents) * small;
  const maxWidthPt = (width - 2 * plan.padX) / MM_PER_PT;
  const sizePt = Math.min(plan.price.maxPt, maxWidthPt / perPt, plan.price.maxCapMm / (ANTON_CAP_EM * MM_PER_PT));
  const smallPt = sizePt * small;
  const totalMm = perPt * sizePt * MM_PER_PT;
  const left = width / 2 - totalMm / 2;
  const topMm = plan.price.baseline - ANTON_CAP_EM * sizePt * MM_PER_PT;
  const smallBaseline = topMm + ANTON_CAP_EM * smallPt * MM_PER_PT;
  const dollarMm = emWidth("$") * smallPt * MM_PER_PT;
  const wholeX = left + dollarMm + gapEm * sizePt * MM_PER_PT;
  const wholeMm = emWidth(whole) * sizePt * MM_PER_PT;
  const texts: SignText[] = [
    { text: "$", x: left, y: smallBaseline, sizePt: smallPt, anchor: "start", inverse: false },
    { text: whole, x: wholeX, y: plan.price.baseline, sizePt, anchor: "start", inverse: false }
  ];
  if (cents) texts.push({ text: cents, x: wholeX + wholeMm, y: smallBaseline, sizePt: smallPt, anchor: "start", inverse: false });
  return texts;
}

/** Un cartel: OFERTA → producto → condición → precio → unidad → precio normal → logo. Siempre dentro del panel. */
export function buildSignLayout(sign: OfferSign, format: OfferSignFormat, brand: SignBrand): SignLayout {
  const plan = PLANS[format];
  const { width, height } = OFFER_PANEL_MM[format];
  const inner = width - 2 * plan.padX;
  const texts: SignText[] = [];
  const rects: SignRect[] = [{ x: plan.border / 2, y: plan.border / 2, width: width - plan.border, height: height - plan.border, fill: false, strokeMm: plan.border }];
  const center = width / 2;

  // 1. OFERTA
  const offer = oneLine("OFERTA", inner, plan.offer.maxPt, 20);
  texts.push({ text: "OFERTA", x: center, y: plan.offer.baseline, sizePt: offer.sizePt, anchor: "middle", inverse: false });

  // 2. Producto: hasta 2-3 renglones, el tamaño más grande que entra (nunca parte palabras ni queda microscópico).
  const zonePt = (plan.name.bottom - plan.name.top) / MM_PER_PT;
  const name = fitText({ text: sign.name, maxWidth: inner / MM_PER_PT, maxLines: plan.name.maxLines, maxSize: plan.name.maxPt, minSize: plan.name.minPt, weight: 400, maxHeight: zonePt, lineHeight: LINE_HEIGHT });
  const blockMm = name.lines.length * name.size * LINE_HEIGHT * MM_PER_PT;
  const firstTop = plan.name.top + ((plan.name.bottom - plan.name.top) - blockMm) / 2;
  name.lines.forEach((line, index) => {
    const baseline = firstTop + (index * LINE_HEIGHT + (LINE_HEIGHT + ANTON_CAP_EM) / 2) * name.size * MM_PER_PT;
    texts.push({ text: line, x: center, y: baseline, sizePt: name.size, anchor: "middle", inverse: false });
  });

  // 3. Condición: texto blanco sobre negro (se lee desde lejos y gasta poca tinta).
  const badgeInner = inner - 2 * plan.badge.padMm;
  const condition = oneLine(sign.condition, badgeInner, plan.badge.maxPt, plan.badge.minPt);
  const conditionMm = antonWidthPt(condition.text, condition.sizePt) * MM_PER_PT;
  const badgeWidth = plan.badge.fullWidth ? inner : Math.min(inner, Math.max(conditionMm + 2 * plan.badge.padMm, inner * 0.3));
  rects.push({ x: center - badgeWidth / 2, y: plan.badge.top, width: badgeWidth, height: plan.badge.height, fill: true, strokeMm: 0 });
  texts.push({
    text: condition.text, x: center, y: plan.badge.top + (plan.badge.height + ANTON_CAP_EM * condition.sizePt * MM_PER_PT) / 2,
    sizePt: condition.sizePt, anchor: "middle", inverse: true
  });

  // 4. Precio (el elemento dominante).
  texts.push(...priceTexts(sign.price, plan, width));

  // 5. Unidad (y precio por unidad del pack, si corresponde).
  const unitText = sign.secondary ? `${sign.unitLabel} · ${sign.secondary}` : sign.unitLabel;
  const unit = oneLine(unitText, inner, plan.unit.maxPt, 12);
  texts.push({ text: unit.text, x: center, y: plan.unit.baseline, sizePt: unit.sizePt, anchor: "middle", inverse: false });

  // 6. Precio normal: sólo si hay una comparación válida.
  if (sign.normalPrice) {
    const normal = oneLine(sign.normalPrice, inner, plan.normal.maxPt, plan.normal.minPt);
    texts.push({ text: normal.text, x: center, y: plan.normal.baseline, sizePt: normal.sizePt, anchor: "middle", inverse: false });
  }

  // 7. Logo (o, sin logo, el nombre del negocio en el mismo lugar).
  const logoX = plan.logo.cx === "center" ? center : plan.logo.cx;
  if (brand.hasLogo) return { width, height, texts, rects, logo: { cx: logoX, cy: plan.logo.cy, size: plan.logo.size } };
  const fallback = oneLine(brand.name, plan.logo.cx === "center" ? inner : plan.logo.size * 2.4, 16, 8);
  texts.push({ text: fallback.text, x: logoX, y: plan.logo.cy + (ANTON_CAP_EM * fallback.sizePt * MM_PER_PT) / 2, sizePt: fallback.sizePt, anchor: "middle", inverse: false });
  return { width, height, texts, rects, logo: null };
}

export interface SignPagePanel { x: number; y: number; layout: SignLayout }
export interface SignPage {
  panels: SignPagePanel[];
  /** Marcas de corte (líneas negras finas en los márgenes superior e inferior, centradas en cada separación). */
  rules: SignRule[];
}

/** Una hoja A4 apaisada: 3 carteles lado a lado (tira) o 1 cartel grande, con las marcas de corte. */
export function buildSignPage(signs: readonly OfferSign[], format: OfferSignFormat, brand: SignBrand): SignPage {
  const { width } = OFFER_PANEL_MM[format];
  const panels = signs.map((sign, index) => ({
    x: OFFER_MARGIN_MM + index * (width + OFFER_GUTTER_MM), y: OFFER_MARGIN_MM, layout: buildSignLayout(sign, format, brand)
  }));
  const rules: SignRule[] = [];
  if (format === "STRIP") {
    for (let cut = 1; cut < 3; cut += 1) {
      const x = OFFER_MARGIN_MM + cut * width + (cut - 0.5) * OFFER_GUTTER_MM;
      rules.push({ x1: x, y1: 2.5, x2: x, y2: 6, widthMm: 0.2 }, { x1: x, y1: OFFER_PAGE_MM.height - 6, x2: x, y2: OFFER_PAGE_MM.height - 2.5, widthMm: 0.2 });
    }
  }
  return { panels, rules };
}
