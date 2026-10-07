import type { LabelFontStyle } from "./label-font";

/**
 * ESPECIFICACIÓN ÚNICA de la etiqueta de góndola y de la hoja A4 (D-073). La consumen, sin copiar ningún número:
 *   - `label-layout.ts`  (geometría de la etiqueta: dónde va cada texto, a qué tamaño)
 *   - `product-price-label.tsx`  (preview en pantalla: SVG en milímetros)
 *   - `label-pdf.ts`  (PDF A4 real, 15 etiquetas por hoja)
 * Cambiar un valor acá cambia preview y PDF a la vez. Medidas en milímetros, tipografía en puntos (impresión), nunca px.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Etiqueta
// ---------------------------------------------------------------------------------------------------------------------

/** Tamaño físico de la etiqueta: 70 × 50 mm (relación 1,4). */
export const LABEL_WIDTH_MM = 70;
export const LABEL_HEIGHT_MM = 50;

/**
 * Márgenes internos. Las columnas exteriores de la hoja llegan al borde del papel y una impresora hogareña no imprime los últimos
 * ~3-4 mm: con 5 mm laterales ningún precio ni texto queda pegado al límite.
 */
export const LABEL_PAD_X_MM = 5;
export const LABEL_PAD_TOP_MM = 3.5;
export const LABEL_PAD_BOTTOM_MM = 3.5;

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;

/** Tipografía por rol (pt). El precio es SIEMPRE el elemento más grande de la etiqueta. */
export const LABEL_TYPE = {
  /** «OFERTA!!!» — grande, extra negrita, cursiva, centrado. */
  headline: { pt: 17, style: "boldItalic" },
  /** Nombre del producto — negrita, centrado, hasta 2 líneas (se achica de maxPt a minPt hasta que entre). */
  name: { maxPt: 11, minPt: 7, stepPt: 0.25, lineHeightEm: 1.12, maxLines: 2, style: "bold" },
  /** «POR 3 UNIDADES» — destacado, negrita, subrayado. */
  condition: { pt: 11, style: "bold" },
  /** «Descuento 15%» — debajo, negrita. */
  discount: { pt: 10, style: "bold" },
  /** «PRECIO» sobre el precio grande de la variante simple. */
  topLabel: { pt: 13, style: "bold" },
  /** Precio promocional (o el precio normal en la variante simple): el más grande. Se reduce sólo si no entra a lo ancho. */
  price: { promoMaxPt: 40, simpleMaxPt: 46, minPt: 20, style: "bold" },
  /** Sufijo «/kg» pegado al precio, como proporción de su tamaño. */
  priceSuffix: { scale: 0.4, style: "bold" },
  /** Fila inferior de la oferta: «PRECIO NORMAL» a la izquierda y el precio normal a la derecha. */
  normalLabel: { pt: 9, style: "bold" },
  normalPrice: { pt: 13, style: "bold" },
  /** «PRECIO UNITARIO» / «PRECIO POR KILO» bajo el precio de la variante simple. */
  footLabel: { pt: 9, style: "bold" },
  /** Subrayado de la condición: distancia bajo la línea base y grosor, como proporción del tamaño de la letra. */
  underline: { offsetEm: 0.14, thicknessEm: 0.065 }
} as const satisfies Record<string, Record<string, number | string>>;

/** Separaciones MÍNIMAS entre bloques (mm). Si sobra alto, se reparten (hasta duplicarlas) y el resto se centra. */
export const LABEL_GAPS_MM = {
  afterHeadline: 2.4,
  afterName: 2.8,
  conditionToDiscount: 1.7,
  afterDiscount: 3.2,
  afterPrice: 3.2,
  nameToTopLabel: 3,
  topLabelToPrice: 2,
  priceToFootLabel: 2.6,
  /** Cuánto puede crecer cada separación respecto de su mínimo cuando sobra alto (1 = hasta el doble). */
  maxGrowth: 1
} as const;

/** Piso de la reducción global (todas las medidas × fit) cuando un nombre largo + precio no entran en el alto disponible. */
export const LABEL_MIN_FIT = 0.6;
export const LABEL_FIT_STEP = 0.02;

export type { LabelFontStyle };

// ---------------------------------------------------------------------------------------------------------------------
// Hoja A4
// ---------------------------------------------------------------------------------------------------------------------

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/** 210 / 70 = 3 columnas exactas; 5 filas de 50 mm = 250 mm ⇒ 15 etiquetas por hoja. */
export const SHEET_COLUMNS = 3;
export const SHEET_ROWS = 5;
export const LABELS_PER_SHEET = SHEET_COLUMNS * SHEET_ROWS;

/** Los 47 mm verticales que sobran se reparten arriba y abajo (23,5 mm cada uno): la grilla queda centrada. */
export const SHEET_GRID_TOP_MM = (A4_HEIGHT_MM - SHEET_ROWS * LABEL_HEIGHT_MM) / 2;
export const SHEET_GRID_LEFT_MM = (A4_WIDTH_MM - SHEET_COLUMNS * LABEL_WIDTH_MM) / 2;

/** Guías de corte: línea fina gris alrededor de cada celda + marcas cortas en los márgenes superior e inferior. */
export const CUT_GUIDE = { gray: 0.55, widthPt: 0.3, tickMm: 4 } as const;

/** Encabezado de control en el margen superior (grupo, fecha y página): fuera del área de las etiquetas. */
export const SHEET_HEADER = { pt: 7, gray: 0.45, fromTopMm: 12, style: "regular" satisfies LabelFontStyle } as const;

/** Límites de una generación (el servidor los valida; la base también). */
export const MAX_LABEL_COPIES = 99;
export const MAX_LABELS_PER_RUN = 500;
export const MAX_PRODUCTS_PER_RUN = 500;
