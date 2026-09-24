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

export const PRODUCTION_BATCH_STATUSES = ["DRAFT", "COMPLETED", "CANCELLED"] as const;
export type ProductionBatchStatus = (typeof PRODUCTION_BATCH_STATUSES)[number];

export const PRODUCT_INVENTORY_ROLES = ["RAW_MATERIAL", "SELLABLE", "BOTH"] as const;
export type ProductInventoryRole = (typeof PRODUCT_INVENTORY_ROLES)[number];

export const STOCK_MOVEMENT_TYPES = [
  "PURCHASE",
  "SALE",
  "WASTE",
  "ADJUSTMENT_POSITIVE",
  "ADJUSTMENT_NEGATIVE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "RETURN",
  "PRODUCTION_CONSUME",
  "PRODUCTION_YIELD"
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export interface PosCatalogProduct {
  organizationId: EntityId;
  branchId: EntityId;
  branchName: string;
  categoryId: EntityId;
  categoryName: string;
  categoryColorHex: string | null;
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
  /** 0 for a UNIT line (see quantityUnits) — never used to represent a real UNIT quantity, so the
   * ticket's total weight stays a pure weight tally unaffected by UNIT lines. */
  weightGrams: number;
  /** Set only for a UNIT line (a WEIGHT line never has this). No balanza/weight input involved —
   * this is an integer count the operator types/steps through. */
  quantityUnits?: number;
  /** Reused generically as "price per kg" (WEIGHT) or "price per unit" (UNIT) — same convention
   * product_prices.price_cents already uses, see docs/ARCHITECTURE.md "Precio e historia". */
  pricePerKgCents: bigint;
  originalPricePerKgCents?: bigint;
  discountRuleId?: string | null;
  discountType?: "PERCENTAGE" | "FIXED_PRICE_PER_KG" | null;
  discountValue?: bigint | null;
  /** Set to "PACK_FIXED_TOTAL" when this line was sold as a pack (fixed total price for the whole
   * line, independent of the real weighed grams — see calculateWeightPackSalePricing). Absent/null
   * for a normal or threshold-discounted line. */
  promotionMode?: "THRESHOLD" | "PACK_FIXED_TOTAL" | null;
  discountCents?: bigint;
  /** Kept under its legacy name (see D-044): configures the card SURCHARGE percentage now, not a
   * cash discount. CASH/TRANSFER/OTHER get no adjustment at all; DEBIT/CREDIT pay list price plus
   * this bps. */
  cashDiscountBps?: bigint;
  /** Always 0 for a new sale under D-044 — no payment method gets a discount off list price
   * anymore. Kept (not removed) so a historical sale's real, immutable pre-D-044 value still
   * round-trips correctly. */
  cashDiscountCents?: bigint;
  /** Amount added on top of list price because this line's payment method is DEBIT/CREDIT — see
   * D-044. Always 0 for CASH/TRANSFER/OTHER and for the fixed portion of a PACK_FIXED_TOTAL line. */
  cardSurchargeCents?: bigint;
  promotionDiscountCents?: bigint;
  costCentsSnapshot?: bigint | null;
  profitMarkupBpsSnapshot?: bigint | null;
  subtotalCents: bigint;
}
