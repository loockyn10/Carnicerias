import {
  calculateManualLinePricing,
  calculateSalePricing,
  calculateTicketDiscount,
  calculateUnitPackSalePricing,
  calculateWeightPackSalePricing,
  sumMoney,
  type TicketDiscount
} from "@carnicerias/business-logic";
import type { PaymentMethod, TicketLine } from "@carnicerias/types";

/**
 * Pricing de las líneas del ticket del POS. Las funciones `compute*`/`build*` se movieron desde App.tsx
 * sin cambiar su comportamiento (mismo motor: lista -> promoción/pack -> recargo por tarjeta, D-044);
 * este módulo agrega el precio manual por línea y el resumen con descuento general (D-061, sólo Central).
 * Todo es puro: sin React, SQLite ni red.
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

/** UNIT pricing: no balanza, no THRESHOLD (WEIGHT-only by design) — a pack applies automatically
 * on exact multiples of its quantity (no manual toggle, unlike WEIGHT: unit counts are exact, no
 * scale variance to worry about), with any remainder at the normal cash price. */
export function computeUnitLine(
  listPriceCents: bigint, quantityUnits: number, pack: DiscountRule | null, paymentMethod: PaymentMethod, cashDiscountBps: bigint
): ComputedLine {
  const wholePacks = pack?.packQuantityUnits ? Math.floor(quantityUnits / pack.packQuantityUnits) : 0;
  if (pack?.packQuantityUnits != null && pack.packPriceCents != null && wholePacks >= 1) {
    const pricing = calculateUnitPackSalePricing({
      listPriceCents, quantityUnits, paymentMethod, cashDiscountBps,
      pack: { id: pack.id, packQuantityUnits: pack.packQuantityUnits, packPriceCents: BigInt(pack.packPriceCents) }
    });
    return { pricing, discountRuleId: pack.id, discountType: null, discountValue: null, promotionMode: "PACK_FIXED_TOTAL" };
  }
  const pricing = calculateSalePricing({ listPriceCents, quantity: quantityUnits, quantityDivisor: 1, paymentMethod, cashDiscountBps, promotion: null });
  return { pricing, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null };
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

/** A UNIT ticket line for `quantityUnits` of `product`. Shared by the manual quantity dialog and
 * the barcode scan so both price (packs, card surcharge) exactly the same way. */
export function buildUnitTicketLine(
  product: LineProduct, quantityUnits: number, id: string, pack: DiscountRule | null,
  paymentMethod: PaymentMethod, cashDiscountBps: bigint
): TicketLine {
  return lineFromComputed(product, id, { weightGrams: 0, quantityUnits }, computeUnitLine(product.pricePerKgCents, quantityUnits, pack, paymentMethod, cashDiscountBps));
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
    // total comercial completo, packs incluidos, sin excepción).
    const pack = line.discountRuleId ? discounts.find((rule) => rule.id === line.discountRuleId) ?? null : null;
    pricing = computeUnitLine(listPriceCents, line.quantityUnits, pack, method, cashDiscountBps).pricing;
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
    ...line,
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
    return buildUnitTicketLine(product, line.quantityUnits, line.id, findPackRule(context.discounts, line.productId, context.branchId), context.paymentMethod, context.cashDiscountBps);
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
