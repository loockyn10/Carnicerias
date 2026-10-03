import type { PaymentMethod } from "@carnicerias/types";

import { divideRoundHalfUp, isCardSurchargePaymentMethod, validateBasisPoints, type SalePricing } from "./pricing";

/**
 * Descuentos de productos `UNIT` que no dependen de una promoción cargada por producto:
 *
 *   - **Pack** (`products.pack_size_units`): una unidad operativa de carga rápida. Vender "N packs" de un producto con
 *     `pack_size_units = S` registra `N × S` unidades REALES (stock, precio y venta trabajan siempre con unidades
 *     reales; el pack no es otra unidad de inventario) y TODAS reciben `PACK_DISCOUNT_BPS` (20 %) de descuento.
 *   - **Promoción de sucursal** (`branch_promotions`): "cada E unidades del MISMO producto, D % de descuento" para todos
 *     los productos `UNIT` de una sucursal. Sólo se descuentan grupos completos: `floor(cantidad / E) × E` unidades.
 *
 * Precedencia (productos UNIT, de mayor a menor): precio manual → venta explícita como Pack → promoción específica
 * del producto (`PACK_FIXED_TOTAL`) → promoción de sucursal. NUNCA se acumulan: una línea recibe como máximo UN descuento
 * de estos. Después viene el medio de pago (recargo por tarjeta, D-044) y por último el descuento general del ticket
 * (D-061); esos dos pasos no cambian y viven en `pricing.ts` / `ticket-pricing.ts`.
 *
 * Todo en centavos enteros y basis points, redondeo half-up; el mismo cálculo se replica byte a byte en
 * `app_private.sync_offline_sale_core` (Postgres) e `insert_sale` (Rust/SQLite).
 */

/** Descuento fijo de toda venta como Pack: decisión comercial (20 %). Cambiarlo requiere una decisión explícita. */
export const PACK_DISCOUNT_BPS = 2_000;

/** Un pack tiene que agrupar al menos 2 unidades (1 no es un pack). */
export const MIN_PACK_SIZE_UNITS = 2;

/** Cota superior razonable del tamaño de un pack (sólo para rechazar errores de carga). */
export const MAX_PACK_SIZE_UNITS = 10_000;

/** Promoción vigente de una sucursal para todos sus productos `UNIT`: cada `everyUnits` unidades, `discountBps`. */
export interface BranchUnitPromotion {
  id: string;
  /** Tamaño del grupo (>= 2). */
  everyUnits: number;
  /** Descuento sobre las unidades del grupo, en basis points (1..9999). */
  discountBps: number;
}

export interface UnitPackSale {
  /** Cantidad de packs que se vendió. */
  packCount: number;
  /** Tamaño de la versión vigente del pack al vender (se guarda como snapshot, nunca se relee del producto). */
  packSizeUnits: number;
  /** Id de esa versión (`product_pack_versions`): el servidor valida la venta contra ella. No interviene en el cálculo. */
  packConfigId?: string;
}

export type UnitDiscountKind = "PACK" | "BRANCH_PROMOTION";

export interface UnitDiscountPricing extends SalePricing {
  kind: UnitDiscountKind;
  /** Unidades reales de la línea. */
  quantityUnits: number;
  /** Unidades a las que se aplicó el descuento (todas en un Pack; los grupos completos en la promoción de sucursal). */
  discountedUnits: number;
  /** Porcentaje aplicado, en basis points. */
  discountBps: number;
  /** Importe descontado (= `promotionDiscountCents`). */
  unitDiscountCents: bigint;
}

export function isValidPackSizeUnits(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PACK_SIZE_UNITS && value <= MAX_PACK_SIZE_UNITS;
}

/** Unidades reales de `packCount` packs de `packSizeUnits`. */
export function packRealUnits(packCount: number, packSizeUnits: number): number {
  if (!Number.isSafeInteger(packCount) || packCount <= 0 || !isValidPackSizeUnits(packSizeUnits)) {
    throw new RangeError("Invalid pack quantity or size");
  }
  return packCount * packSizeUnits;
}

/** Unidades que reciben descuento en una línea normal de `quantityUnits`: grupos completos del mismo producto. */
export function promotedUnitsFor(quantityUnits: number, everyUnits: number): number {
  if (!Number.isSafeInteger(quantityUnits) || quantityUnits <= 0) throw new RangeError("Invalid sale quantity");
  if (!Number.isSafeInteger(everyUnits) || everyUnits < 2) throw new RangeError("Invalid promotion group size");
  return Math.floor(quantityUnits / everyUnits) * everyUnits;
}

