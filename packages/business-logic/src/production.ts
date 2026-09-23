import { divideRoundHalfUp } from "./pricing";
import { priceForWeight, sumMoney } from "./measurements";

export interface ProductionOutputWeight {
  productId: string;
  outputWeightGrams: number;
}

/**
 * An output priced for cost allocation, discriminated by how the output product SELLS: WEIGHT
 * (commercial value = price per kg × grams obtained) or UNIT (commercial value = price per unit ×
 * units obtained). A UNIT output still has real physical weight — e.g. 2 arrollados weigh 2.640 kg
 * — and that weight is required here too: it never determines commercial value/cost allocation
 * for a UNIT output (that stays unit count × price per unit), but it DOES feed the batch's
 * merma/rendimiento balance (calculateProducedWeightGrams/buildProductionBatchSummary below sum
 * every output's weight, WEIGHT or UNIT alike). Never confuse this with a product's
 * `approx_weight_grams` (a per-product, purely informational reference) — this is the real
 * measured weight of THIS batch's output.
 */
export type ProductionOutputPricing =
  | { productId: string; unitType: "WEIGHT"; outputWeightGrams: number; salePricePerKgCents: bigint }
  | { productId: string; unitType: "UNIT"; outputWeightGrams: number; outputQuantityUnits: number; salePricePerUnitCents: bigint };

export type ProductionOutputAllocation =
  | {
      productId: string;
      unitType: "WEIGHT";
      outputWeightGrams: number;
      salePricePerKgCents: bigint;
      saleValueCents: bigint;
      allocationBps: bigint;
      allocatedCostCents: bigint;
      allocatedCostPerKgCents: bigint;
    }
  | {
      productId: string;
      unitType: "UNIT";
      outputWeightGrams: number;
      outputQuantityUnits: number;
      salePricePerUnitCents: bigint;
      saleValueCents: bigint;
      allocationBps: bigint;
      allocatedCostCents: bigint;
      allocatedCostPerUnitCents: bigint;
      allocatedCostPerKgCents: bigint;
    };

/** Rounds half up like divideRoundHalfUp, but accepts a negative numerator (a loss). */
function divideRoundHalfUpSigned(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Invalid ratio denominator");
  return numerator < 0n ? -divideRoundHalfUp(-numerator, denominator) : divideRoundHalfUp(numerator, denominator);
}

/** Cost of the source input (media res, etc.) bought at a given price per kilogram. */
export function calculateInputCostCents(costPerKgCents: bigint, inputWeightGrams: number): bigint {
  return priceForWeight(costPerKgCents, inputWeightGrams);
}

/** Sum of every output's weight. Every line must be a positive integer number of grams. */
export function calculateProducedWeightGrams(outputs: readonly ProductionOutputWeight[]): number {
  let total = 0;
  for (const output of outputs) {
    if (!Number.isSafeInteger(output.outputWeightGrams) || output.outputWeightGrams <= 0) {
      throw new RangeError("Every production output needs a positive integer weight in grams");
    }
    total += output.outputWeightGrams;
  }
  return total;
}

/** Waste in grams. Throws when outputs exceed the input, which must block finalizing a batch. */
export function calculateWasteGrams(inputWeightGrams: number, producedWeightGrams: number): number {
  if (producedWeightGrams > inputWeightGrams) {
    throw new RangeError("Los productos obtenidos no pueden superar el peso de entrada");
  }
  return inputWeightGrams - producedWeightGrams;
}

/** Yield = producedWeightGrams / inputWeightGrams, in basis points. Null when the input is 0. */
export function calculateYieldBps(inputWeightGrams: number, producedWeightGrams: number): bigint | null {
  if (inputWeightGrams <= 0) return null;
  return divideRoundHalfUp(BigInt(producedWeightGrams) * 10_000n, BigInt(inputWeightGrams));
}

/** Waste percentage derived as the complement of yield, so both always add up to 100%. */
export function calculateWastePercentageBps(yieldBps: bigint | null): bigint | null {
  return yieldBps === null ? null : 10_000n - yieldBps;
}

/** Average cost per sellable kilogram. A global average; never the true cost of a specific cut. */
export function calculateAverageCostPerKgCents(costTotalCents: bigint, producedWeightGrams: number): bigint | null {
  if (producedWeightGrams <= 0) return null;
  return divideRoundHalfUp(costTotalCents * 1_000n, BigInt(producedWeightGrams));
}

