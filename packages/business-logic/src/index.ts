export {
  formatCurrency,
  formatWeight,
  parseWeightToGrams,
  priceForWeight,
  sumMoney,
  applyWeightDiscount
} from "./measurements";
export type { AppliedWeightDiscount, WeightDiscountRule } from "./measurements";
export {
  formatStockQuantity, parseStockQuantityInput, stockQuantityToInput, stockUnitLabel
} from "./stock-quantity";
export type { ParseStockQuantityOptions, StockUnit } from "./stock-quantity";
export {
  calculateListPriceFromMargin, calculatePriceFormation, calculateSalePricing, calculateWeightPackSalePricing,
  calculateUnitPackSalePricing, divideRoundHalfUp, validateBasisPoints
} from "./pricing";
export type { QuantityDiscount, SalePricing, UnitPackPromotion } from "./pricing";
export {
  allocateTicketDiscount, calculateManualLinePricing, calculateTicketDiscount, formatDiscountPercent,
  MAX_TICKET_DISCOUNT_BPS, parseDiscountPercent
} from "./ticket-pricing";
export type { DiscountPercentParse, ManualLinePricing, TicketDiscount } from "./ticket-pricing";
export {
  advanceWeightStability,
  initialWeightStabilityState,
  isScaleReadingFresh,
  SCALE_CONNECTION_STATES,
  SCALE_KINDS,
  SCALE_READING_TTL_MS,
  WEIGHT_STABILITY_TOLERANCE_GRAMS,
  WEIGHT_STABILITY_WINDOW_MS
} from "./scale";
export type {
  ScaleConnectionState,
  ScaleKind,
  ScaleReading,
  WeightStabilityEvent,
  WeightStabilityState,
  WeightStabilityStatus
} from "./scale";
export {
  allocateProductionCost,
  assertOutputsHavePrices,
  buildProductionBatchSummary,
  calculateAverageCostPerKgCents,
  calculateGrossMarginCents,
  calculateInputCostCents,
  calculateMarginOverSalesBps,
  calculateOutputSaleValueCents,
  calculateProducedWeightGrams,
  calculateProfitabilityOverCostBps,
  calculateTotalSaleValueCents,
  calculateWasteGrams,
  calculateWastePercentageBps,
  calculateYieldBps
} from "./production";
export type {
  ProductionBatchSummary,
  ProductionOutputAllocation,
  ProductionOutputPricing,
  ProductionOutputWeight
} from "./production";
export {
  CATALOG_FIELD_LABELS,
  CATALOG_IMPORT_FIELDS,
  chunkItems,
  decodeCsvBytes,
  detectCsvDelimiter,
  detectNumberFormat,
  detectTableNumberFormat,
  buildPurgeCandidates,
  classifySourceQuantity,
  mapCatalogRows,
  normalizeImportText,
  parseCsvRecords,
  parseCsvText,
  suggestColumnMapping,
  tableFromRecords,
  validateColumnMapping
} from "./catalog-import";
export type {
  CatalogColumnMapping,
  CatalogImportField,
  CatalogMappingOptions,
  CatalogMappingResult,
  CatalogRowDisplay,
  CellValue,
  ImportTable,
  ImportTableRow,
  MappedCatalogRow,
  NumberFormat,
  PurgeCandidate,
  PurgeCandidateBuild,
  SourceQuantityVerdict
} from "./catalog-import";
export {
  calculateBranchPromotionLinePricing, calculateUnitPackLinePricing, DEFAULT_PACK_DISCOUNT_BPS, formatBasisPointsPercent, isValidPackDiscountBps, packDiscountLabel,
  isValidPackSizeUnits, MAX_PACK_DISCOUNT_BPS, MAX_PACK_SIZE_UNITS, MIN_PACK_DISCOUNT_BPS, MIN_PACK_SIZE_UNITS, packRealUnits,
  promotedUnitsFor, unitDiscountCents
} from "./unit-discounts";
export type { BranchUnitPromotion, UnitDiscountKind, UnitDiscountPricing, UnitPackSale } from "./unit-discounts";
export {
  describePaymentState,
  isNotAccreditedVerification,
  isRecoverableMercadoPagoPayment,
  MERCADOPAGO_PROVIDER
} from "./mercadopago";
export type {
  MercadoPagoOrderStatus, MercadoPagoOutcome, MercadoPagoPanelTone, MercadoPagoPanelView, PaymentVerificationStatus
} from "./mercadopago";
export { describeSalePayment, paymentMethodLabel, SALE_STATUS_LABELS } from "./sale-payment-state";
export type { SalePaymentInput, SalePaymentTone, SalePaymentView } from "./sale-payment-state";
export {
  buildTemplateParameters, buildTicketModel, evaluateTicketEligibility, formatKilograms, formatMoney, maskPhone,
  normalizePhone, parseTicketSource, renderTicketLine, renderTicketText, sanitizeTemplateParameter,
  MAX_ITEMS_PARAMETER_LENGTH, TICKET_TEMPLATE_PARAMETER_COUNT
} from "./whatsapp-ticket";
export type {
  PhoneErrorCode, PhoneResult, TicketEligibility, TicketEligibilityCode, TicketLine, TicketModel, TicketSource,
  TicketSourceItem, TicketSourcePayment
} from "./whatsapp-ticket";
export {
  buildClaimLink, buildClaimMessage, CLAIM_KEYWORD, CLAIM_REPLY_TEXT, claimReplyText, normalizeBusinessPhone, parseClaimMessage
} from "./whatsapp-claim";
export type { ClaimMessage, ClaimReplyKind } from "./whatsapp-claim";
export { renderWhatsAppMessage, MAX_WHATSAPP_MESSAGE_LENGTH } from "./whatsapp-ticket";