/** `discountedUnits × lista × bps` half-up: el descuento de la línea, calculado una sola vez sobre el total descontado. */
export function unitDiscountCents(listPriceCents: bigint, discountedUnits: number, discountBps: number): bigint {
  return divideRoundHalfUp(listPriceCents * BigInt(discountedUnits) * BigInt(discountBps), 10_000n);
}

function build(input: {
  kind: UnitDiscountKind;
  listPriceCents: bigint;
  quantityUnits: number;
  discountedUnits: number;
  discountBps: number;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): UnitDiscountPricing {
  const { kind, listPriceCents, quantityUnits, discountedUnits, discountBps, paymentMethod } = input;
  validateBasisPoints(input.cashDiscountBps);
  const surchargeBps = isCardSurchargePaymentMethod(paymentMethod) ? input.cashDiscountBps : 0n;
  const quantity = BigInt(quantityUnits);
  const listSubtotalCents = listPriceCents * quantity;
  const discountCents = unitDiscountCents(listPriceCents, discountedUnits, discountBps);
  const cashSubtotalCents = listSubtotalCents - discountCents;
  if (cashSubtotalCents <= 0n) throw new RangeError("The discount leaves the line at $0");
  // Recargo por tarjeta (D-044): UN solo redondeo sobre el total comercial completo de la línea (descuento ya aplicado),
  // igual que un pack UNIT con remanente.
  const subtotalCents = surchargeBps > 0n ? divideRoundHalfUp(cashSubtotalCents * (10_000n + surchargeBps), 10_000n) : cashSubtotalCents;
  return {
    kind,
    quantityUnits,
    discountedUnits,
    discountBps,
    unitDiscountCents: discountCents,
    listPriceCents,
    // Precios por unidad derivados (promedio de la línea): el importe real es el subtotal, no un precio por unidad.
    cashPriceCents: divideRoundHalfUp(cashSubtotalCents, quantity),
    finalPriceCents: divideRoundHalfUp(subtotalCents, quantity),
    listSubtotalCents,
    cashSubtotalCents,
    subtotalCents,
    cashDiscountBps: surchargeBps,
    cashDiscountCents: 0n,
    cardSurchargeCents: subtotalCents - cashSubtotalCents,
    promotionDiscountCents: discountCents,
    discountCents
  };
}

/**
 * Línea `UNIT` vendida explícitamente como Pack: `packCount × packSizeUnits` unidades reales, todas con 20 % de descuento
 * (sobre el subtotal de lista de la línea), sin promoción específica ni de sucursal.
 */
export function calculateUnitPackLinePricing(input: {
  listPriceCents: bigint;
  pack: UnitPackSale;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): UnitDiscountPricing {
  const { listPriceCents, pack } = input;
  if (listPriceCents <= 0n) throw new RangeError("Invalid sale quantity or price");
  const quantityUnits = packRealUnits(pack.packCount, pack.packSizeUnits);
  return build({ kind: "PACK", listPriceCents, quantityUnits, discountedUnits: quantityUnits, discountBps: PACK_DISCOUNT_BPS, paymentMethod: input.paymentMethod, cashDiscountBps: input.cashDiscountBps });
}

/**
 * Línea `UNIT` normal con la promoción de la sucursal: sólo los grupos completos de `everyUnits` del MISMO producto
 * reciben `discountBps`. Devuelve `null` cuando la cantidad no completa ningún grupo (la línea sigue el cálculo normal).
 */
export function calculateBranchPromotionLinePricing(input: {
  listPriceCents: bigint;
  quantityUnits: number;
  promotion: BranchUnitPromotion;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): UnitDiscountPricing | null {
  const { listPriceCents, quantityUnits, promotion } = input;
  if (listPriceCents <= 0n) throw new RangeError("Invalid sale quantity or price");
  if (!Number.isSafeInteger(promotion.discountBps) || promotion.discountBps < 1 || promotion.discountBps > 9_999) {
    throw new RangeError("Invalid promotion percentage");
  }
  const discountedUnits = promotedUnitsFor(quantityUnits, promotion.everyUnits);
  if (discountedUnits === 0) return null;
  return build({ kind: "BRANCH_PROMOTION", listPriceCents, quantityUnits, discountedUnits, discountBps: promotion.discountBps, paymentMethod: input.paymentMethod, cashDiscountBps: input.cashDiscountBps });
}
