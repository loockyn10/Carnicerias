export interface StockTransferItem {
  productId: string;
  productName: string;
  unitType: "WEIGHT" | "UNIT";
  /** Raw ledger quantity: grams for a WEIGHT product, whole units for a UNIT product. */
  quantityGrams: number;
}

export interface StockTransfer {
  id: string;
  sourceBranchId: string;
  sourceBranchName: string;
  destinationBranchId: string;
  destinationBranchName: string;
  notes: string | null;
  createdAt: string;
  createdByName: string;
  /** Sum of the WEIGHT items only (grams). Units are never added to it. */
  totalWeightGrams: number;
  /** Sum of the UNIT items only (whole units). */
  totalUnits: number;
  itemCount: number;
  items: StockTransferItem[];
}
