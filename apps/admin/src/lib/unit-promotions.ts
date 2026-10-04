import { formatBasisPointsPercent, isValidPackDiscountBps, MAX_PACK_DISCOUNT_BPS, MAX_PACK_SIZE_UNITS, MIN_PACK_DISCOUNT_BPS, MIN_PACK_SIZE_UNITS } from "@carnicerias/business-logic";

import { percentageToBasisPointsAllowZero, text } from "./form-parsing";

/**
 * Parseo de los formularios de pack (unidades por pack + descuento del pack, ficha del producto) y de la promoción global por
 * sucursal "desde N unidades" (Admin → Productos → Promociones). Puro y con tests; el servidor vuelve a validar todo
 * (set_product_pack_size, save_branch_promotion).
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

/** "Descuento del pack": vacío = sin valor (null); si hay valor, un porcentaje con 0 < % < 100 (hasta 2 decimales) en basis points. */
export function parsePackDiscountBps(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(value)) throw new Error("El descuento del pack tiene que ser un porcentaje (por ejemplo 20 o 12,5).");
  const basisPoints = percentageToBasisPointsAllowZero(value, "Descuento del pack", BigInt(MAX_PACK_DISCOUNT_BPS));
  if (!isValidPackDiscountBps(basisPoints)) {
    throw new Error(`El descuento del pack tiene que ser mayor a 0 y menor a 100 (entre ${formatBasisPointsPercent(MIN_PACK_DISCOUNT_BPS)} y ${formatBasisPointsPercent(MAX_PACK_DISCOUNT_BPS)}).`);
  }
  return basisPoints;
}

/** La configuración del pack de un producto: las dos cosas juntas o ninguna. */
export interface PackConfigInput {
  packSizeUnits: number | null;
  packDiscountBps: number | null;
}

/**
 * Unidades por pack + descuento del pack, del formulario. Sin unidades = sin pack (y entonces tampoco puede haber descuento); con
 * unidades el descuento es obligatorio. Nunca queda un pack sin descuento ni un descuento sin pack.
 */
export function parsePackConfigForm(sizeRaw: string, percentRaw: string): PackConfigInput {
  const packSizeUnits = parsePackSizeUnits(sizeRaw);
  const packDiscountBps = parsePackDiscountBps(percentRaw);
  if (packSizeUnits === null) {
    if (packDiscountBps !== null) throw new Error("El descuento del pack necesita las unidades por pack: cargá las dos cosas o dejá las dos vacías.");
    return { packSizeUnits: null, packDiscountBps: null };
  }
  if (packDiscountBps === null) throw new Error("Cargá el descuento del pack (por ejemplo 20): un pack necesita sus unidades y su descuento.");
  return { packSizeUnits, packDiscountBps };
}

/** La configuración vigente que el formulario trae oculta (unidades y basis points guardados): sirve para saber si cambió algo. */
export function parseCurrentPackConfig(sizeRaw: string, basisPointsRaw: string): PackConfigInput {
  const size = sizeRaw.trim();
  const bps = basisPointsRaw.trim();
  if (size === "" || !/^\d+$/.test(size)) return { packSizeUnits: null, packDiscountBps: null };
  return { packSizeUnits: Number(size), packDiscountBps: /^\d+$/.test(bps) ? Number(bps) : null };
}

export interface BranchPromotionInput {
  branchId: string;
  minimumUnits: number;
  discountBps: number;
  active: boolean;
}

/** "Desde N unidades, X %" de una sucursal. Con `active` apagado sólo importa la sucursal (se desactiva la vigente). */
export function parseBranchPromotionForm(formData: FormData): BranchPromotionInput {
  const branchId = text(formData, "branch_id");
  if (!branchId) throw new Error("Elegí la sucursal.");
  const active = formData.get("active") === "on";
  if (!active) return { branchId, minimumUnits: 0, discountBps: 0, active };
  const rawMinimum = text(formData, "minimum_units");
  if (!/^\d+$/.test(rawMinimum) || Number(rawMinimum) < 2 || Number(rawMinimum) > 1000) {
    throw new Error("«Desde» tiene que ser un número entero de unidades, entre 2 y 1000.");
  }
  const discountBps = percentageToBasisPointsAllowZero(text(formData, "discount_percent"), "Descuento", 9_999n);
  if (discountBps < 1) throw new Error("El descuento tiene que ser mayor a 0.");
  return { branchId, minimumUnits: Number(rawMinimum), discountBps, active };
}

/** "15% OFF desde 3 unidades" para la lista: la cantidad mínima del mismo producto, con el descuento sobre TODA la línea. */
export function describeBranchPromotion(minimumUnits: number, discountBps: number): string {
  return `${formatBasisPointsPercent(discountBps)}% OFF desde ${String(minimumUnits)} unidades`;
}
