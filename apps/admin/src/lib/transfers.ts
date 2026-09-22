export interface StockTransferItem {
  productId: string;
  productName: string;
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
  totalWeightGrams: number;
  itemCount: number;
  items: StockTransferItem[];
}
