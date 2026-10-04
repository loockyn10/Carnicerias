import type { PaymentMethod } from "@carnicerias/types";

import { divideRoundHalfUp, isCardSurchargePaymentMethod, validateBasisPoints, type SalePricing } from "./pricing";

/**
 * Descuentos de productos `UNIT` que no dependen de una promoción cargada por producto:
 *
 *   - **Pack** (`products.pack_size_units` + `products.pack_discount_bps`): una unidad operativa de carga rápida. Vender
 *     "N packs" de un producto con `pack_size_units = S` registra `N × S` unidades REALES (stock, precio y venta trabajan
 *     siempre con unidades reales; el pack no es otra unidad de inventario) y TODAS reciben el descuento PROPIO del producto
 *     (`pack_discount_bps`: Leche A 20 %, Leche B 25 %...). Ambos valores son una versión histórica del pack.
 *   - **Promoción de sucursal** (`branch_promotions`): "DESDE M unidades del MISMO producto, D % de descuento" para todos
 *     los productos `UNIT` de una sucursal. Con M unidades o más, el descuento cae sobre TODAS las unidades de la línea
 *     (no sobre grupos completos): 2 → nada; 3 → las 3; 4 → las 4; 8 → las 8. Se evalúa por producto/línea, nunca sumando
 *     productos distintos.
 *
 * Precedencia (productos UNIT, de mayor a menor): precio manual → venta explícita como Pack (con el % de ese producto) →
 * promoción específica del producto (`PACK_FIXED_TOTAL`) → promoción de sucursal "desde N". NUNCA se acumulan: una línea
 * recibe como máximo UN descuento
 * de estos. Después viene el medio de pago (recargo por tarjeta, D-044) y por último el descuento general del ticket
 * (D-061); esos dos pasos no cambian y viven en `pricing.ts` / `ticket-pricing.ts`.
 *
 * Todo en centavos enteros y basis points, redondeo half-up; el mismo cálculo se replica byte a byte en
 * `app_private.sync_offline_sale_core` (Postgres) e `insert_sale` (Rust/SQLite).
 */

/**
 * Descuento histórico de todo Pack (20 %), de cuando era una constante comercial. Ya NO es una regla: cada producto con pack
 * tiene su propio porcentaje (`products.pack_discount_bps`). Queda sólo como valor sugerido en el Admin y como porcentaje de
 * los packs creados antes de que fuera configurable.
 */
export const DEFAULT_PACK_DISCOUNT_BPS = 2_000;

/** Límites del descuento de un pack, en basis points: `0 < descuento < 100 %` (0,01 % … 99,99 %). */
export const MIN_PACK_DISCOUNT_BPS = 1;
export const MAX_PACK_DISCOUNT_BPS = 9_999;

/** Un pack tiene que agrupar al menos 2 unidades (1 no es un pack). */
export const MIN_PACK_SIZE_UNITS = 2;

/** Cota superior razonable del tamaño de un pack (sólo para rechazar errores de carga). */
export const MAX_PACK_SIZE_UNITS = 10_000;

/** Promoción vigente de una sucursal para todos sus productos `UNIT`: desde `minimumUnits` unidades, `discountBps` sobre toda la línea. */
export interface BranchUnitPromotion {
  id: string;
  /** Cantidad mínima del mismo producto desde la cual aplica (>= 2). Con esa cantidad o más, se descuentan TODAS las unidades. */
  minimumUnits: number;
  /** Descuento sobre todas las unidades de la línea, en basis points (1..9999). */
  discountBps: number;
}

export interface UnitPackSale {
  /** Cantidad de packs que se vendió. */
  packCount: number;
  /** Tamaño de la versión vigente del pack al vender (se guarda como snapshot, nunca se relee del producto). */
  packSizeUnits: number;
  /** Descuento de esa misma versión, en basis points (1..9999): el porcentaje propio del producto al vender. */
  packDiscountBps: number;
  /** Id de esa versión (`product_pack_versions`): el servidor valida la venta contra ella. No interviene en el cálculo. */
  packConfigId?: string;
}

