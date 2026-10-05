/**
 * Vista LISTA compacta del catálogo de Central. Sólo presentación: qué se ve, no qué pasa al tocar un
 * producto (eso sigue siendo `openWeight` en App.tsx, idéntico al de la card) ni qué productos se ven
 * (filtros, búsqueda y stock siguen siendo los de siempre). Lógica pura, sin React ni red.
 */

export type CatalogViewMode = "LIST" | "GRID";

/**
 * Central (la capacidad que informa el servidor para la sucursal productiva: `centralPos`, nunca el
 * nombre) usa la lista compacta; el resto de las sucursales conserva la grilla de cards exactamente igual.
 */
export function catalogViewMode(centralPos: boolean): CatalogViewMode {
  return centralPos ? "LIST" : "GRID";
}

/** Alto fijo de cada fila (px): la ventana virtual se calcula con él, así que el CSS de la fila debe respetarlo. */
export const CENTRAL_ROW_HEIGHT = 56;

/** Filas extra renderizadas antes/después de lo visible, para que el scroll rápido no muestre huecos. */
export const CENTRAL_ROW_OVERSCAN = 8;

export interface VisibleWindow {
  /** Primer índice renderizado (inclusive). */
  start: number;
  /** Último índice renderizado (exclusivo). */
  end: number;
}

/**
 * Rango de filas a montar para un scroll vertical de filas de alto fijo. Con miles de productos sólo se
 * montan las filas visibles + el overscan; el resto es un espaciador de alto equivalente.
 */
export function computeVisibleWindow(options: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  total: number;
  overscan: number;
}): VisibleWindow {
  const { scrollTop, viewportHeight, rowHeight, total, overscan } = options;
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.min(Math.max(0, firstVisible - overscan), total - 1);
  const end = Math.min(total, firstVisible + visibleCount + overscan);
  return { start, end };
}

export interface CentralListProduct {
  productId: string;
  productName: string;
  productSku: string | null;
  unitType: "WEIGHT" | "UNIT";
  pricePerKgCents: bigint;
  barcodes: readonly string[];
}

/** Línea secundaria de la fila: SKU y primer código de barras (los que existan), chicos y en gris. */
export function centralRowCode(product: Pick<CentralListProduct, "productSku" | "barcodes">): string | null {
  const parts: string[] = [];
  if (product.productSku) parts.push(product.productSku);
  const barcode = product.barcodes[0];
  if (barcode && barcode !== product.productSku) parts.push(barcode);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Tipo de venta tal como se rotula en la lista. */
export function centralUnitLabel(unitType: CentralListProduct["unitType"]): "UNIDAD" | "KG" {
  return unitType === "WEIGHT" ? "KG" : "UNIDAD";
}
