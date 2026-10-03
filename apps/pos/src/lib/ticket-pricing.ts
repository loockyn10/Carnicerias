import {
  calculateBranchPromotionLinePricing,
  calculateManualLinePricing,
  calculateSalePricing,
  calculateTicketDiscount,
  calculateUnitPackLinePricing,
  calculateUnitPackSalePricing,
  calculateWeightPackSalePricing,
  packRealUnits,
  PACK_DISCOUNT_BPS,
  sumMoney,
  type BranchUnitPromotion,
  type TicketDiscount,
  type UnitDiscountPricing,
  type UnitPackSale
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";

/**
 * Pricing de las líneas del ticket del POS. Las funciones `compute*`/`build*` se movieron desde App.tsx
 * sin cambiar su comportamiento (mismo motor: lista -> promoción/pack -> recargo por tarjeta, D-044);
 * este módulo agrega el precio manual por línea y el resumen con descuento general (D-061, sólo Central),
 * y para las líneas UNIT el Pack (20 %) y la promoción global de la sucursal ("cada N unidades").
 * Precedencia de una línea UNIT (nunca se acumulan): precio manual > venta como Pack > promoción específica del
 * producto (PACK_FIXED_TOTAL) > promoción de sucursal. Todo es puro: sin React, SQLite ni red.
 */

export interface DiscountRule {
  id: string;
  productId: string;
  branchId: string | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  minimumGrams: number | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: string | null;
  packQuantityGrams: number | null;
  packQuantityUnits: number | null;
  packPriceCents: string | null;
}

export interface ComputedLine {
  pricing: ReturnType<typeof calculateSalePricing>;
  discountRuleId: string | null;
  discountType: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue: bigint | null;
  promotionMode: "THRESHOLD" | "PACK_FIXED_TOTAL" | null;
  /** Pack (20 %) o promoción de sucursal aplicados a una línea UNIT; null si la línea no recibió ninguno de los dos. */
  unitDiscount?: UnitDiscountPricing | null;
}

/** Contexto de una línea UNIT más allá del producto: la promoción de la sucursal y si se vende como Pack. */
export interface UnitLineOptions {
  /** Promoción global vigente de la sucursal del dispositivo (null/ausente = ninguna). */
  branchPromotion?: BranchUnitPromotion | null;
  /** La línea se cargó explícitamente como Pack: `quantityUnits` ya son las unidades reales (packCount × packSizeUnits). */
  packSale?: UnitPackSale | null;
}

/** WEIGHT pricing: an explicit pack (sellAsPack, WEIGHT never auto-detects a pack — the real
 * weighed grams never land exactly on the nominal pack amount) takes priority; otherwise the
 * usual threshold lookup by weighed grams, unchanged from before packs existed. */
export function computeWeightLine(
  listPriceCents: bigint, weightGrams: number, sellAsPack: boolean, pack: DiscountRule | null,
  discounts: DiscountRule[], productId: string, branchId: string, paymentMethod: PaymentMethod, cashDiscountBps: bigint
): ComputedLine {
  if (sellAsPack && pack?.packPriceCents != null) {
    const pricing = calculateWeightPackSalePricing({
      listPriceCents, weightGrams, paymentMethod, cashDiscountBps, packPriceCents: BigInt(pack.packPriceCents)
    });
    return { pricing, discountRuleId: pack.id, discountType: null, discountValue: null, promotionMode: "PACK_FIXED_TOTAL" };
  }
  const applicableRules = discounts.filter((rule) => rule.promotionMode === "THRESHOLD" && rule.productId === productId && rule.minimumGrams != null)
    .sort((left, right) => (right.minimumGrams ?? 0) - (left.minimumGrams ?? 0) || Number(right.branchId === branchId) - Number(left.branchId === branchId));
  const rule = applicableRules.find((candidate) => (candidate.minimumGrams ?? Infinity) <= weightGrams);
  const promotion = rule?.discountType && rule.discountValue != null ? { id: rule.id, discountType: rule.discountType, discountValue: BigInt(rule.discountValue) } : null;
  const pricing = calculateSalePricing({ listPriceCents, quantity: weightGrams, quantityDivisor: 1_000, paymentMethod, cashDiscountBps, promotion });
  return {
    pricing, discountRuleId: rule?.id ?? null, discountType: rule?.discountType ?? null,
    discountValue: rule?.discountValue != null ? BigInt(rule.discountValue) : null, promotionMode: null
  };
}

/** UNIT pricing: no balanza, no THRESHOLD (WEIGHT-only by design). Precedencia (nunca se acumulan):
 *   1. venta explícita como Pack (`options.packSale`): las unidades reales reciben 20 %; ni la promoción específica
 *      ni la de sucursal se suman;
 *   2. promoción específica del producto (PACK_FIXED_TOTAL): se aplica automáticamente en múltiplos exactos de su
 *      cantidad (sin toggle, a diferencia de WEIGHT: las unidades son exactas), el resto a precio normal;
 *   3. promoción de la sucursal ("cada N unidades, X %"): sólo los grupos completos del MISMO producto;
 *   4. precio normal.
 * (El precio manual está por encima de todo y no pasa por acá: ver `applyManualPrice`.) */
export function computeUnitLine(
  listPriceCents: bigint, quantityUnits: number, pack: DiscountRule | null, paymentMethod: PaymentMethod, cashDiscountBps: bigint,
  options: UnitLineOptions = {}
): ComputedLine {
  if (options.packSale) {
    if (packRealUnits(options.packSale.packCount, options.packSale.packSizeUnits) !== quantityUnits) {
      throw new RangeError("A pack line must hold exactly packCount × packSizeUnits real units");
    }
    const unitDiscount = calculateUnitPackLinePricing({ listPriceCents, pack: options.packSale, paymentMethod, cashDiscountBps });
    return { pricing: unitDiscount, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null, unitDiscount };
  }
  const wholePacks = pack?.packQuantityUnits ? Math.floor(quantityUnits / pack.packQuantityUnits) : 0;
  if (pack?.packQuantityUnits != null && pack.packPriceCents != null && wholePacks >= 1) {
    const pricing = calculateUnitPackSalePricing({
      listPriceCents, quantityUnits, paymentMethod, cashDiscountBps,
      pack: { id: pack.id, packQuantityUnits: pack.packQuantityUnits, packPriceCents: BigInt(pack.packPriceCents) }
    });
    return { pricing, discountRuleId: pack.id, discountType: null, discountValue: null, promotionMode: "PACK_FIXED_TOTAL", unitDiscount: null };
  }
  if (options.branchPromotion) {
    const unitDiscount = calculateBranchPromotionLinePricing({ listPriceCents, quantityUnits, promotion: options.branchPromotion, paymentMethod, cashDiscountBps });
    if (unitDiscount) return { pricing: unitDiscount, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null, unitDiscount };
  }
  const pricing = calculateSalePricing({ listPriceCents, quantity: quantityUnits, quantityDivisor: 1, paymentMethod, cashDiscountBps, promotion: null });
  return { pricing, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null, unitDiscount: null };
}

/** Todos los campos del snapshot de descuento UNIT (Pack / promoción de sucursal), para limpiarlos de una línea. */
const UNIT_DISCOUNT_KEYS = [
  "soldAsPack", "packDiscountBps", "packDiscountCents", "branchPromotionId", "branchPromotionEveryUnits",
  "branchPromotionDiscountBps", "branchPromotionDiscountedUnits", "branchPromotionDiscountCents"
] as const;

/** Quita el Pack y la promoción de sucursal que la línea tenía aplicados (la memoria del modo Pack — packCount y tamaño — se conserva). */
export function stripUnitDiscount(line: TicketLine): TicketLine {
  const dropped = new Set<string>(UNIT_DISCOUNT_KEYS);
  return Object.fromEntries(Object.entries(line).filter(([key]) => !dropped.has(key))) as unknown as TicketLine;
}

/** El snapshot del descuento UNIT aplicado por `computed`, listo para mezclar en la línea. */
function unitDiscountFields(unitDiscount: UnitDiscountPricing | null | undefined, options: UnitLineOptions): Partial<TicketLine> {
  if (!unitDiscount) return {};
  if (unitDiscount.kind === "PACK") {
    return { soldAsPack: true, packDiscountBps: PACK_DISCOUNT_BPS, packDiscountCents: unitDiscount.unitDiscountCents };
  }
  return {
    branchPromotionId: options.branchPromotion?.id ?? "",
    branchPromotionEveryUnits: options.branchPromotion?.everyUnits ?? 0,
    branchPromotionDiscountBps: unitDiscount.discountBps,
    branchPromotionDiscountedUnits: unitDiscount.discountedUnits,
    branchPromotionDiscountCents: unitDiscount.unitDiscountCents
  };
}

/** La memoria del modo Pack de una línea (si la tiene): sirve para reconstruirla al repreciar o quitar un precio manual. */
export function packSaleOf(line: TicketLine): UnitPackSale | null {
  return line.packCount != null && line.packSizeUnitsSnapshot != null
    ? { packCount: line.packCount, packSizeUnits: line.packSizeUnitsSnapshot, ...(line.packConfigId ? { packConfigId: line.packConfigId } : {}) }
    : null;
}

/** The single active PACK_FIXED_TOTAL of a product for this branch (or global), if any. */
export function findPackRule(discounts: DiscountRule[], productId: string, branchId: string): DiscountRule | null {
  return discounts.find((rule) => rule.productId === productId && rule.promotionMode === "PACK_FIXED_TOTAL"
    && (rule.branchId === branchId || rule.branchId === null)) ?? null;
}

/** Los tres campos del catálogo que necesita armar una línea. */
export interface LineProduct { productId: string; productName: string; pricePerKgCents: bigint }

function lineFromComputed(
  product: LineProduct, id: string, quantity: { weightGrams: number; quantityUnits?: number }, computed: ComputedLine
): TicketLine {
  return {
    id, productId: product.productId, productName: product.productName,
    weightGrams: quantity.weightGrams, ...(quantity.quantityUnits != null ? { quantityUnits: quantity.quantityUnits } : {}),
    pricePerKgCents: computed.pricing.finalPriceCents, originalPricePerKgCents: product.pricePerKgCents,
    discountRuleId: computed.discountRuleId, discountType: computed.discountType, discountValue: computed.discountValue,
    promotionMode: computed.promotionMode, discountCents: computed.pricing.discountCents, cashDiscountBps: computed.pricing.cashDiscountBps,
    cashDiscountCents: computed.pricing.cashDiscountCents, cardSurchargeCents: computed.pricing.cardSurchargeCents,
    promotionDiscountCents: computed.pricing.promotionDiscountCents, subtotalCents: computed.pricing.subtotalCents
  };
}

/** A UNIT ticket line for `quantityUnits` REAL units of `product`. Shared by the manual quantity dialog and
 * the barcode scan so both price (packs, promotions, card surcharge) exactly the same way. `options.packSale` marks a line
 * loaded as Pack (then `quantityUnits` = packCount × packSizeUnits); `options.branchPromotion` is the branch's global promotion. */
export function buildUnitTicketLine(
  product: LineProduct, quantityUnits: number, id: string, pack: DiscountRule | null,
  paymentMethod: PaymentMethod, cashDiscountBps: bigint, options: UnitLineOptions = {}
): TicketLine {
  const computed = computeUnitLine(product.pricePerKgCents, quantityUnits, pack, paymentMethod, cashDiscountBps, options);
  const line = lineFromComputed(product, id, { weightGrams: 0, quantityUnits }, computed);
  return {
    ...line,
    ...(options.packSale
      ? {
          packCount: options.packSale.packCount, packSizeUnitsSnapshot: options.packSale.packSizeUnits,
          ...(options.packSale.packConfigId ? { packConfigId: options.packSale.packConfigId } : {})
        }
      : {}),
    ...unitDiscountFields(computed.unitDiscount, options)
  };
}

/**
 * La línea UNIT normal (no manual) a la que se le puede sumar cantidad sin mezclar modos: una por producto y modo. Así
 * "cada N unidades del MISMO producto" cuenta todas las unidades de ese producto del ticket, venga del scanner o de la
 * grilla; una línea Pack y una normal del mismo producto son líneas distintas (el Pack no se acumula con la promoción).
 */
export function findMergeableUnitLine(ticket: readonly TicketLine[], productId: string, packMode: boolean, includeManual = false): TicketLine | undefined {
  return ticket.find((line) => line.productId === productId && line.quantityUnits != null && (includeManual || !line.manualPriceApplied) && (line.packCount != null) === packMode);
}

/** Cómo se lee una línea UNIT en el ticket: la cantidad (con el Pack explícito) y la etiqueta del descuento, si lo hay. */
export function describeUnitLine(line: TicketLine): { quantityLabel: string; badge: string | null } {
  const units = line.quantityUnits ?? 0;
  if (line.packCount != null && line.packSizeUnitsSnapshot != null) {
    const quantityLabel = `${String(line.packCount)} pack${line.packCount === 1 ? "" : "s"} × ${String(line.packSizeUnitsSnapshot)} u = ${String(units)} unidades`;
    return { quantityLabel, badge: line.soldAsPack ? `Pack ${String(PACK_DISCOUNT_BPS / 100)}% OFF` : null };
  }
  if (line.branchPromotionId && line.branchPromotionDiscountedUnits) {
    return {
      quantityLabel: `${String(units)} u`,
      badge: `Promo ${String(line.branchPromotionEveryUnits ?? 0)}×${String((line.branchPromotionDiscountBps ?? 0) / 100)}%: ${String(line.branchPromotionDiscountedUnits)} u con descuento`
    };
  }
  return { quantityLabel: `${String(units)} u`, badge: null };
}

/** A WEIGHT ticket line for `weightGrams` of `product` (pack toggle + threshold promotions included). */
export function buildWeightTicketLine(
  product: LineProduct, weightGrams: number, id: string, sellAsPack: boolean, pack: DiscountRule | null,
  discounts: DiscountRule[], branchId: string, paymentMethod: PaymentMethod, cashDiscountBps: bigint
): TicketLine {
  const computed = computeWeightLine(product.pricePerKgCents, weightGrams, sellAsPack, pack, discounts, product.productId, branchId, paymentMethod, cashDiscountBps);
  const line = lineFromComputed(product, id, { weightGrams }, computed);
  return computed.promotionMode === "PACK_FIXED_TOTAL" ? { ...line, sellAsPack: true } : line;
}

export interface PricingContext {
  paymentMethod: PaymentMethod;
  discounts: DiscountRule[];
  cashDiscountBps: bigint;
  branchId: string;
  /** Promoción global vigente de la sucursal (sólo UNIT); null/ausente = ninguna. */
  branchPromotion?: BranchUnitPromotion | null;
}

/**
 * Recalcula una línea NORMAL para el medio de pago actual (extraído del efecto de App.tsx, mismo
 * comportamiento). Una línea con precio manual no se recalcula nunca: el precio que fijó el operador es
 * la decisión final de esa línea y no depende del medio de pago (D-061).
 */
export function repriceTicketLine(line: TicketLine, context: PricingContext): TicketLine {
  if (line.manualPriceApplied) return line;
  const { paymentMethod: method, discounts, cashDiscountBps } = context;
  const listPriceCents = line.originalPricePerKgCents ?? line.pricePerKgCents;
  let pricing: ReturnType<typeof calculateSalePricing>;
  if (line.quantityUnits != null) {
    // Línea UNIT: si tenía un pack, hay que recalcularlo contra el rule actual —
    // computeUnitLine siempre recalcula desde pack.packPriceCents (el precio fijo real del
    // pack), nunca desde line.subtotalCents, porque ese subtotal puede venir ya recargado por
    // tarjeta de un cálculo anterior con otro método de pago (D-044: el recargo se aplica al
    // total comercial completo, packs incluidos, sin excepción). El Pack del producto (20 %) se recalcula
    // desde el snapshot de la propia línea (packCount × tamaño al venderla), nunca desde el producto actual.
    const pack = line.discountRuleId ? discounts.find((rule) => rule.id === line.discountRuleId) ?? null : null;
    const options: UnitLineOptions = { branchPromotion: context.branchPromotion ?? null, packSale: packSaleOf(line) };
    const computed = computeUnitLine(listPriceCents, line.quantityUnits, pack, method, cashDiscountBps, options);
    return {
      ...stripUnitDiscount(line),
      pricePerKgCents: computed.pricing.finalPriceCents, cashDiscountBps: computed.pricing.cashDiscountBps,
      cashDiscountCents: computed.pricing.cashDiscountCents, cardSurchargeCents: computed.pricing.cardSurchargeCents,
      promotionDiscountCents: computed.pricing.promotionDiscountCents, discountCents: computed.pricing.discountCents,
      subtotalCents: computed.pricing.subtotalCents,
      ...unitDiscountFields(computed.unitDiscount, options)
    };
  } else if (line.promotionMode === "PACK_FIXED_TOTAL" && line.discountRuleId) {
    // Línea pack WEIGHT: no escala con el peso — recalcularla como threshold perdería el
    // pack al cambiar el método de pago. El recargo por tarjeta SÍ se aplica sobre el total
    // del pack (D-044, sin excepción), así que subtotalCents de la línea puede ya venir
    // recargado de un cálculo anterior con otro método de pago — nunca se reutiliza
    // directamente como packPriceCents (eso compondría el recargo). Se busca el precio de
    // pack real y fijo en la regla vigente, igual que ya hace la rama UNIT de arriba.
    const pack = discounts.find((rule) => rule.id === line.discountRuleId && rule.promotionMode === "PACK_FIXED_TOTAL");
    if (!pack?.packPriceCents) return line;
    pricing = calculateWeightPackSalePricing({
      listPriceCents, weightGrams: line.weightGrams, paymentMethod: method,
      cashDiscountBps, packPriceCents: BigInt(pack.packPriceCents)
    });
  } else {
    pricing = calculateSalePricing({
      listPriceCents, quantity: line.weightGrams, quantityDivisor: 1_000, paymentMethod: method, cashDiscountBps,
      promotion: line.discountType && line.discountValue != null && line.discountRuleId
        ? { id: line.discountRuleId, discountType: line.discountType, discountValue: line.discountValue }
        : null
    });
  }
  return { ...line, pricePerKgCents: pricing.finalPriceCents, cashDiscountBps: pricing.cashDiscountBps,
    cashDiscountCents: pricing.cashDiscountCents, cardSurchargeCents: pricing.cardSurchargeCents,
    promotionDiscountCents: pricing.promotionDiscountCents,
    discountCents: pricing.discountCents, subtotalCents: pricing.subtotalCents };
}

/**
 * Fija el precio de ESTA línea de ESTA venta (por kg si es WEIGHT, por unidad si es UNIT). No toca el
 * catálogo (`originalPricePerKgCents` queda como precio normal). La línea pierde toda promoción y todo
 * recargo: el precio manual es la decisión explícita del operador y queda como snapshot auditable.
 * Lanza RangeError si el precio es <= 0 o la línea quedaría en $0.
 */
export function applyManualPrice(line: TicketLine, manualUnitPriceCents: bigint): TicketLine {
  const listPriceCents = line.originalPricePerKgCents;
  if (listPriceCents == null) throw new RangeError("The line has no catalog price to compare against");
  const isUnit = line.quantityUnits != null;
  const pricing = calculateManualLinePricing({
    listPriceCents, manualUnitPriceCents,
    quantity: isUnit ? (line.quantityUnits ?? 0) : line.weightGrams,
    quantityDivisor: isUnit ? 1 : 1_000
  });
  return {
    ...stripUnitDiscount(line),
    pricePerKgCents: manualUnitPriceCents,
    originalPricePerKgCents: listPriceCents,
    discountRuleId: null, discountType: null, discountValue: null, promotionMode: null,
    discountCents: 0n, cashDiscountBps: 0n, cashDiscountCents: 0n, cardSurchargeCents: 0n, promotionDiscountCents: 0n,
    subtotalCents: pricing.subtotalCents,
    manualPriceApplied: true, manualUnitPriceCents, manualAdjustmentCents: pricing.manualAdjustmentCents
  };
}

/** "Usar precio normal": vuelve al motor de siempre (promoción + recargo según el medio de pago actual). */
export function restoreNormalPrice(line: TicketLine, context: PricingContext): TicketLine {
  const listPriceCents = line.originalPricePerKgCents;
  if (listPriceCents == null) return line;
  const product: LineProduct = { productId: line.productId, productName: line.productName, pricePerKgCents: listPriceCents };
  if (line.quantityUnits != null) {
    return buildUnitTicketLine(
      product, line.quantityUnits, line.id, findPackRule(context.discounts, line.productId, context.branchId), context.paymentMethod, context.cashDiscountBps,
      { branchPromotion: context.branchPromotion ?? null, packSale: packSaleOf(line) }
    );
  }
  // Sólo se quita el override de precio: "Vender como pack" (line.sellAsPack, que el precio manual no toca) queda como estaba.
  const sellAsPack = line.sellAsPack === true;
  return buildWeightTicketLine(product, line.weightGrams, line.id, sellAsPack, sellAsPack ? findPackRule(context.discounts, line.productId, context.branchId) : null, context.discounts, context.branchId, context.paymentMethod, context.cashDiscountBps);
}

/**
 * Una línea nueva (cantidad/peso editado, o una unidad más por scanner) reemplaza a la anterior: si la
 * anterior tenía precio manual, el precio manual se conserva sobre la nueva cantidad.
 */
export function carryManualPrice(previous: TicketLine | undefined, next: TicketLine): TicketLine {
  if (!previous?.manualPriceApplied || previous.manualUnitPriceCents == null) return next;
  return applyManualPrice(next, previous.manualUnitPriceCents);
}

export interface TicketSummary extends TicketDiscount {
  /** Alguna línea tiene precio manual (sólo para la UI: el total ya lo incluye). */
  hasManualPrice: boolean;
}

/** Subtotal de líneas -> descuento general -> total a cobrar. Es lo ÚNICO que debe cobrarse y enviarse a Mercado Pago. */
export function summarizeTicket(ticket: readonly TicketLine[], discountBps: bigint): TicketSummary {
  const discount = calculateTicketDiscount(sumMoney(ticket.map((line) => line.subtotalCents)), discountBps);
  return { ...discount, hasManualPrice: ticket.some((line) => line.manualPriceApplied === true) };
}

export interface UnitLineRequest {
  /** Unidades REALES de la línea resultante (en modo Pack: packs × tamaño del pack). */
  units: number;
  packSale: UnitPackSale | null;
  /** Id de la línea que se reemplaza (edición o fusión); "" = línea nueva. */
  lineId: string;
  /** La línea existente a la que se suma lo que se carga (null al editar o si no hay otra del mismo producto y modo). */
  mergedLine: TicketLine | undefined;
}

/**
 * Qué línea UNIT resulta de lo cargado en el modal de cantidad, tanto al agregar desde la grilla/buscador como al modificar
 * una línea ya agregada (mismo modal): agregar suma a la línea del mismo producto y modo, así "cada N unidades" cuenta todas las
 * del producto; modificar reemplaza la línea. `packSizeUnits` es null si el producto no tiene pack (o no es el POS de escritorio):
 * entonces `packMode` se ignora y la cantidad son unidades.
 */
export function resolveUnitLineRequest(input: {
  ticket: readonly TicketLine[]; productId: string; packSizeUnits: number | null; packConfigId: string | null; packMode: boolean; quantity: number; editingLineId: string | null;
}): UnitLineRequest {
  const { packSizeUnits, packConfigId } = input;
  // Sin la versión del pack (el servidor que la envía) no hay Pack: la venta no podría validarse allá.
  const usePack = input.packMode && packSizeUnits != null && packConfigId != null;
  const mergedLine = input.editingLineId ? undefined : findMergeableUnitLine(input.ticket, input.productId, usePack);
  const baseCount = mergedLine ? (usePack ? (mergedLine.packCount ?? 0) : (mergedLine.quantityUnits ?? 0)) : 0;
  const count = baseCount + input.quantity;
  return {
    units: usePack ? count * packSizeUnits : count,
    packSale: usePack ? { packCount: count, packSizeUnits, packConfigId } : null,
    lineId: input.editingLineId ?? mergedLine?.id ?? "",
    mergedLine
  };
}

/**
 * Estado inicial del modal de cantidad: producto nuevo → 1 unidad normal (el escaneo nunca activa el Pack); línea cargada como
 * Pack → se reabre en modo Pack con su cantidad de packs (si el producto todavía tiene pack); línea normal → sus unidades,
 * con la opción Pack disponible para convertirla.
 */
export function unitModalState(line: TicketLine | undefined, packSizeUnits: number | null): { packMode: boolean; quantity: number } {
  if (!line) return { packMode: false, quantity: 1 };
  const keepPack = line.packCount != null && packSizeUnits != null;
  return { packMode: keepPack, quantity: keepPack ? (line.packCount ?? 1) : (line.quantityUnits ?? 1) };
}