/** Potential sale value of one WEIGHT output at its price snapshot. */
export function calculateOutputSaleValueCents(salePricePerKgCents: bigint, outputWeightGrams: number): bigint {
  return priceForWeight(salePricePerKgCents, outputWeightGrams);
}

/** Potential sale value of one UNIT output at its price snapshot. */
export function calculateOutputSaleValueCentsForUnit(salePricePerUnitCents: bigint, outputQuantityUnits: number): bigint {
  return salePricePerUnitCents * BigInt(outputQuantityUnits);
}

function saleValueCentsForOutput(output: ProductionOutputPricing): bigint {
  return output.unitType === "WEIGHT"
    ? calculateOutputSaleValueCents(output.salePricePerKgCents, output.outputWeightGrams)
    : calculateOutputSaleValueCentsForUnit(output.salePricePerUnitCents, output.outputQuantityUnits);
}

/** Total potential sale value across every output. */
export const calculateTotalSaleValueCents = sumMoney;

/**
 * Throws naming the first output whose product has no valid current sale price (per kg or per
 * unit, whichever applies), so the caller can block finalizing the batch with a clear message
 * instead of allocating cost against a gap.
 */
export function assertOutputsHavePrices(
  outputs: readonly { productName: string; salePriceCents: bigint | null }[]
): void {
  const missing = outputs.find((output) => output.salePriceCents === null || output.salePriceCents <= 0n);
  if (missing) {
    throw new RangeError(`El producto "${missing.productName}" no tiene un precio de venta vigente`);
  }
}

/**
 * Allocates the batch's total cost across outputs by relative sale value (a standard joint-cost
 * technique): each output's share of potential revenue determines its share of cost. This is an
 * assigned/estimated cost, never the true purchase cost of that specific cut. Works the same way
 * whether an output sells by weight or by unit — only how its own sale value is computed differs.
 *
 * Uses a largest-remainder distribution so the allocated costs always sum EXACTLY to
 * costTotalCents; per-output division alone would leak or invent cents through independent
 * rounding.
 */
export function allocateProductionCost(
  costTotalCents: bigint,
  outputs: readonly ProductionOutputPricing[]
): ProductionOutputAllocation[] {
  if (costTotalCents < 0n) throw new RangeError("El costo del lote no puede ser negativo");
  if (outputs.length === 0) throw new RangeError("El lote no tiene productos obtenidos para asignar costo");

  const shares = outputs.map((output, index) => ({
    index,
    saleValueCents: saleValueCentsForOutput(output)
  }));
  const totalSaleValueCents = sumMoney(shares.map((share) => share.saleValueCents));
  if (totalSaleValueCents <= 0n) {
    throw new RangeError("No se puede asignar el costo: el valor potencial de venta total es cero");
  }

  const distribution = shares.map((share) => {
    const numerator = costTotalCents * share.saleValueCents;
    return {
      index: share.index,
      saleValueCents: share.saleValueCents,
      floorCents: numerator / totalSaleValueCents,
      remainder: numerator % totalSaleValueCents
    };
  });

  const allocatedCents = distribution.map((share) => share.floorCents);
  let leftoverCents = costTotalCents - sumMoney(allocatedCents);

  const byRemainderDesc = [...distribution].sort((left, right) => {
    if (right.remainder > left.remainder) return 1;
    if (right.remainder < left.remainder) return -1;
    return left.index - right.index;
  });

  for (const share of byRemainderDesc) {
    if (leftoverCents <= 0n) break;
    allocatedCents[share.index] = (allocatedCents[share.index] ?? 0n) + 1n;
    leftoverCents -= 1n;
  }

  return outputs.map((output, index) => {
    const saleValueCents = distribution[index]?.saleValueCents ?? 0n;
    const allocatedCostCents = allocatedCents[index] ?? 0n;
    const allocationBps = divideRoundHalfUp(saleValueCents * 10_000n, totalSaleValueCents);
    const allocatedCostPerKgCents = divideRoundHalfUp(allocatedCostCents * 1_000n, BigInt(output.outputWeightGrams));
    if (output.unitType === "WEIGHT") {
      return {
        productId: output.productId,
        unitType: "WEIGHT",
        outputWeightGrams: output.outputWeightGrams,
        salePricePerKgCents: output.salePricePerKgCents,
        saleValueCents,
        allocationBps,
        allocatedCostCents,
        allocatedCostPerKgCents
      };
    }
    return {
      productId: output.productId,
      unitType: "UNIT",
      outputWeightGrams: output.outputWeightGrams,
      outputQuantityUnits: output.outputQuantityUnits,
      salePricePerUnitCents: output.salePricePerUnitCents,
      saleValueCents,
      allocationBps,
      allocatedCostCents,
      allocatedCostPerUnitCents: divideRoundHalfUp(allocatedCostCents, BigInt(output.outputQuantityUnits)),
      allocatedCostPerKgCents
    };
  });
}

