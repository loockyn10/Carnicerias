export type AnalyticsSort = "profit" | "profitability" | "revenue" | "quantity" | "unitProfit";
export type AnalyticsUnit = "WEIGHT" | "UNIT";

export interface AnalyticsSummary {
  revenueCents: number;
  costedRevenueCents: number;
  costCents: number;
  grossProfitCents: number;
  profitabilityBps: number | null;
  coverageBps: number;
  missingCostItems: number;
  weightGrams: number;
  unitCount: number;
}

export interface ProductAnalytics {
  productId: string;
  productName: string;
  unitType: AnalyticsUnit;
  categoryId: string;
  categoryName: string;
  quantity: number;
  revenueCents: number;
  costCents: number | null;
  grossProfitCents: number | null;
  profitabilityBps: number | null;
  profitPerMeasureCents: number | null;
  missingCostItems: number;
}

export interface ProductAnalyticsDetail {
  productId: string;
  productName: string;
  unitType: AnalyticsUnit;
  categoryName: string;
  summary: Pick<ProductAnalytics, "quantity" | "revenueCents" | "costCents" | "grossProfitCents" | "profitabilityBps" | "profitPerMeasureCents" | "missingCostItems">;
  branches: { branchId: string; branchName: string; quantity: number; revenueCents: number; costCents: number | null; grossProfitCents: number | null; profitabilityBps: number | null; missingCostItems: number }[];
  evolution: { date: string; quantity: number; revenueCents: number; grossProfitCents: number | null; missingCostItems: number }[];
}

export interface ProfitabilityAnalytics {
  timezone: string;
  period: { preset: string; from: string; to: string; startAt: string; endAt: string };
  previousPeriod: { from: string; to: string };
  branches: { id: string; name: string }[];
  categoryOptions: { id: string; name: string }[];
  summary: AnalyticsSummary;
  previousSummary: Pick<AnalyticsSummary, "revenueCents" | "costedRevenueCents" | "costCents" | "grossProfitCents" | "coverageBps">;
  products: ProductAnalytics[];
  categories: { categoryId: string; categoryName: string; revenueCents: number; costCents: number | null; grossProfitCents: number | null; missingCostItems: number }[];
  detail: ProductAnalyticsDetail | null;
}

export function comparisonBps(current: number, previous: number) {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(previous) || previous === 0) return null;
  const numerator = BigInt(current - previous) * 10_000n;
  const denominator = BigInt(Math.abs(previous));
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const rounded = (absoluteNumerator + denominator / 2n) / denominator;
  const signed = numerator < 0n ? -rounded : rounded;
  return signed <= BigInt(Number.MAX_SAFE_INTEGER) && signed >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(signed) : null;
}

export function sortProductAnalytics(rows: ProductAnalytics[], sort: AnalyticsSort) {
  const value = (row: ProductAnalytics) => {
    if (sort === "profit") return row.grossProfitCents;
    if (sort === "profitability") return row.profitabilityBps;
    if (sort === "revenue") return row.revenueCents;
    if (sort === "quantity") return row.quantity;
    return row.profitPerMeasureCents;
  };
  return [...rows].sort((left, right) => {
    const leftValue = value(left);
    const rightValue = value(right);
    if (leftValue === null) return rightValue === null ? left.productName.localeCompare(right.productName, "es") : 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue || left.productName.localeCompare(right.productName, "es");
  });
}

export function formatBps(value: number | null, signed = false) {
  if (value === null || !Number.isFinite(value)) return "No disponible";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${(value / 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })}%`;
}
