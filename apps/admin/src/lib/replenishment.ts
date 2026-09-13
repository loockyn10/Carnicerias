export type ReplenishmentUnit = "WEIGHT" | "UNIT";
export type ReplenishmentPriority = "CRITICAL" | "HIGH" | "NORMAL";

export interface ReplenishmentInput {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  unitType: ReplenishmentUnit;
  currentQuantity: number;
  minimumQuantity: number;
  manualTargetQuantity: number;
  soldRecentQuantity: number;
  salesDays: number;
  targetCoverageDays: number;
}

export interface ReplenishmentRow extends ReplenishmentInput {
  averageDailyQuantity: number;
  coverageDays: number | null;
  dynamicTargetQuantity: number;
  desiredStockQuantity: number;
  suggestedQuantity: number;
  priority: ReplenishmentPriority;
  needsReplenishment: boolean;
}

function ceilDivide(numerator: number, denominator: number) {
  return Math.floor((numerator + denominator - 1) / denominator);
}

export function calculateReplenishment(input: ReplenishmentInput): ReplenishmentRow {
  const targetDaysHundredths = Math.round(input.targetCoverageDays * 100);
  if (![input.currentQuantity, input.minimumQuantity, input.manualTargetQuantity, input.soldRecentQuantity, input.salesDays, targetDaysHundredths].every(Number.isSafeInteger)
    || input.minimumQuantity < 0 || input.manualTargetQuantity < 0 || input.soldRecentQuantity < 0
    || input.salesDays <= 0 || targetDaysHundredths <= 0) {
    throw new RangeError("Invalid replenishment input");
  }

  const averageDailyQuantity = input.soldRecentQuantity / input.salesDays;
  const coverageDays = input.soldRecentQuantity > 0
    ? Math.max(input.currentQuantity, 0) * input.salesDays / input.soldRecentQuantity
    : null;
  const dynamicTargetQuantity = input.soldRecentQuantity > 0
    ? ceilDivide(input.soldRecentQuantity * targetDaysHundredths, input.salesDays * 100)
    : 0;
  const desiredStockQuantity = Math.max(input.manualTargetQuantity, dynamicTargetQuantity);
  const suggestedQuantity = Math.max(desiredStockQuantity - input.currentQuantity, 0);
  const priority: ReplenishmentPriority = input.currentQuantity <= 0 || (coverageDays !== null && coverageDays < 1)
    ? "CRITICAL"
    : (coverageDays !== null && coverageDays < 2) || input.currentQuantity < input.minimumQuantity
      ? "HIGH"
      : "NORMAL";

  return {
    ...input,
    averageDailyQuantity,
    coverageDays,
    dynamicTargetQuantity,
    desiredStockQuantity,
    suggestedQuantity,
    priority,
    needsReplenishment: suggestedQuantity > 0 || priority !== "NORMAL"
  };
}

export function compareReplenishmentUrgency(left: ReplenishmentRow, right: ReplenishmentRow) {
  const leftOut = left.currentQuantity <= 0 ? 0 : 1;
  const rightOut = right.currentQuantity <= 0 ? 0 : 1;
  if (leftOut !== rightOut) return leftOut - rightOut;
  const leftCoverage = left.coverageDays ?? Number.POSITIVE_INFINITY;
  const rightCoverage = right.coverageDays ?? Number.POSITIVE_INFINITY;
  return leftCoverage - rightCoverage
    || right.suggestedQuantity - left.suggestedQuantity
    || left.productName.localeCompare(right.productName, "es");
}
