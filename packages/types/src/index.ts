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
  "PRODUCTION_YIELD",
  "OPENING_BALANCE"
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
  /** POS de Central (D-061): el operador fijó el precio de ESTA línea de ESTA venta. Cuando es true,
   * `pricePerKgCents` es ese precio manual (por kg o por unidad), `originalPricePerKgCents` sigue siendo
   * el precio normal del catálogo (nunca se modifica `product_prices`) y la línea no recibe promoción,
   * recargo por tarjeta ni ningún ajuste por medio de pago. Ausente/false = línea normal. */
  manualPriceApplied?: boolean;
  /** Precio manual por kg/unidad (igual a `pricePerKgCents` cuando `manualPriceApplied`). */
  manualUnitPriceCents?: bigint | null;
  /** `subtotalCents` menos lo que habría costado a precio normal; negativo = rebaja. 0 si no es manual. */
  manualAdjustmentCents?: bigint;
}

// ---------------------------------------------------------------------------------------------
// Data import contract (see docs/IMPORTS.md). Generic and source-agnostic: a parser/mapper for a
// specific source system (e.g. SimplyGest) turns its CSV/Excel rows into these canonical payloads
// and sends them through the import RPCs; nothing below is specific to any source.
// ---------------------------------------------------------------------------------------------

export const IMPORT_ENTITY_TYPES = ["category", "product", "stock_opening_balance"] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

export const IMPORT_BATCH_STATUSES = ["STAGING", "READY", "APPLIED", "CANCELLED"] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/** Classification of one staged row, decided by preview_import_batch (never by the client). */
export const IMPORT_ROW_ACTIONS = ["CREATE", "UPDATE", "IGNORE", "ERROR"] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];

/** Keys an existing, not-yet-linked entity may be matched by (options.linkExistingBy). */
export const IMPORT_LINK_KEYS = ["sku", "barcode", "name"] as const;
export type ImportLinkKey = (typeof IMPORT_LINK_KEYS)[number];

/** Hard cap per batch enforced by stage_import_rows; larger files are split by the uploader. */
export const IMPORT_MAX_ROWS_PER_BATCH = 1000;

export interface ImportBatchOptions {
  /** Existing entities this batch is allowed to adopt instead of reporting a conflict. */
  linkExistingBy?: ImportLinkKey[];
  /** Category for NEW products whose row names none (products only). */
  defaultCategoryId?: EntityId;
  /** A product row whose categoryName matches nothing creates that category on apply (products only). */
  createMissingCategories?: boolean;
  /** Shared by the batches of ONE logical import (a big file is split in several batches). */
  runId?: string;
}

/** One staged row as sent to stage_import_rows. `externalId` is the source system's own code. */
export interface ImportRowInput<TPayload> {
  rowNumber: number;
  externalId: string | null;
  payload: TPayload;
  /** The untouched source row, kept for audit/debugging. */
  raw?: Record<string, unknown>;
}

export interface ImportCategoryPayload {
  name: string;
  sortOrder?: number;
  active?: boolean;
}

/** Money is integer cents, weight is integer grams — same units as the rest of the platform. */
export interface ImportProductPayload {
  name: string;
  /** WEIGHT (Vacío, kg) or UNIT (Coca Cola 2.25 L). Forma de venta of the product. */
  unitType: UnitType;
  sku?: string;
  /** Several barcodes per product are allowed; a barcode resolves to exactly one product. */
  barcodes?: string[];
  /** Exactly one of these may be used to name the category; else batch.defaultCategoryId. */
  categoryExternalId?: string;
  categoryName?: string;
  /**
   * Global list price: per kg for WEIGHT, per unit for UNIT. Omit to leave the price untouched.
   * 0 is valid ("sin precio definido": the Central POS asks the cashier); it only ever creates the
   * product's first price and never overwrites one that is already loaded.
   */
  priceCents?: number;
  costCents?: number;
  /** Primary supplier. Absent/empty = the product is imported without a supplier. */
  supplierName?: string;
  /** The supplier's code in the source system; identifies it across imports when present. */
  supplierCode?: string;
  active?: boolean;
  inventoryRole?: ProductInventoryRole;
  /**
   * Set by the uploader for a row it already knows is unusable (missing price, repeated across
   * batches, ...). The engine reports it as ERROR/INVALID_ROW with this text and never applies it.
   */
  invalidReason?: string;
}

/**
 * Opening stock of ONE branch (the batch's branch). `externalId` of the row is the PRODUCT's
 * external code. WEIGHT products use quantityGrams, UNIT products quantityUnits — exactly one.
 * It becomes an OPENING_BALANCE movement in the ledger, never a mutable stock column.
 */
export interface ImportStockOpeningPayload {
  quantityGrams?: number;
  quantityUnits?: number;
  note?: string;
}

export interface ImportRowError {
  rowNumber: number;
  externalId: string | null;
  reason: string;
  message: string;
}

/** What the admin reviews before confirming ("800 filas · 650 nuevos · 120 actualizaciones …"). */
export interface ImportPreviewSummary {
  totalRows: number;
  pending: number;
  create: number;
  update: number;
  ignore: number;
  error: number;
  byReason: Record<string, number>;
  /** First 50 error rows; the full list is queryable from import_rows. */
  errors: ImportRowError[];
}
