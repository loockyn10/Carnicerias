import {
  calculateBranchPromotionLinePricing,
  calculateManualLinePricing,
  calculateQuantityTierLinePricing,
  calculateSalePricing,
  calculateTicketDiscount,
  calculateUnitPackLinePricing,
  calculateUnitPackSalePricing,
  calculateWeightPackSalePricing,
  divideRoundHalfUp,
  packDiscountLabel,
  formatCurrency,
  isValidPackDiscountBps,
  packRealUnits,
  selectQuantityTier,
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
 * y para las líneas UNIT el Pack (con el % propio de cada producto) y el descuento general por cantidad de la sucursal (escalones
 * "desde N unidades, X %", sobre TODA la línea; se aplica el MAYOR escalón alcanzado, D-083). Precedencia de una línea UNIT (nunca se acumulan):
 * precio manual > venta como Pack > promoción específica del producto (PACK_FIXED_TOTAL) > descuento por cantidad de la sucursal. Todo es puro: sin React, SQLite ni red.
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
  /** Pack (con el % de su producto) o promoción de sucursal aplicados a una línea UNIT; null si la línea no recibió ninguno de los dos. */
  unitDiscount?: UnitDiscountPricing | null;
}

/** Contexto de una línea UNIT más allá del producto: la promoción de la sucursal y si se vende como Pack. */
export interface UnitLineOptions {
  /** Escalones vigentes del descuento por cantidad de la sucursal del dispositivo (ausente/vacío = ninguno). Se aplica el mayor alcanzado por la línea. */
  branchPromotions?: readonly BranchUnitPromotion[];
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
 *   1. venta explícita como Pack (`options.packSale`): las unidades reales reciben el % de la versión del pack de ese
 *      producto; ni la promoción específica ni la de sucursal se suman;
 *   2. promoción específica del producto (PACK_FIXED_TOTAL): se aplica automáticamente en múltiplos exactos de su
 *      cantidad (sin toggle, a diferencia de WEIGHT: las unidades son exactas), el resto a precio normal;
 *   3. descuento por cantidad de la sucursal (escalones "desde N unidades, X %"): con N o más unidades del MISMO producto, TODAS las de la
 *      línea llevan el % del MAYOR escalón alcanzado (nunca se suman los escalones);
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
  if (options.branchPromotions?.length) {
    const unitDiscount = calculateQuantityTierLinePricing({ listPriceCents, quantityUnits, tiers: options.branchPromotions, paymentMethod, cashDiscountBps });
    if (unitDiscount) return { pricing: unitDiscount, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null, unitDiscount };
  }
  const pricing = calculateSalePricing({ listPriceCents, quantity: quantityUnits, quantityDivisor: 1, paymentMethod, cashDiscountBps, promotion: null });
  return { pricing, discountRuleId: null, discountType: null, discountValue: null, promotionMode: null, unitDiscount: null };
}

/** Todos los campos del snapshot de descuento UNIT (Pack / promoción de sucursal), para limpiarlos de una línea. */
const UNIT_DISCOUNT_KEYS = [
  "soldAsPack", "packDiscountCents", "branchPromotionId", "branchPromotionMinimumUnits",
  "branchPromotionDiscountBps", "branchPromotionDiscountedUnits", "branchPromotionDiscountCents"
] as const;

/** Quita el Pack y la promoción de sucursal que la línea tenía aplicados (la memoria del modo Pack — packCount, tamaño, versión y su
 * porcentaje `packDiscountBps` — se conserva). */
export function stripUnitDiscount(line: TicketLine): TicketLine {
  const dropped = new Set<string>(UNIT_DISCOUNT_KEYS);
  return Object.fromEntries(Object.entries(line).filter(([key]) => !dropped.has(key))) as unknown as TicketLine;
}

