import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

import { textWidthPt, toLabelText, type LabelFontStyle } from "./label-font";
import type { LabelLayout } from "./label-layout";
import { sheetCell, sheetPageCount } from "./label-sheet";
import {
  A4_HEIGHT_MM, A4_WIDTH_MM, CUT_GUIDE, LABEL_HEIGHT_MM, LABEL_WIDTH_MM, PT_PER_MM, SHEET_COLUMNS, SHEET_GRID_LEFT_MM, SHEET_GRID_TOP_MM,
  SHEET_HEADER, SHEET_ROWS
} from "./label-spec";

/**
 * PDF A4 real (vectorial, texto seleccionable) con las etiquetas de góndola de 70 × 50 mm, 15 por hoja. Sin Chromium ni capturas: se
 * dibuja con pdf-lib y las fuentes estándar de PDF (Helvetica), a partir de los MISMOS layouts que usa el preview.
 *
 * La página mide exactamente 210 × 297 mm y cada celda 70 × 50 mm: hay que imprimir al 100 % / tamaño real (sin «ajustar a la página»).
 */

const FONT_FOR: Record<LabelFontStyle, StandardFonts> = {
  regular: StandardFonts.Helvetica,
  bold: StandardFonts.HelveticaBold,
  boldItalic: StandardFonts.HelveticaBoldOblique
};

const mm = (value: number) => value * PT_PER_MM;

export interface LabelSheetOptions {
  /** Título del documento (metadatos del PDF). */
  title: string;
  /** Encabezado de control en el margen superior (grupo y fecha); la página se agrega sola («Página 1 de 2»). */
  header: string;
  createdAt: Date;
}

type Fonts = Record<LabelFontStyle, PDFFont>;

function drawGuides(page: PDFPage, cellCount: number) {
  const color = rgb(CUT_GUIDE.gray, CUT_GUIDE.gray, CUT_GUIDE.gray);
  const pageHeight = mm(A4_HEIGHT_MM);
  // Un borde fino alrededor de cada celda ocupada: se corta por dentro de la línea.
  for (let index = 0; index < cellCount; index += 1) {
    const cell = sheetCell(index);
    page.drawRectangle({
      x: mm(cell.xMm), y: pageHeight - mm(cell.yMm + LABEL_HEIGHT_MM), width: mm(LABEL_WIDTH_MM), height: mm(LABEL_HEIGHT_MM),
      borderColor: color, borderWidth: CUT_GUIDE.widthPt
    });
  }
  // Marcas de corte en los márgenes superior e inferior, a 70 y 140 mm (en los bordes del papel no caben).
  const gridBottom = SHEET_GRID_TOP_MM + SHEET_ROWS * LABEL_HEIGHT_MM;
  for (let column = 1; column < SHEET_COLUMNS; column += 1) {
    const x = mm(SHEET_GRID_LEFT_MM + column * LABEL_WIDTH_MM);
    page.drawLine({ start: { x, y: pageHeight - mm(SHEET_GRID_TOP_MM - CUT_GUIDE.tickMm) }, end: { x, y: pageHeight - mm(SHEET_GRID_TOP_MM) }, thickness: CUT_GUIDE.widthPt, color });
    page.drawLine({ start: { x, y: pageHeight - mm(gridBottom) }, end: { x, y: pageHeight - mm(gridBottom + CUT_GUIDE.tickMm) }, thickness: CUT_GUIDE.widthPt, color });
  }
}

function drawLabel(page: PDFPage, fonts: Fonts, layout: LabelLayout, xMm: number, yMm: number) {
  const pageHeight = mm(A4_HEIGHT_MM);
  const black = rgb(0, 0, 0);
  for (const rule of layout.rules) {
    page.drawLine({
      start: { x: mm(xMm + rule.x1), y: pageHeight - mm(yMm + rule.y1) }, end: { x: mm(xMm + rule.x2), y: pageHeight - mm(yMm + rule.y2) },
      thickness: mm(rule.widthMm), color: black
    });
  }
  for (const text of layout.texts) {
    const width = textWidthPt(text.text, text.sizePt, text.style);
    const anchorShift = text.anchor === "middle" ? width / 2 : text.anchor === "end" ? width : 0;
    page.drawText(text.text, {
      x: mm(xMm + text.x) - anchorShift, y: pageHeight - mm(yMm + text.y), size: text.sizePt, font: fonts[text.style], color: black
    });
  }
}

/** Genera el PDF. `layouts` ya trae cada copia repetida (una por etiqueta física) en el orden de impresión. */
export async function renderLabelSheetPdf(layouts: readonly LabelLayout[], options: LabelSheetOptions): Promise<Uint8Array> {
  if (layouts.length === 0) throw new RangeError("No hay etiquetas para generar");
  const doc = await PDFDocument.create();
  doc.setTitle(toLabelText(options.title));
  doc.setProducer("Carnicerías - etiquetas de góndola");
  doc.setCreator("Carnicerías Admin");
  doc.setCreationDate(options.createdAt);
  doc.setModificationDate(options.createdAt);
  const fonts: Fonts = {
    regular: await doc.embedFont(FONT_FOR.regular),
    bold: await doc.embedFont(FONT_FOR.bold),
    boldItalic: await doc.embedFont(FONT_FOR.boldItalic)
  };

  const pages = sheetPageCount(layouts.length);
  const header = toLabelText(options.header);
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const page = doc.addPage([mm(A4_WIDTH_MM), mm(A4_HEIGHT_MM)]);
    const first = pageIndex * SHEET_COLUMNS * SHEET_ROWS;
    const onPage = layouts.slice(first, first + SHEET_COLUMNS * SHEET_ROWS);
    drawGuides(page, onPage.length);

    const headerText = toLabelText(`${header}  -  Página ${String(pageIndex + 1)} de ${String(pages)}  -  Imprimir al 100% (tamaño real)`);
    const headerWidth = textWidthPt(headerText, SHEET_HEADER.pt, SHEET_HEADER.style);
    page.drawText(headerText, {
      x: mm(A4_WIDTH_MM) / 2 - headerWidth / 2, y: mm(A4_HEIGHT_MM - SHEET_HEADER.fromTopMm), size: SHEET_HEADER.pt, font: fonts[SHEET_HEADER.style],
      color: rgb(SHEET_HEADER.gray, SHEET_HEADER.gray, SHEET_HEADER.gray)
    });

    onPage.forEach((layout, slot) => {
      const cell = sheetCell(first + slot);
      drawLabel(page, fonts, layout, cell.xMm, cell.yMm);
    });
  }
  // Sin object streams: el archivo más simple y compatible para visores de oficina e impresoras.
  return doc.save({ useObjectStreams: false });
}
