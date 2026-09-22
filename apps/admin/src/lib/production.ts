export type ProductionBatchStatus = "DRAFT" | "COMPLETED" | "CANCELLED";

export interface ProductionBatchListItem {
  id: string;
  branchId: string;
  branchName: string;
  sourceProductId: string;
  sourceProductName: string;
  status: ProductionBatchStatus;
  createdAt: string;
  completedAt: string | null;
  inputWeightGrams: number;
  inputUnitCount: number | null;
  producedWeightGrams: number;
  wasteGrams: number;
  yieldBps: number | null;
  costTotalCents: number;
  totalSaleValueCents: number | null;
}

export interface ProductionBatchOutputDetail {
  id: string;
  productId: string;
  productName: string;
  outputWeightGrams: number;
  salePricePerKgCents: number | null;
  saleValueCents: number | null;
  allocatedCostCents: number | null;
  allocatedCostPerKgCents: number | null;
  isSnapshot: boolean;
}

export interface ProductionBatchSummary {
  producedWeightGrams: number;
  wasteGrams: number;
  yieldBps: number | null;
  wastePercentageBps: number | null;
  averageCostPerKgCents: number | null;
  totalSaleValueCents: number | null;
  grossMarginCents: number | null;
  marginOverSalesBps: number | null;
  profitabilityOverCostBps: number | null;
  canFinalize: boolean;
  missingPriceProductName: string | null;
}

export interface ProductionBatchDetail {
  batch: {
    id: string;
    branchId: string;
    branchName: string;
    sourceProductId: string;
    sourceProductName: string;
    description: string | null;
    inputWeightGrams: number;
    inputUnitCount: number | null;
    costPerKgCents: number;
    costTotalCents: number;
    status: ProductionBatchStatus;
    notes: string | null;
    createdAt: string;
    createdByName: string;
    completedAt: string | null;
    completedByName: string | null;
    cancelledAt: string | null;
    cancelledByName: string | null;
  };
  outputs: ProductionBatchOutputDetail[];
  summary: ProductionBatchSummary;
}

export interface ProductionYieldSummary {
  sampleSize: number;
  averageYieldBps: number | null;
  averageWastePercentageBps: number | null;
}

export const PRODUCTION_STATUS_LABELS: Record<ProductionBatchStatus, string> = {
  DRAFT: "Borrador",
  COMPLETED: "Finalizado",
  CANCELLED: "Cancelado"
};

/** Formats integer basis points (10000 = 100%) with two decimals, es-AR style. Null when unknown. */
export function formatBps(bps: number | null): string {
  if (bps === null) return "—";
  return `${(bps / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