/** El snapshot del descuento UNIT aplicado por `computed`, listo para mezclar en la línea. */
function unitDiscountFields(unitDiscount: UnitDiscountPricing | null | undefined): Partial<TicketLine> {
  if (!unitDiscount) return {};
  if (unitDiscount.kind === "PACK") {
    return { soldAsPack: true, packDiscountBps: unitDiscount.discountBps, packDiscountCents: unitDiscount.unitDiscountCents };
  }
  return {
    // El escalón realmente aplicado (el motor lo devuelve): es el snapshot que valida el servidor contra SU regla.
    branchPromotionId: unitDiscount.promotionId ?? "",
    branchPromotionMinimumUnits: unitDiscount.promotionMinimumUnits ?? 0,
    branchPromotionDiscountBps: unitDiscount.discountBps,
    branchPromotionDiscountedUnits: unitDiscount.discountedUnits,
    branchPromotionDiscountCents: unitDiscount.unitDiscountCents
  };
}

/** La memoria del modo Pack de una línea (si la tiene): sirve para reconstruirla al repreciar o quitar un precio manual. */
export function packSaleOf(line: TicketLine): UnitPackSale | null {
  return line.packCount != null && line.packSizeUnitsSnapshot != null && isValidPackDiscountBps(line.packDiscountBps)
    ? {
        packCount: line.packCount, packSizeUnits: line.packSizeUnitsSnapshot, packDiscountBps: line.packDiscountBps,
        ...(line.packConfigId ? { packConfigId: line.packConfigId } : {})
      }
    : null;
}

/** The single active PACK_FIXED_TOTAL of a product for this branch (or global), if any. */
export function findPackRule(discounts: DiscountRule[], productId: string, branchId: string): DiscountRule | null {
  return discounts.find((rule) => rule.productId === productId && rule.promotionMode === "PACK_FIXED_TOTAL"
    && (rule.branchId === branchId || rule.branchId === null)) ?? null;
}

/** El Pack que un producto ofrece hoy: tamaño, descuento y versión (los tres viajan juntos desde el catálogo sincronizado). */
export interface PackOffer { packSizeUnits: number; packDiscountBps: number; packConfigId: string }

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
 * loaded as Pack (then `quantityUnits` = packCount × packSizeUnits); `options.branchPromotions` are the branch's quantity-discount tiers. */
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
          packCount: options.packSale.packCount, packSizeUnitsSnapshot: options.packSale.packSizeUnits, packDiscountBps: options.packSale.packDiscountBps,
          ...(options.packSale.packConfigId ? { packConfigId: options.packSale.packConfigId } : {})
        }
      : {}),
    ...unitDiscountFields(computed.unitDiscount)
  };
}

/**
 * La línea UNIT normal (no manual) a la que se le puede sumar cantidad sin mezclar modos: una por producto y modo. Así
 * "desde N unidades del MISMO producto" cuenta todas las unidades de ese producto del ticket, venga del scanner o de la
 * grilla; una línea Pack y una normal del mismo producto son líneas distintas (el Pack no se acumula con la promoción).
 */
export function findMergeableUnitLine(ticket: readonly TicketLine[], productId: string, packMode: boolean, includeManual = false): TicketLine | undefined {
  return ticket.find((line) => line.productId === productId && line.quantityUnits != null && (includeManual || !line.manualPriceApplied) && (line.packCount != null) === packMode);
}

/** La línea UNIT a la que se suma cantidad ahora que el Pack es automático (depende de las unidades, no de un modo): la normal del producto o,
 * si sólo hay una línea Pack (p. ej. 10 u), esa. Al sumar se recalcula todo desde las unidades totales (9 + 1 → Pack; 10 + 1 → ya no). */
export function findUnitLineToMerge(ticket: readonly TicketLine[], productId: string, includeManual = false): TicketLine | undefined {
  return findMergeableUnitLine(ticket, productId, false, includeManual) ?? findMergeableUnitLine(ticket, productId, true);
}

/** Cómo se lee una línea UNIT en el ticket: la cantidad (con el Pack explícito) y la etiqueta del Pack, si lo hay. La promoción de
 * sucursal no lleva etiqueta: su ahorro ya se lee en el precio por unidad final (`finalPricePerUnitCents`). */
