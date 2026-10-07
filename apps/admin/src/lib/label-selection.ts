import { LABELS_PER_SHEET, MAX_LABEL_COPIES, MAX_LABELS_PER_RUN } from "./label-spec";

/**
 * Selección de productos y copias en la pantalla de etiquetas. Lógica pura (sin React ni red) para poder probar los atajos
 * «Seleccionar todos» / «Seleccionar precios cambiados» y las cantidades. Importa sólo constantes livianas: se usa desde el navegador.
 */

/** Lo mínimo que la selección necesita saber de cada producto del grupo. */
export interface SelectableItem {
  productId: string;
  printable: boolean;
  needsPrint: boolean;
}

/** Todos los productos que hoy se pueden imprimir (los inactivos / sin precio quedan afuera). */
export function selectAllPrintable(items: readonly SelectableItem[]): Set<string> {
  return new Set(items.filter((item) => item.printable).map((item) => item.productId));
}

/** Los que no tienen etiqueta física o la tienen vieja (precio, promoción o nombre cambiados). */
export function selectNeedingPrint(items: readonly SelectableItem[]): Set<string> {
  return new Set(items.filter((item) => item.printable && item.needsPrint).map((item) => item.productId));
}

/** Entero entre 1 y 99; cualquier otra cosa (vacío, 0, 2,5, 100, texto) es null (inválido). */
export function parseCopies(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= MAX_LABEL_COPIES ? value : null;
}

export interface RunSelection {
  items: { productId: string; copies: number }[];
  labelCount: number;
  /** Productos seleccionados con una cantidad de copias inválida. */
  invalidCopies: string[];
  /** true cuando se pasa del límite de etiquetas por generación. */
  overLimit: boolean;
}

/**
 * Pedido de generación a partir de lo tildado, EN EL ORDEN DEL GRUPO. `copies` guarda lo que se tipeó (texto) por producto; sin tipear = 1.
 * Los productos no imprimibles se ignoran aunque estén tildados.
 */
export function buildRunSelection(items: readonly SelectableItem[], selected: ReadonlySet<string>, copies: Readonly<Record<string, string>>): RunSelection {
  const result: RunSelection = { items: [], labelCount: 0, invalidCopies: [], overLimit: false };
  for (const item of items) {
    if (!item.printable || !selected.has(item.productId)) continue;
    const parsed = parseCopies(copies[item.productId] ?? "1");
    if (parsed === null) {
      result.invalidCopies.push(item.productId);
      continue;
    }
    result.items.push({ productId: item.productId, copies: parsed });
    result.labelCount += parsed;
  }
  result.overLimit = result.labelCount > MAX_LABELS_PER_RUN;
  return result;
}

/** Hojas necesarias para `labelCount` etiquetas (15 por hoja A4). */
export function sheetsFor(labelCount: number, perSheet = LABELS_PER_SHEET): number {
  return labelCount <= 0 ? 0 : Math.ceil(labelCount / perSheet);
}
