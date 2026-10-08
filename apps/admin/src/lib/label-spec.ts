import type { LabelFontStyle } from "./label-font";

/**
 * ESPECIFICACIÓN ÚNICA de la etiqueta de góndola y de la hoja A4 (D-073). La consumen, sin copiar ningún número:
 *   - `label-layout.ts`  (geometría de la etiqueta: dónde va cada texto, a qué tamaño)
 *   - `product-price-label.tsx`  (preview en pantalla: SVG en milímetros)
 *   - `label-pdf.ts`  (PDF A4 real, 21 etiquetas por hoja)
 * Cambiar un valor acá cambia preview y PDF a la vez. Medidas en milímetros, tipografía en puntos (impresión), nunca px.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Etiqueta
// ---------------------------------------------------------------------------------------------------------------------

/** Tamaño físico de la etiqueta: 60 × 40 mm (relación 1,5). */
export const LABEL_WIDTH_MM = 60;
export const LABEL_HEIGHT_MM = 40;

/**
 * Márgenes internos. Las columnas exteriores de la hoja llegan al borde del papel y una impresora hogareña no imprime los últimos
 * ~3-4 mm: con 4 mm laterales ningún precio ni texto queda pegado al límite.
 */
export const LABEL_PAD_X_MM = 4;
export const LABEL_PAD_TOP_MM = 1.8;
export const LABEL_PAD_BOTTOM_MM = 2.8;

/** Franja negra superior «SUPER OFERTAS» (texto blanco) y borde fino negro: guía de corte. Misma geometría en preview y PDF. */
export const LABEL_BAND = { heightMm: 5.4 } as const;
export const LABEL_BORDER = { widthMm: 0.25 } as const;

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;

/** Tipografía por rol (pt). El precio es SIEMPRE el elemento más grande de la etiqueta. */
export const LABEL_TYPE = {
  /** «SUPER OFERTAS» — en la franja negra, blanco, negrita, centrado. */
  headline: { pt: 9.5, style: "bold" },
  /** Nombre del producto — negrita, centrado, hasta 2 líneas (se achica de maxPt a minPt hasta que entre). */
  name: { maxPt: 9, minPt: 6, stepPt: 0.25, lineHeightEm: 1.12, maxLines: 2, style: "bold" },
  /** «LLEVANDO 3 UNIDADES» — bajo el precio promocional, negrita. */
  condition: { pt: 8.5, style: "bold" },
  /** Precio promocional (o el precio unitario en la variante simple): el más grande. Se reduce sólo si no entra a lo ancho. */
  price: { promoMaxPt: 30, simpleMaxPt: 36, minPt: 16, style: "bold" },
  /** Sufijo «/kg» pegado al precio, como proporción de su tamaño. */
  priceSuffix: { scale: 0.4, style: "bold" },
  /** Fila inferior de la oferta: «PRECIO NORMAL» a la izquierda y el precio normal a la derecha. */
  normalLabel: { pt: 7, style: "bold" },
  normalPrice: { pt: 9, style: "bold" },
  /** «PRECIO UNITARIO» / «PRECIO POR KILO» bajo el precio de la variante simple. */
  footLabel: { pt: 7.5, style: "bold" }
} as const satisfies Record<string, Record<string, number | string>>;

/** Separaciones MÍNIMAS entre bloques (mm). Si sobra alto, se reparten (hasta duplicarlas) y el resto se centra. */
export const LABEL_GAPS_MM = {
  nameToPrice: 2.4,
  priceToCondition: 1.8,
  conditionToNormal: 2.6,
  priceToFootLabel: 2,
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

/** 3 columnas de 60 mm = 180 mm (15 mm de margen a cada lado); 7 filas de 40 mm = 280 mm (8,5 mm arriba y abajo) ⇒ 21 etiquetas por hoja. */
export const SHEET_COLUMNS = 3;
export const SHEET_ROWS = 7;
export const LABELS_PER_SHEET = SHEET_COLUMNS * SHEET_ROWS;

/** Los 47 mm verticales que sobran se reparten arriba y abajo (23,5 mm cada uno): la grilla queda centrada. */
export const SHEET_GRID_TOP_MM = (A4_HEIGHT_MM - SHEET_ROWS * LABEL_HEIGHT_MM) / 2;
export const SHEET_GRID_LEFT_MM = (A4_WIDTH_MM - SHEET_COLUMNS * LABEL_WIDTH_MM) / 2;

/** Guías de corte: marcas cortas en los márgenes superior e inferior (el borde de cada celda es el borde negro de la etiqueta). */
export const CUT_GUIDE = { gray: 0.55, widthPt: 0.3, tickMm: 2.5 } as const;

/** Encabezado de control en el margen superior (grupo, fecha y página): fuera del área de las etiquetas. */
export const SHEET_HEADER = { pt: 6, gray: 0.45, fromTopMm: 4.2, style: "regular" satisfies LabelFontStyle } as const;

/** Límites de una generación (el servidor los valida; la base también). */
export const MAX_LABEL_COPIES = 99;
export const MAX_LABELS_PER_RUN = 500;
export const MAX_PRODUCTS_PER_RUN = 500;