export function describeUnitLine(line: TicketLine): { quantityLabel: string; badge: string | null } {
  const units = line.quantityUnits ?? 0;
  if (line.packCount != null && line.packSizeUnitsSnapshot != null) {
    const quantityLabel = `${String(line.packCount)} pack${line.packCount === 1 ? "" : "s"} × ${String(line.packSizeUnitsSnapshot)} u = ${String(units)} unidades`;
    return { quantityLabel, badge: line.soldAsPack ? `Pack ${packDiscountLabel(line.packDiscountBps ?? 0)}` : null };
  }
  return { quantityLabel: `${String(units)} u`, badge: null };
}

/** Precio base que la card ya muestra de una línea: el manual si lo hay, si no el de lista. */
function shownBasePriceCents(line: TicketLine): bigint {
  return line.manualPriceApplied ? line.pricePerKgCents : line.originalPricePerKgCents ?? line.pricePerKgCents;
}

/**
 * Precio efectivo por kg de una línea WEIGHT: lo que realmente se cobra (`subtotalCents`, ya resuelto por el motor:
 * promoción, pack, precio manual, recargo) dividido el peso real, en centavos enteros con redondeo half-up (sin floats).
 * Sólo informa: nunca se usa para cobrar. Null si la línea no es WEIGHT, no tiene peso, o el resultado coincide con el
 * precio base/kg que ya se muestra (no se duplica el mismo precio).
 */
export function finalPricePerKgCents(line: TicketLine): bigint | null {
  if (line.quantityUnits != null || line.weightGrams <= 0) return null;
  const grams = BigInt(line.weightGrams);
  const perKg = (line.subtotalCents * 2_000n + grams) / (2n * grams);
  return perKg === shownBasePriceCents(line) ? null : perKg;
}

/**
 * Precio efectivo por unidad de una línea UNIT: el mismo concepto que `finalPricePerKgCents`. `subtotalCents` (el total real de la
 * línea que ya resolvió el motor: promoción de sucursal, Pack, promoción por producto, precio manual, recargo) dividido las
 * unidades reales, con el mismo redondeo half-up del motor y sin floats. Sólo informa: nunca se usa para cobrar. Null si la línea
 * no es UNIT, no tiene unidades, o coincide con el precio base/u que ya se muestra (no se duplica el mismo precio).
 */
export function finalPricePerUnitCents(line: TicketLine): bigint | null {
  const units = line.quantityUnits ?? 0;
  if (units <= 0) return null;
  const perUnit = effectiveUnitPriceCents(line.subtotalCents, units);
  return perUnit === shownBasePriceCents(line) ? null : perUnit;
}

/** Precio efectivo por unidad: el total real de la línea (el que se cobra) dividido las unidades, en centavos enteros half-up (sin floats). */
export function effectiveUnitPriceCents(subtotalCents: bigint, units: number): bigint {
  return divideRoundHalfUp(subtotalCents, BigInt(units));
}

/**
 * Precio por unidad que paga un cliente que lleva 1 pack del producto (efectivo, sin recargo = el precio de lista que muestra el catálogo),
 * calculado por el motor del Pack (`calculateUnitPackLinePricing`): el mismo redondeo que la venta. Null si no hay pack o no baja el precio.
 */
export function packOfferUnitPriceCents(listPriceCents: bigint, offer: PackOffer | null): bigint | null {
  if (!offer || listPriceCents <= 0n) return null;
  try {
    const pricing = calculateUnitPackLinePricing({
      listPriceCents, pack: { packCount: 1, packSizeUnits: offer.packSizeUnits, packDiscountBps: offer.packDiscountBps }, paymentMethod: "CASH", cashDiscountBps: 0n
    });
    const perUnit = effectiveUnitPriceCents(pricing.subtotalCents, pricing.quantityUnits);
    return perUnit < listPriceCents ? perUnit : null;
  } catch {
    return null;
  }
}