/** Gross margin in cents. Can be negative when the batch cost exceeds its potential sale value. */
export function calculateGrossMarginCents(totalSaleValueCents: bigint, costTotalCents: bigint): bigint {
  return totalSaleValueCents - costTotalCents;
}

/** Margin over sales = grossMargin / potential sale value. Null when there is no potential sale value. */
export function calculateMarginOverSalesBps(grossMarginCents: bigint, totalSaleValueCents: bigint): bigint | null {
  if (totalSaleValueCents <= 0n) return null;
  return divideRoundHalfUpSigned(grossMarginCents * 10_000n, totalSaleValueCents);
}

/** Profitability over cost = grossMargin / batch cost. Null when the batch has no recorded cost. */
export function calculateProfitabilityOverCostBps(grossMarginCents: bigint, costTotalCents: bigint): bigint | null {
  if (costTotalCents <= 0n) return null;
  return divideRoundHalfUpSigned(grossMarginCents * 10_000n, costTotalCents);
}

export interface ProductionBatchSummary {
  inputWeightGrams: number;
  costTotalCents: bigint;
  producedWeightGrams: number;
  wasteGrams: number;
  yieldBps: bigint | null;
  wastePercentageBps: bigint | null;
  averageCostPerKgCents: bigint | null;
  totalSaleValueCents: bigint;
  grossMarginCents: bigint;
  marginOverSalesBps: bigint | null;
  profitabilityOverCostBps: bigint | null;
}

/**
 * Composes every batch-level figure from its inputs. Pure and safe to call while a batch is
 * still a draft (with zero or partial outputs); it never assigns per-output cost — use
 * allocateProductionCost for that once every output has a price snapshot. `outputs` (for
 * waste/yield) must include EVERY output's real physical weight, WEIGHT or UNIT alike — a UNIT
 * output (e.g. 2 arrollados) still has measured weight and must count toward the batch's physical
 * balance, even though that same weight never determines its commercial value (see
 * ProductionOutputPricing above and docs/DOMAIN_RULES.md, merma). `outputSaleValuesCents` covers
 * every output regardless of kind too, since sale value is always expressed in cents.
 */
export function buildProductionBatchSummary(input: {
  inputWeightGrams: number;
  costTotalCents: bigint;
  outputs: readonly ProductionOutputWeight[];
  outputSaleValuesCents: readonly bigint[];
}): ProductionBatchSummary {
  const producedWeightGrams = calculateProducedWeightGrams(input.outputs);
  const wasteGrams = calculateWasteGrams(input.inputWeightGrams, producedWeightGrams);
  const yieldBps = calculateYieldBps(input.inputWeightGrams, producedWeightGrams);
  const totalSaleValueCents = calculateTotalSaleValueCents(input.outputSaleValuesCents);
  const grossMarginCents = calculateGrossMarginCents(totalSaleValueCents, input.costTotalCents);
  return {
    inputWeightGrams: input.inputWeightGrams,
    costTotalCents: input.costTotalCents,
    producedWeightGrams,
    wasteGrams,
    yieldBps,
    wastePercentageBps: calculateWastePercentageBps(yieldBps),
    averageCostPerKgCents: calculateAverageCostPerKgCents(input.costTotalCents, producedWeightGrams),
    totalSaleValueCents,
    grossMarginCents,
    marginOverSalesBps: calculateMarginOverSalesBps(grossMarginCents, totalSaleValueCents),
    profitabilityOverCostBps: calculateProfitabilityOverCostBps(grossMarginCents, input.costTotalCents)
  };
}
