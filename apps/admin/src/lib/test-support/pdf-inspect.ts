import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFPage } from "pdf-lib";

/**
 * Inspección de un PDF generado, SOLO para pruebas: lee el tamaño de cada página y, de su contenido (operadores de dibujo), los textos
 * con su posición/tamaño de letra y los rectángulos de las guías de corte. Sirve para verificar el PDF real (no sólo el layout previo).
 */

export interface PdfText {
  text: string;
  /** Posición (pt) del origen del texto, con el origen de la hoja ABAJO a la izquierda (como en PDF). */
  x: number;
  y: number;
  sizePt: number;
  font: string;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageInfo {
  widthPt: number;
  heightPt: number;
  texts: PdfText[];
  rects: PdfRect[];
}

const PT_PER_MM = 72 / 25.4;
export const mmOf = (pt: number) => pt / PT_PER_MM;

function contentOf(page: PDFPage): string {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((ref) => {
      const stream = page.doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return "";
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    })
    .join("\n");
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfPageInfo[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const content = contentOf(page);
    const size = page.getSize();
    const texts: PdfText[] = [];
    for (const block of content.matchAll(/BT\n([\s\S]*?)ET/g)) {
      const body = block[1] ?? "";
      const font = /\/(\S+) ([\d.]+) Tf/.exec(body);
      const matrix = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(body);
      const hex = /<([0-9A-Fa-f]+)> Tj/.exec(body);
      if (!font || !matrix || !hex) continue;
      texts.push({
        text: Buffer.from(hex[1] ?? "", "hex").toString("latin1"), x: Number(matrix[1]), y: Number(matrix[2]),
        sizePt: Number(font[2]), font: (font[1] ?? "").replace(/-\d+$/, "")
      });
    }
    const rects: PdfRect[] = [];
    for (const block of content.matchAll(/q\n[\d. ]+RG\n[\d.]+ w\n\[\] 0 d\n1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 ([\d.]+) l\n([\d.]+) \3 l\n\4 0 l\nh\nS\nQ/g)) {
      rects.push({ x: Number(block[1]), y: Number(block[2]), width: Number(block[4]), height: Number(block[3]) });
    }
    return { widthPt: size.width, heightPt: size.height, texts, rects };
  });
}