/** "Pack 10 u · 25% OFF · $ 1.237,50/u": la etiqueta del Pack en el catálogo (lista Central y grilla). */
export function packOfferLabel(listPriceCents: bigint, offer: PackOffer): string {
  const perUnit = packOfferUnitPriceCents(listPriceCents, offer);
  return `Pack ${String(offer.packSizeUnits)} u · ${packDiscountLabel(offer.packDiscountBps)}${perUnit === null ? "" : ` · ${formatCurrency(perUnit)}/u`}`;
}

/**
 * Pack automático: una línea UNIT de `units` unidades reales se vende como Pack cuando el motor existente lo admite, sin que el operador lo
 * elija. Un Pack es `packCount × packSizeUnits` unidades exactas (`calculateUnitPackLinePricing`), así que sólo califican los múltiplos exactos
 * del tamaño del pack (10, 20, ...); 11 o 19 unidades siguen el descuento por cantidad. Para no cobrarle de más al cliente, el Pack sólo se
 * aplica si su porcentaje supera al del escalón por cantidad que le tocaría a esas unidades (el Pack es mutuamente excluyente con él).
 * Sin versión del pack (`packConfigId` vacío), con % inválido o en 0 % no hay Pack.
 */
export function autoPackSale(units: number, offer: PackOffer | null, tiers: readonly BranchUnitPromotion[] = []): UnitPackSale | null {
  if (!offer || offer.packConfigId === "" || !isValidPackDiscountBps(offer.packDiscountBps) || offer.packDiscountBps <= 0) return null;
  if (!Number.isSafeInteger(units) || offer.packSizeUnits < 2 || units < offer.packSizeUnits || units % offer.packSizeUnits !== 0) return null;
  const tierBps = tiers.length ? selectQuantityTier(tiers, units)?.discountBps ?? 0 : 0;
  if (offer.packDiscountBps <= tierBps) return null;
  return { packCount: units / offer.packSizeUnits, packSizeUnits: offer.packSizeUnits, packDiscountBps: offer.packDiscountBps, packConfigId: offer.packConfigId };
}

/**
 * Precio por unidad que paga un cliente que lleva `promotion.minimumUnits` de un producto UNIT (la pregunta "¿en cuánto me queda
 * llevando 3?"), ANTES de vender. Reusa el motor (`calculateBranchPromotionLinePricing`, efectivo/sin recargo = el precio de lista
 * que muestra el catálogo), así que redondea igual que la venta. Null si el precio no tiene sentido o la promoción no baja el precio.
 */
export function promotedUnitPriceCents(listPriceCents: bigint, promotion: BranchUnitPromotion): bigint | null {
  if (listPriceCents <= 0n) return null;
  try {
    const pricing = calculateBranchPromotionLinePricing({ listPriceCents, quantityUnits: promotion.minimumUnits, promotion, paymentMethod: "CASH", cashDiscountBps: 0n });
    return pricing && pricing.finalPriceCents < listPriceCents ? pricing.finalPriceCents : null;
  } catch {
    return null;
  }
}

/**
 * "$4.590/u desde 3 u · $4.320/u desde 5 u": etiqueta del descuento por cantidad de un producto UNIT en el catálogo (lista Central y grilla), un
 * tramo por escalón. Null si no hay escalones, el producto no tiene precio o ningún escalón le llega: con una promoción por producto
 * `PACK_FIXED_TOTAL` cuyo pack cabe en el mínimo del escalón, la línea usa ese pack (precedencia de `computeUnitLine`) y el precio del
 * escalón no se aplicaría.
 */
export function unitPromotionLabel(listPriceCents: bigint, promotions: readonly BranchUnitPromotion[] | null | undefined, packRule: DiscountRule | null = null): string | null {
  if (!promotions?.length) return null;
  const parts = [...promotions].sort((left, right) => left.minimumUnits - right.minimumUnits).flatMap((promotion) => {
    if (packRule?.packQuantityUnits != null && packRule.packQuantityUnits <= promotion.minimumUnits) return [];
    const price = promotedUnitPriceCents(listPriceCents, promotion);
    return price === null ? [] : [`${formatCurrency(price)}/u desde ${String(promotion.minimumUnits)} u`];
  });
  return parts.length ? parts.join(" · ") : null;
}

