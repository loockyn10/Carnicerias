import { PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib";

import { toLabelText, type LabelFontStyle } from "./label-font";
import { buildVacuumLabelLayout, packageToLabelData, type VacuumLabelKind, type VacuumLabelLayout } from "./vacuum-label-layout";
import { isValidEan13 } from "./vacuum-ean";
import { PT_PER_MM, type VacuumLabelDims } from "./vacuum-label-spec";
import { vacuumDims, type VacuumPackage, type VacuumPrintKind } from "./vacuum";

/**
 * PDF de las etiquetas térmicas de un paquete: UNA PÁGINA POR ETIQUETA, del tamaño exacto del papel (ancho × alto de cada etiqueta), vectorial
 * y con las fuentes estándar de PDF (sin incrustar nada). Se imprime desde el navegador de la computadora con la impresora térmica conectada
 * (sin impresión remota ni RAW): hay que imprimir al 100 % / tamaño real.
 *
 * La etiqueta se construye SIEMPRE desde el snapshot del paquete (nunca desde precios o textos actuales) y se niega a imprimir un EAN-13
 * inválido.
 */

const FONT_FOR: Record<LabelFontStyle, StandardFonts> = {
  regular: StandardFonts.Helvetica,
  bold: StandardFonts.HelveticaBold,
  boldItalic: StandardFonts.HelveticaBoldOblique
};

const mm = (value: number) => value * PT_PER_MM;

type Fonts = Record<LabelFontStyle, PDFFont>;

function drawLayout(page: ReturnType<PDFDocument["addPage"]>, fonts: Fonts, layout: VacuumLabelLayout): void {
  const pageHeight = mm(layout.heightMm);
  const black = rgb(0, 0, 0);
  for (const rect of layout.rects) {
    const geometry = { x: mm(rect.x), y: pageHeight - mm(rect.y + rect.height), width: mm(rect.width), height: mm(rect.height) };
    if (rect.fill) page.drawRectangle({ ...geometry, color: black });
    else page.drawRectangle({ ...geometry, borderColor: black, borderWidth: mm(rect.strokeMm) });
  }
  for (const rule of layout.rules) {
    page.drawLine({ start: { x: mm(rule.x1), y: pageHeight - mm(rule.y1) }, end: { x: mm(rule.x2), y: pageHeight - mm(rule.y2) }, thickness: mm(rule.widthMm), color: black });
  }
  for (const bar of layout.bars) {
    page.drawRectangle({ x: mm(bar.x), y: pageHeight - mm(bar.y + bar.height), width: mm(bar.width), height: mm(bar.height), color: black });
  }
  for (const text of layout.texts) {
    const font = fonts[text.style];
    const width = font.widthOfTextAtSize(text.text, text.sizePt);
    const shift = text.anchor === "middle" ? width / 2 : text.anchor === "end" ? width : 0;
    page.drawText(text.text, { x: mm(text.x) - shift, y: pageHeight - mm(text.y), size: text.sizePt, font, color: black });
  }
}

export class VacuumLabelError extends Error {}

export interface VacuumLabelPdfResult {
  pdf: Uint8Array;
  pageCount: number;
  /** Etiquetas cuyo contenido no entra en el alto configurado (se imprimen igual; la pantalla ya lo avisa). */
  overflow: VacuumLabelKind[];
}

function kindsFor(kind: VacuumPrintKind): VacuumLabelKind[] {
  return kind === "BOTH" ? ["INFO", "PRICE"] : [kind];
}

/** Arma el PDF desde el paquete registrado. `INFO`/`PRICE` = una etiqueta (reimpresión de una que salió mal); `BOTH` = las dos, informativa primero. */
export async function renderVacuumLabelsPdf(pkg: VacuumPackage, kind: VacuumPrintKind, dimsOverride?: VacuumLabelDims): Promise<VacuumLabelPdfResult> {
  if (!isValidEan13(pkg.ean13)) throw new VacuumLabelError("El EAN-13 del paquete es inválido: no se imprime");
  const dims = dimsOverride ?? vacuumDims({ labelWidthMm: pkg.dims.widthMm, infoHeightMm: pkg.dims.infoHeightMm, priceHeightMm: pkg.dims.priceHeightMm });
  const data = packageToLabelData(pkg);
  const layouts = kindsFor(kind).map((labelKind) => buildVacuumLabelLayout(labelKind, data, dims));

  const doc = await PDFDocument.create();
  doc.setTitle(toLabelText(`Envasado ${pkg.lot} - ${pkg.productName}`));
  doc.setProducer("Carnicerías - etiquetas de envasado");
  doc.setCreator("Carnicerías Admin");
  const created = new Date(pkg.createdAt);
  if (!Number.isNaN(created.getTime())) { doc.setCreationDate(created); doc.setModificationDate(created); }
  const fonts: Fonts = {
    regular: await doc.embedFont(FONT_FOR.regular),
    bold: await doc.embedFont(FONT_FOR.bold),
    boldItalic: await doc.embedFont(FONT_FOR.boldItalic)
  };
  for (const layout of layouts) {
    const page = doc.addPage([mm(layout.widthMm), mm(layout.heightMm)]);
    drawLayout(page, fonts, layout);
  }
  return { pdf: await doc.save({ useObjectStreams: false }), pageCount: layouts.length, overflow: layouts.filter((layout) => layout.overflow).map((layout) => layout.kind) };
}

export function vacuumLabelFilename(pkg: Pick<VacuumPackage, "lot">, kind: VacuumPrintKind): string {
  const safeLot = pkg.lot.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = kind === "BOTH" ? "etiquetas" : kind === "INFO" ? "informativa" : "precio";
  return `envasado-${safeLot}-${suffix}.pdf`;
}
