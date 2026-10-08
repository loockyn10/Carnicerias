import {
  A4_HEIGHT_MM, A4_WIDTH_MM, LABEL_HEIGHT_MM, LABEL_WIDTH_MM, LABELS_PER_SHEET, SHEET_COLUMNS, SHEET_GRID_LEFT_MM, SHEET_GRID_TOP_MM
} from "./label-spec";

/**
 * Hoja A4 de etiquetas: 3 columnas × 7 filas de 60 × 40 mm (21 por hoja), llenando izquierda → derecha y arriba → abajo en el orden
 * recibido. Puro y sin PDF: lo usan el generador y las pruebas (cantidad de páginas, posición exacta de cada celda).
 */

export interface SheetCell {
  /** Página (desde 0). */
  page: number;
  /** Fila (0..4) y columna (0..2) dentro de la página. */
  row: number;
  column: number;
  /** Esquina superior izquierda de la celda, en mm desde la esquina superior izquierda de la hoja. */
  xMm: number;
  yMm: number;
}

/** Celda de la etiqueta número `index` (desde 0) de la secuencia. */
export function sheetCell(index: number): SheetCell {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Invalid label index");
  const slot = index % LABELS_PER_SHEET;
  const row = Math.floor(slot / SHEET_COLUMNS);
  const column = slot % SHEET_COLUMNS;
  return {
    page: Math.floor(index / LABELS_PER_SHEET), row, column,
    xMm: SHEET_GRID_LEFT_MM + column * LABEL_WIDTH_MM,
    yMm: SHEET_GRID_TOP_MM + row * LABEL_HEIGHT_MM
  };
}

export function sheetPageCount(labelCount: number): number {
  return labelCount <= 0 ? 0 : Math.ceil(labelCount / LABELS_PER_SHEET);
}

/** Repite cada elemento `copies` veces, conservando el orden (Mayonesa ×2, Yerba ×1 ⇒ M, M, Y). */
export function expandCopies<T>(entries: readonly { item: T; copies: number }[]): T[] {
  const output: T[] = [];
  for (const { item, copies } of entries) {
    for (let copy = 0; copy < copies; copy += 1) output.push(item);
  }
  return output;
}

export const SHEET_SIZE_MM = { width: A4_WIDTH_MM, height: A4_HEIGHT_MM } as const;
