import { MAX_PACK_SIZE_UNITS, MIN_PACK_SIZE_UNITS } from "@carnicerias/business-logic";

import { percentageToBasisPointsAllowZero, text } from "./form-parsing";

/**
 * Parseo de los formularios de unidades por pack (ficha del producto) y de la promoción global por sucursal
 * (Admin → Productos → Promociones). Puro y con tests; el servidor vuelve a validar todo (set_product_pack_size,
 * save_branch_promotion).
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

export interface BranchPromotionInput {
  branchId: string;
  everyUnits: number;
  discountBps: number;
  active: boolean;
}

/** "Cada N unidades, X %" de una sucursal. Con `active` apagado sólo importa la sucursal (se desactiva la vigente). */
export function parseBranchPromotionForm(formData: FormData): BranchPromotionInput {
  const branchId = text(formData, "branch_id");
  if (!branchId) throw new Error("Elegí la sucursal.");
  const active = formData.get("active") === "on";
  if (!active) return { branchId, everyUnits: 0, discountBps: 0, active };
  const rawEvery = text(formData, "every_units");
  if (!/^\d+$/.test(rawEvery) || Number(rawEvery) < 2 || Number(rawEvery) > 1000) {
    throw new Error("«Cada» tiene que ser un número entero de unidades, entre 2 y 1000.");
  }
  const discountBps = percentageToBasisPointsAllowZero(text(formData, "discount_percent"), "Descuento", 9_999n);
  if (discountBps < 1) throw new Error("El descuento tiene que ser mayor a 0.");
  return { branchId, everyUnits: Number(rawEvery), discountBps, active };
}

/** "Cada 3 unidades, 15 % OFF" para la lista. */
export function describeBranchPromotion(everyUnits: number, discountBps: number): string {
  return `Cada ${String(everyUnits)} unidades del mismo producto, ${String(discountBps / 100).replace(".", ",")}% OFF`;
}
