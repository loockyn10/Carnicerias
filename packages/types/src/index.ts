export const SYSTEM_ROLE_KEYS = ["admin", "employee"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const UNIT_TYPES = ["WEIGHT", "UNIT"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export type EntityId = string;

export interface OrganizationSummary {
  id: EntityId;
  name: string;
  slug: string;
  currency: "ARS";
  timezone: string;
}

export interface BranchSummary {
  id: EntityId;
  organizationId: EntityId;
  name: string;
  code: string;
  active: boolean;
}

export interface ProductSummary {
  id: EntityId;
  organizationId: EntityId;
  categoryId: EntityId | null;
  name: string;
  sku: string | null;
  unitType: UnitType;
  active: boolean;
}

export const SALE_STATUSES = ["DRAFT", "COMPLETED", "CANCELLED", "REFUNDED"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_METHODS = ["CASH", "TRANSFER", "DEBIT", "CREDIT", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const STOCK_MOVEMENT_TYPES = [
  "PURCHASE",
  "SALE",
  "WASTE",
  "ADJUSTMENT_POSITIVE",
  "ADJUSTMENT_NEGATIVE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "RETURN"
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export interface PosCatalogProduct {
  organizationId: EntityId;
  branchId: EntityId;
  branchName: string;
  categoryId: EntityId;
  categoryName: string;
  categorySortOrder: number;
  productId: EntityId;
  productName: string;
  productSku: string | null;
  unitType: UnitType;
  pricePerKgCents: bigint;
  originalPricePerKgCents?: bigint;
}

export interface TicketLine {
  id: EntityId;
  productId: EntityId;
  productName: string;
  weightGrams: number;
  pricePerKgCents: bigint;
  originalPricePerKgCents?: bigint;
  discountRuleId?: string | null;
  discountType?: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue?: bigint | null;
  discountCents?: bigint;
  subtotalCents: bigint;
}
