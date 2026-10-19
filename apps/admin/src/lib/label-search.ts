/**
 * Filtro local para las etiquetas que ya leyó la RPC de la sucursal. No toca el
 * estado de selección: cambiar la búsqueda sólo cambia qué filas se muestran.
 */
export interface LabelSearchableItem {
  name: string;
  sku: string | null;
  barcodes: readonly string[];
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-AR").trim();
}

export function matchesLabelSearch(item: LabelSearchableItem, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  return [item.name, item.sku ?? "", ...item.barcodes].some((value) => normalize(value).includes(needle));
}
