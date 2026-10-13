import {
  appendBezierCurve, closePath, fill, lineTo, moveTo, PDFDocument, popGraphicsState, pushGraphicsState, rgb, setFillingColor, type PDFImage, type PDFPage
} from "pdf-lib";

import { antonOutlines, outlineWidthPt, type OutlineFont } from "./offer-sign-glyphs";
import { OFFER_PAGE_MM, type SignLayout, type SignPage, type SignText } from "./offer-sign-layout";

/**
 * PDF A4 apaisado REAL (297 × 210 mm, vectorial) con los carteles de ofertas (D-087). Sin Chromium ni capturas: pdf-lib dibuja las figuras, las
 * letras de Anton como contornos rellenos (ver `offer-sign-glyphs.ts`) y el logo monocromo como imagen. Un único documento con todas las hojas.
 * Todo es negro puro sobre blanco puro: sin grises, degradados ni fotos.
 */

const PT_PER_MM = 72 / 25.4;
const mm = (value: number) => value * PT_PER_MM;

export interface OfferSignPdfOptions {
  title: string;
  /** PNG monocromo del logo (blanco y negro); null = sin logo. */
  logoPng: Uint8Array | null;
  createdAt: Date;
}

function drawGlyphs(page: PDFPage, font: OutlineFont, text: SignText, originXMm: number, originYMm: number) {
  const pageHeight = mm(OFFER_PAGE_MM.height);
  const width = outlineWidthPt(font, text.text, text.sizePt);
  const shift = text.anchor === "middle" ? width / 2 : text.anchor === "end" ? width : 0;
  const scale = text.sizePt / font.unitsPerEm;
  let cursor = mm(originXMm + text.x) - shift;
  const baseline = pageHeight - mm(originYMm + text.y);
  const operators = [pushGraphicsState(), setFillingColor(text.inverse ? rgb(1, 1, 1) : rgb(0, 0, 0))];
  for (const char of text.text) {
    const glyph = font.glyphFor(char.codePointAt(0) ?? 0x20);
    if (!glyph) continue;
    const at = (x: number, y: number): [number, number] => [cursor + x * scale, baseline + y * scale];
    for (const contour of glyph.contours) {
      if (contour.length < 2) continue;
      // Punto de partida: uno «en curva»; si ninguno lo es, el punto medio entre el último y el primero.
      let points = contour;
      let startIndex = points.findIndex((point) => point[2]);
      let start: [number, number];
      if (startIndex < 0) {
        const first = points[0] ?? [0, 0, false];
        const last = points[points.length - 1] ?? [0, 0, false];
        start = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
        startIndex = 0;
      } else {
        const head = points[startIndex] ?? [0, 0, true];
        start = [head[0], head[1]];
        points = [...points.slice(startIndex + 1), ...points.slice(0, startIndex)];
        startIndex = 0;
      }
      const from0 = at(start[0], start[1]);
      operators.push(moveTo(from0[0], from0[1]));
      let current: [number, number] = start;
      let control: [number, number] | null = null;
      const quadTo = (ctrl: [number, number], end: [number, number]) => {
        const c1 = at(current[0] + (2 / 3) * (ctrl[0] - current[0]), current[1] + (2 / 3) * (ctrl[1] - current[1]));
        const c2 = at(end[0] + (2 / 3) * (ctrl[0] - end[0]), end[1] + (2 / 3) * (ctrl[1] - end[1]));
        const to = at(end[0], end[1]);
        operators.push(appendBezierCurve(c1[0], c1[1], c2[0], c2[1], to[0], to[1]));
        current = end;
      };
      for (const [x, y, onCurve] of points) {
        if (onCurve) {
          if (control) quadTo(control, [x, y]);
          else { const to = at(x, y); operators.push(lineTo(to[0], to[1])); current = [x, y]; }
          control = null;
        } else {
          if (control) quadTo(control, [(control[0] + x) / 2, (control[1] + y) / 2]);
          control = [x, y];
        }
      }
      if (control) quadTo(control, start);
      operators.push(closePath());
    }
    operators.push(fill());
    cursor += glyph.advance * scale;
  }
  operators.push(popGraphicsState());
  page.pushOperators(...operators);
}

function drawLayout(page: PDFPage, font: OutlineFont, layout: SignLayout, logo: PDFImage | null, xMm: number, yMm: number) {
  const pageHeight = mm(OFFER_PAGE_MM.height);
  const black = rgb(0, 0, 0);
  for (const rect of layout.rects) {
    const geometry = { x: mm(xMm + rect.x), y: pageHeight - mm(yMm + rect.y + rect.height), width: mm(rect.width), height: mm(rect.height) };
    if (rect.fill) page.drawRectangle({ ...geometry, color: black });
    else page.drawRectangle({ ...geometry, borderColor: black, borderWidth: mm(rect.strokeMm) });
  }
  if (logo && layout.logo) {
    const box = mm(layout.logo.size);
    const ratio = logo.width / logo.height;
    const width = ratio >= 1 ? box : box * ratio;
    const height = ratio >= 1 ? box / ratio : box;
    page.drawImage(logo, { x: mm(xMm + layout.logo.cx) - width / 2, y: pageHeight - mm(yMm + layout.logo.cy) - height / 2, width, height });
  }
  for (const text of layout.texts) drawGlyphs(page, font, text, xMm, yMm);
}

/** Genera el PDF: una página A4 apaisada por cada `SignPage`. */
export async function renderOfferSignPdf(pages: readonly SignPage[], options: OfferSignPdfOptions): Promise<Uint8Array> {
  if (pages.length === 0) throw new RangeError("No hay carteles para generar");
  const doc = await PDFDocument.create();
  doc.setTitle(options.title);
  doc.setProducer("Carnicerías - carteles de ofertas");
  doc.setCreator("Carnicerías Admin");
  doc.setCreationDate(options.createdAt);
  doc.setModificationDate(options.createdAt);
  const font = antonOutlines();
  const logo = options.logoPng ? await doc.embedPng(options.logoPng) : null;
  const black = rgb(0, 0, 0);
  for (const sheet of pages) {
    const page = doc.addPage([mm(OFFER_PAGE_MM.width), mm(OFFER_PAGE_MM.height)]);
    for (const rule of sheet.rules) {
      page.drawLine({
        start: { x: mm(rule.x1), y: mm(OFFER_PAGE_MM.height - rule.y1) }, end: { x: mm(rule.x2), y: mm(OFFER_PAGE_MM.height - rule.y2) },
        thickness: mm(rule.widthMm), color: black
      });
    }
    for (const panel of sheet.panels) drawLayout(page, font, panel.layout, logo, panel.x, panel.y);
  }
  // Sin object streams: el archivo más simple y compatible con visores de oficina e impresoras.
  return doc.save({ useObjectStreams: false });
}
