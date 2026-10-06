import { formatBasisPointsPercent, MAX_PACK_SIZE_UNITS, MIN_PACK_SIZE_UNITS } from "@carnicerias/business-logic";

/**
 * Parseo del formulario de pack de la ficha del producto (sólo las UNIDADES por pack). El descuento del pack y la promoción
 * "llevando 3u" son configuración global de la organización (D-068, Productos → Precios → Configuración de precios): ningún
 * formulario por producto o por sucursal los envía. Puro y con tests; el servidor vuelve a validar todo (set_product_pack_size).
 */

/** "Unidades por pack": vacío = sin pack (null); si hay valor, un entero entre 2 y 10000. */
export function parsePackSizeUnits(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) throw new Error("Las unidades por pack tienen que ser un número entero.");
  const units = Number(value);
  if (!Number.isSafeInteger(units) || units < MIN_PACK_SIZE_UNITS || units > MAX_PACK_SIZE_UNITS) {
    throw new Error(`Las unidades por pack tienen que estar entre ${String(MIN_PACK_SIZE_UNITS)} y ${String(MAX_PACK_SIZE_UNITS)} (vacío = sin pack).`);
  }
  return units;
}

/** Las unidades por pack vigentes que el formulario trae ocultas: sirve para saber si cambió algo. Vacío o inválido = sin pack. */
export function parseCurrentPackSize(raw: string): number | null {
  const value = raw.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** "15% OFF desde 3 unidades" para la lista: la cantidad mínima del mismo producto, con el descuento sobre TODA la línea. */
export function describeBranchPromotion(minimumUnits: number, discountBps: number): string {
  return `${formatBasisPointsPercent(discountBps)}% OFF desde ${String(minimumUnits)} unidades`;
}