/** El escalón que recibiría una línea de `quantityUnits` (el mayor alcanzado) o null; para mostrar «llevando N o más» en el diálogo de cantidad. */
export function appliedQuantityTier(promotions: readonly BranchUnitPromotion[], quantityUnits: number): BranchUnitPromotion | null {
  return Number.isSafeInteger(quantityUnits) && quantityUnits > 0 ? selectQuantityTier(promotions, quantityUnits) : null;
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
  /** Escalones vigentes del descuento por cantidad de la sucursal (sólo UNIT); ausente/vacío = ninguno. */
  branchPromotions?: readonly BranchUnitPromotion[];
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
    // total comercial completo, packs incluidos, sin excepción). El Pack del producto (con su %) se recalcula
    // desde el snapshot de la propia línea (packCount × tamaño al venderla), nunca desde el producto actual.
    const pack = line.discountRuleId ? discounts.find((rule) => rule.id === line.discountRuleId) ?? null : null;
    const options: UnitLineOptions = { branchPromotions: context.branchPromotions ?? [], packSale: packSaleOf(line) };
    const computed = computeUnitLine(listPriceCents, line.quantityUnits, pack, method, cashDiscountBps, options);
    return {
      ...stripUnitDiscount(line),
      pricePerKgCents: computed.pricing.finalPriceCents, cashDiscountBps: computed.pricing.cashDiscountBps,
      cashDiscountCents: computed.pricing.cashDiscountCents, cardSurchargeCents: computed.pricing.cardSurchargeCents,
      promotionDiscountCents: computed.pricing.promotionDiscountCents, discountCents: computed.pricing.discountCents,
      subtotalCents: computed.pricing.subtotalCents,
      ...unitDiscountFields(computed.unitDiscount)
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
      { branchPromotions: context.branchPromotions ?? [], packSale: packSaleOf(line) }
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
  /** Unidades REALES de la línea resultante. */
  units: number;
  /** El Pack que corresponde automáticamente a esas unidades (null = línea normal). */
  packSale: UnitPackSale | null;
  /** Id de la línea que se reemplaza (edición o fusión); "" = línea nueva. */
  lineId: string;
  /** La línea existente a la que se suma lo que se carga (null al editar o si no hay otra del mismo producto). */
  mergedLine: TicketLine | undefined;
}

/**
 * Qué línea UNIT resulta de lo cargado en el modal de cantidad, tanto al agregar desde la grilla/buscador como al modificar
 * una línea ya agregada (mismo modal): agregar suma a la línea del producto, así "desde N unidades" cuenta todas las del producto;
 * modificar reemplaza la línea. La cantidad siempre son unidades reales y el Pack se decide solo (`autoPackSale`): `packOffer` es null
 * si el producto no tiene pack (o no es el POS de escritorio, o falta la versión que respalda la venta en el servidor).
 */
export function resolveUnitLineRequest(input: {
  ticket: readonly TicketLine[]; productId: string; packOffer: PackOffer | null; quantity: number; editingLineId: string | null;
  branchPromotions?: readonly BranchUnitPromotion[];
}): UnitLineRequest {
  const mergedLine = input.editingLineId ? undefined : findUnitLineToMerge(input.ticket, input.productId);
  const units = (mergedLine?.quantityUnits ?? 0) + input.quantity;
  return {
    units,
    packSale: autoPackSale(units, input.packOffer, input.branchPromotions),
    lineId: input.editingLineId ?? mergedLine?.id ?? "",
    mergedLine
  };
}

/** Cantidad inicial del modal: producto nuevo → 1 unidad; línea ya cargada (normal o Pack) → sus unidades reales. */
export function unitModalQuantity(line: TicketLine | undefined): number {
  return line?.quantityUnits ?? 1;
}
