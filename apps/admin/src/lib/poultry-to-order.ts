import { isIsoDate } from "./date-range";
import { comparePoultryProducts, isPoultryCategory, POULTRY_CATEGORIES, POULTRY_CATEGORY_LABELS, POULTRY_SORT_ORDER_MAX, type PoultryCategory } from "./poultry";
import { asArray, asRecord, int, intOrNull, str, strOrNull } from "./rpc-json";

/**
 * Pollos → «Mercadería a encargar» (D-105): cuántos cajones de cada producto hay que comprarle al proveedor para cumplir los pedidos abiertos.
 *
 * El servidor (`get_poultry_boxes_to_order`) ya sumó, por producto y fecha de entrega, los cajones de los pedidos ABIERTOS (pendiente,
 * preparando, listo; nunca entregados ni cancelados). Acá sólo se arman las tres vistas a partir de esas líneas, sin tocar nada:
 *   - «Sin fecha»: pedidos abiertos sin fecha de entrega (jamás se les asigna la de hoy);
 *   - «Por fecha»: los de una fecha concreta (las vencidas que siguen abiertas conservan su propia fecha);
 *   - «Total general»: todo lo pendiente, sin importar la fecha.
 * No se descuenta stock (este módulo no lleva existencias) ni se crea ninguna orden de compra.
 */

export interface ToOrderLine {
  productId: string;
  name: string;
  category: PoultryCategory;
  /** Número de orden manual dentro de la categoría (D-101). */
  sortOrder: number;
  /** null = pedido sin fecha de entrega. */
  deliveryOn: string | null;
  /** Cajones completos pendientes de ese producto para esa fecha. */
  boxes: number;
  /** Pedidos distintos que los componen. */
  orders: number;
}

export interface ToOrderData {
  /** Hoy en la zona horaria de la organización (aaaa-mm-dd). */
  today: string;
  lines: ToOrderLine[];
}

export function parseToOrder(value: unknown): ToOrderData {
  const record = asRecord(value);
  return {
    today: str(record.today),
    lines: asArray(record.lines).map((entry) => {
      const row = asRecord(entry);
      const deliveryOn = strOrNull(row.deliveryOn);
      return {
        productId: str(row.productId), name: str(row.name),
        category: isPoultryCategory(row.category) ? row.category : "POLLO", sortOrder: intOrNull(row.sortOrder) ?? POULTRY_SORT_ORDER_MAX,
        deliveryOn: deliveryOn !== null && isIsoDate(deliveryOn) ? deliveryOn : null,
        boxes: int(row.boxes), orders: int(row.orders)
      };
    })
  };
}

export const TO_ORDER_VIEWS = ["all", "none", "date"] as const;
export type ToOrderView = (typeof TO_ORDER_VIEWS)[number];

export const TO_ORDER_VIEW_LABELS: Record<ToOrderView, string> = { all: "Total general", none: "Sin fecha", date: "Por fecha" };

export function isToOrderView(value: unknown): value is ToOrderView {
  return typeof value === "string" && (TO_ORDER_VIEWS as readonly string[]).includes(value);
}

export interface ToOrderRow { productId: string; name: string; category: PoultryCategory; sortOrder: number; boxes: number; orders: number }

export interface ToOrderSection { category: PoultryCategory; label: string; rows: ToOrderRow[]; boxes: number }

export interface ToOrderSummary { sections: ToOrderSection[]; totalBoxes: number }

/** Líneas que pertenecen a una vista: todas, las sin fecha, o las de una fecha exacta (aaaa-mm-dd). */
export function linesForView(lines: readonly ToOrderLine[], view: ToOrderView, date: string | null): ToOrderLine[] {
  if (view === "all") return [...lines];
  if (view === "none") return lines.filter((line) => line.deliveryOn === null);
  return lines.filter((line) => date !== null && line.deliveryOn === date);
}

/**
 * Arma la tabla de una vista: un renglón por producto (suma de las líneas de la vista), ordenado como el catálogo de Pollos (categoría,
 * número de orden, nombre) y separado por categoría. Sólo aparecen categorías con cajones; el total es la suma de los renglones.
 */
export function summarizeToOrder(lines: readonly ToOrderLine[], view: ToOrderView, date: string | null = null): ToOrderSummary {
  const byProduct = new Map<string, ToOrderRow>();
  for (const line of linesForView(lines, view, date)) {
    if (line.boxes <= 0) continue;
    const current = byProduct.get(line.productId);
    if (current) {
      current.boxes += line.boxes;
      current.orders += line.orders;
    } else {
      byProduct.set(line.productId, { productId: line.productId, name: line.name, category: line.category, sortOrder: line.sortOrder, boxes: line.boxes, orders: line.orders });
    }
  }
  const rows = [...byProduct.values()].sort((a, b) => comparePoultryProducts({ ...a, id: a.productId }, { ...b, id: b.productId }));
  const sections: ToOrderSection[] = [];
  for (const category of POULTRY_CATEGORIES) {
    const sectionRows = rows.filter((row) => row.category === category);
    if (sectionRows.length > 0) sections.push({ category, label: POULTRY_CATEGORY_LABELS[category], rows: sectionRows, boxes: sectionRows.reduce((sum, row) => sum + row.boxes, 0) });
  }
  return { sections, totalBoxes: sections.reduce((sum, section) => sum + section.boxes, 0) };
}

export interface ToOrderDate { date: string; boxes: number; /** Fecha anterior a hoy con pedidos todavía abiertos. */ overdue: boolean }

/** Fechas de entrega con pedidos abiertos, de la más vieja a la más nueva, con sus cajones. */
export function listToOrderDates(lines: readonly ToOrderLine[], today: string): ToOrderDate[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.deliveryOn !== null && line.boxes > 0) totals.set(line.deliveryOn, (totals.get(line.deliveryOn) ?? 0) + line.boxes);
  }
  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, boxes]) => ({ date, boxes, overdue: today !== "" && date < today }));
}

/** Fecha con la que abre «Por fecha»: la próxima desde hoy (la de hoy si la hay); si no queda ninguna, la última (vencida); sin fechas, hoy. */
export function defaultToOrderDate(dates: readonly ToOrderDate[], today: string): string {
  const upcoming = dates.find((entry) => entry.date >= today);
  if (upcoming) return upcoming.date;
  return dates[dates.length - 1]?.date ?? today;
}

export interface ToOrderSelection { view: ToOrderView; date: string }

/** Vista y fecha pedidas en la URL; una vista inválida abre el total general y una fecha inválida o ausente la fecha por defecto. */
export function resolveToOrderSelection(rawView: string, rawDate: string, dates: readonly ToOrderDate[], today: string): ToOrderSelection {
  return {
    view: isToOrderView(rawView) ? rawView : "all",
    date: isIsoDate(rawDate) ? rawDate : defaultToOrderDate(dates, today)
  };
}