export type UnitDiscountKind = "PACK" | "BRANCH_PROMOTION";

export interface UnitDiscountPricing extends SalePricing {
  kind: UnitDiscountKind;
  /** Unidades reales de la línea. */
  quantityUnits: number;
  /** Unidades a las que se aplicó el descuento (todas las de la línea, tanto en un Pack como en la promoción de sucursal). */
  discountedUnits: number;
  /** Porcentaje aplicado, en basis points. */
  discountBps: number;
  /** Importe descontado (= `promotionDiscountCents`). */
  unitDiscountCents: bigint;
}

export function isValidPackSizeUnits(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PACK_SIZE_UNITS && value <= MAX_PACK_SIZE_UNITS;
}

/** Basis points → porcentaje legible con coma decimal: 2000 → "20", 1250 → "12,5", 2550 → "25,5", 1 → "0,01". */
export function formatBasisPointsPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = Math.abs(basisPoints % 100);
  if (fraction === 0) return String(whole);
  return `${String(whole)},${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

export function isValidPackDiscountBps(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PACK_DISCOUNT_BPS && value <= MAX_PACK_DISCOUNT_BPS;
}

/** Unidades reales de `packCount` packs de `packSizeUnits`. */
export function packRealUnits(packCount: number, packSizeUnits: number): number {
  if (!Number.isSafeInteger(packCount) || packCount <= 0 || !isValidPackSizeUnits(packSizeUnits)) {
    throw new RangeError("Invalid pack quantity or size");
  }
  return packCount * packSizeUnits;
}

/**
 * Unidades que reciben descuento en una línea normal de `quantityUnits` del mismo producto con una promoción "desde
 * `minimumUnits`": TODAS si la línea llega al mínimo, ninguna si no. (Nunca `floor(cantidad / N) × N`: eso era "cada N".)
 */
export function promotedUnitsFor(quantityUnits: number, minimumUnits: number): number {
  if (!Number.isSafeInteger(quantityUnits) || quantityUnits <= 0) throw new RangeError("Invalid sale quantity");
  if (!Number.isSafeInteger(minimumUnits) || minimumUnits < 2) throw new RangeError("Invalid promotion minimum quantity");
  return quantityUnits >= minimumUnits ? quantityUnits : 0;
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
 * Línea `UNIT` vendida explícitamente como Pack: `packCount × packSizeUnits` unidades reales, todas con el descuento de SU
 * versión del pack (`pack.packDiscountBps`, sobre el subtotal de lista de la línea), sin promoción específica ni de sucursal.
 */
export function calculateUnitPackLinePricing(input: {
  listPriceCents: bigint;
  pack: UnitPackSale;
  paymentMethod: PaymentMethod;
  cashDiscountBps: bigint;
}): UnitDiscountPricing {
  const { listPriceCents, pack } = input;
  if (listPriceCents <= 0n) throw new RangeError("Invalid sale quantity or price");
  if (!isValidPackDiscountBps(pack.packDiscountBps)) throw new RangeError("Invalid pack discount percentage");
  const quantityUnits = packRealUnits(pack.packCount, pack.packSizeUnits);
  return build({ kind: "PACK", listPriceCents, quantityUnits, discountedUnits: quantityUnits, discountBps: pack.packDiscountBps, paymentMethod: input.paymentMethod, cashDiscountBps: input.cashDiscountBps });
}

/**
 * Línea `UNIT` normal con la promoción de la sucursal "desde `minimumUnits`": si la línea (un solo producto) llega al mínimo,
 * TODAS sus unidades reciben `discountBps`. Devuelve `null` cuando la cantidad no llega al mínimo (la línea sigue el cálculo
 * normal).
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
  const discountedUnits = promotedUnitsFor(quantityUnits, promotion.minimumUnits);
  if (discountedUnits === 0) return null;
  return build({ kind: "BRANCH_PROMOTION", listPriceCents, quantityUnits, discountedUnits, discountBps: promotion.discountBps, paymentMethod: input.paymentMethod, cashDiscountBps: input.cashDiscountBps });
}
