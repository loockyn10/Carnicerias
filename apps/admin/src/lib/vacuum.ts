import { formatCurrency, formatWeight, parseWeightToGrams, priceForWeight } from "@carnicerias/business-logic";

import { isIsoDate, shiftIsoDate } from "./date-range";
import { isUuid } from "./uuid";
import { asArray, asRecord, bool, cents, centsOrNull, int, intOrNull, str, strOrNull } from "./rpc-json";
import { buildEan13, isEanScheme, validateEanSchemeConfig, vacuumCommercialTotalCents, type EanBuildResult, type EanSchemeConfig } from "./vacuum-ean";
import { resolveVacuumLabelDims, type VacuumLabelDims } from "./vacuum-label-spec";

/**
 * Dominio del módulo ENVASADOS en el Admin: tipos, lectura de las RPC (migración 202611010093) y los cálculos del formulario rápido
 * (peso × precio/kg, vencimiento por vida útil, vista previa). El servidor recalcula todo al registrar el paquete; esto sólo alimenta la
 * pantalla, con las mismas reglas (el importe usa `priceForWeight` del POS: half-up en centavos).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Fechas (sin zona horaria: las fechas del paquete son fechas calendario «AAAA-MM-DD»; los helpers de calendario viven en date-range.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** «2026-11-01» → «01/11/2026». */
export function formatIsoDate(value: string): string {
  if (!isIsoDate(value)) return value;
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tipos y lectura de RPC
// ---------------------------------------------------------------------------------------------------------------------

export interface VacuumSettings {
  businessName: string | null;
  address: string | null;
  establishmentInfo: string | null;
  defaultConservationText: string | null;
  extraText: string | null;
  labelWidthMm: number | null;
  infoHeightMm: number | null;
  priceHeightMm: number | null;
  ean: EanSchemeConfig | null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function parseEanConfig(value: unknown): EanSchemeConfig | null {
  const record = asRecord(value);
  const scheme = record.scheme;
  if (!isEanScheme(scheme)) return null;
  const config: EanSchemeConfig = {
    scheme, prefix: str(record.prefix), pluDigits: int(record.pluDigits), valueDigits: int(record.valueDigits), valueStep: int(record.valueStep, 1)
  };
  return validateEanSchemeConfig(config) === null ? config : null;
}

export function parseVacuumSettings(value: unknown): VacuumSettings {
  const record = asRecord(value);
  return {
    businessName: strOrNull(record.businessName), address: strOrNull(record.address), establishmentInfo: strOrNull(record.establishmentInfo),
    defaultConservationText: strOrNull(record.defaultConservationText), extraText: strOrNull(record.extraText),
    labelWidthMm: numberOrNull(record.labelWidthMm), infoHeightMm: numberOrNull(record.infoHeightMm), priceHeightMm: numberOrNull(record.priceHeightMm),
    ean: parseEanConfig(record.ean)
  };
}

export function vacuumDims(settings: Pick<VacuumSettings, "labelWidthMm" | "infoHeightMm" | "priceHeightMm"> | null): VacuumLabelDims {
  return resolveVacuumLabelDims({ widthMm: settings?.labelWidthMm, infoHeightMm: settings?.infoHeightMm, priceHeightMm: settings?.priceHeightMm });
}

/** Corte habilitado para envasar, con el precio/kg vigente de la sucursal (null = sin precio). */
export interface VacuumProductOption {
  productId: string;
  name: string;
  sku: string | null;
  shelfLifeDays: number | null;
  plu: string | null;
  conservationText: string | null;
  pricePerKgCents: bigint | null;
}

export function parseVacuumProducts(value: unknown): VacuumProductOption[] {
  return asArray(value).map((entry) => {
    const record = asRecord(entry);
    return {
      productId: str(record.productId), name: str(record.name), sku: strOrNull(record.sku), shelfLifeDays: intOrNull(record.shelfLifeDays),
      plu: strOrNull(record.plu), conservationText: strOrNull(record.conservationText), pricePerKgCents: centsOrNull(record.pricePerKgCents)
    };
  }).filter((product) => product.productId !== "");
}

/** Paquete registrado: snapshot completo (todo lo necesario para reimprimir sin consultar precios ni textos actuales). */
export interface VacuumPackage {
  id: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  productSku: string | null;
  weightGrams: number;
  pricePerKgCents: bigint;
  totalCents: bigint;
  packedOn: string;
  expiresOn: string;
  lot: string;
  ean13: string;
  shelfLifeDays: number | null;
  conservationText: string | null;
  businessName: string | null;
  address: string | null;
  establishmentInfo: string | null;
  extraText: string | null;
  dims: { widthMm: number | null; infoHeightMm: number | null; priceHeightMm: number | null };
  createdAt: string;
  createdBy: string | null;
  printCount: number;
}

export function parseVacuumPackage(value: unknown): VacuumPackage | null {
  const record = asRecord(value);
  if (str(record.id) === "") return null;
  const label = asRecord(record.label);
  return {
    id: str(record.id), branchId: str(record.branchId), branchName: str(record.branchName), productId: str(record.productId),
    productName: str(record.productName), productSku: strOrNull(record.productSku), weightGrams: int(record.weightGrams),
    pricePerKgCents: cents(record.pricePerKgCents), totalCents: cents(record.totalCents), packedOn: str(record.packedOn), expiresOn: str(record.expiresOn),
    lot: str(record.lot), ean13: str(record.ean13), shelfLifeDays: intOrNull(record.shelfLifeDays), conservationText: strOrNull(record.conservationText),
    businessName: strOrNull(label.businessName), address: strOrNull(label.address), establishmentInfo: strOrNull(label.establishmentInfo),
    extraText: strOrNull(label.extraText),
    dims: { widthMm: numberOrNull(label.labelWidthMm), infoHeightMm: numberOrNull(label.infoHeightMm), priceHeightMm: numberOrNull(label.priceHeightMm) },
    createdAt: str(record.createdAt), createdBy: strOrNull(record.createdBy), printCount: int(record.printCount)
  };
}

export interface VacuumPackageRow {
  id: string;
  lot: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  weightGrams: number;
  pricePerKgCents: bigint;
  totalCents: bigint;
  packedOn: string;
  expiresOn: string;
  ean13: string;
  createdAt: string;
  printCount: number;
  lastPrintedAt: string | null;
  /** AVAILABLE (disponible para vender), SOLD (vendido en una caja) o VOIDED (anulado). */
  status: VacuumPackageStatus;
  currentBranchId: string | null;
  currentBranchName: string | null;
}

export const VACUUM_PACKAGE_STATUSES = ["AVAILABLE", "SOLD", "VOIDED"] as const;
export type VacuumPackageStatus = (typeof VACUUM_PACKAGE_STATUSES)[number];
export const VACUUM_PACKAGE_STATUS_LABELS: Record<VacuumPackageStatus, string> = { AVAILABLE: "Disponible", SOLD: "Vendido", VOIDED: "Anulado" };

function packageStatus(value: unknown): VacuumPackageStatus {
  return (VACUUM_PACKAGE_STATUSES as readonly unknown[]).includes(value) ? (value as VacuumPackageStatus) : "AVAILABLE";
}

export interface VacuumPackagesPage {
  total: number;
  rows: VacuumPackageRow[];
}

export function parseVacuumPackagesPage(value: unknown): VacuumPackagesPage {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        id: str(row.id), lot: str(row.lot), branchId: str(row.branchId), branchName: str(row.branchName), productId: str(row.productId),
        productName: str(row.productName), weightGrams: int(row.weightGrams), pricePerKgCents: cents(row.pricePerKgCents), totalCents: cents(row.totalCents),
        packedOn: str(row.packedOn), expiresOn: str(row.expiresOn), ean13: str(row.ean13), createdAt: str(row.createdAt), printCount: int(row.printCount),
        lastPrintedAt: strOrNull(row.lastPrintedAt), status: packageStatus(row.status), currentBranchId: strOrNull(row.currentBranchId), currentBranchName: strOrNull(row.currentBranchName)
      };
    })
  };
}

export const VACUUM_CONFLICT_REASON_LABELS: Record<string, string> = {
  ALREADY_SOLD: "El paquete ya estaba vendido",
  VOIDED: "El paquete estaba anulado",
  WRONG_BRANCH: "El paquete estaba en otra sucursal",
  RESTORE_UNAVAILABLE: "Se restableció una venta cuyo paquete ya no estaba disponible"
};

/** Una venta (offline) que reclamó un paquete que el servidor ya tenía vendido, anulado o en otra sucursal. La venta SÍ quedó registrada. */
export interface VacuumConflictRow {
  id: string;
  status: "OPEN" | "RESOLVED";
  reason: string;
  createdAt: string;
  branchName: string;
  productName: string;
  weightGrams: number;
  totalCents: bigint;
  lot: string;
  ean13: string;
  saleId: string;
  firstSaleId: string | null;
  resolutionNote: string | null;
}

export function parseVacuumConflicts(value: unknown): VacuumConflictRow[] {
  return asArray(value).map((entry) => {
    const row = asRecord(entry);
    return {
      id: str(row.id), status: row.status === "RESOLVED" ? "RESOLVED" : "OPEN", reason: str(row.reason), createdAt: str(row.createdAt), branchName: str(row.branchName),
      productName: str(row.productName), weightGrams: int(row.weightGrams), totalCents: cents(row.totalCents), lot: str(row.lot), ean13: str(row.ean13),
      saleId: str(row.saleId), firstSaleId: strOrNull(row.firstSaleId), resolutionNote: strOrNull(row.resolutionNote)
    };
  });
}

export interface VacuumConfigRow {
  productId: string;
  name: string;
  sku: string | null;
  enabled: boolean;
  shelfLifeDays: number | null;
  plu: string | null;
  conservationText: string | null;
}

export function parseVacuumConfigPage(value: unknown): { total: number; rows: VacuumConfigRow[] } {
  const record = asRecord(value);
  return {
    total: int(record.total),
    rows: asArray(record.rows).map((entry) => {
      const row = asRecord(entry);
      return {
        productId: str(row.productId), name: str(row.name), sku: strOrNull(row.sku), enabled: bool(row.enabled), shelfLifeDays: intOrNull(row.shelfLifeDays),
        plu: strOrNull(row.plu), conservationText: strOrNull(row.conservationText)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cálculos del formulario rápido
// ---------------------------------------------------------------------------------------------------------------------

export type WeightParse = { ok: true; grams: number } | { ok: false; message: string };

/** Peso ingresado en kg (coma o punto, hasta 3 decimales) → gramos. Máximo 99,999 kg (límite del servidor). */
export function parsePackageWeight(input: string): WeightParse {
  if (input.trim() === "") return { ok: false, message: "Ingresá el peso" };
  try {
    const grams = parseWeightToGrams(input);
    if (grams > 99_999) return { ok: false, message: "El peso máximo es 99,999 kg" };
    return { ok: true, grams };
  } catch {
    return { ok: false, message: "Peso en kg, hasta 3 decimales (ej. 1,245)" };
  }
}

/** Importe CALCULADO del paquete: precio/kg × gramos / 1000, half-up en centavos (igual que el POS). Es el dato de auditoría, no lo que se cobra. */
export function packageTotalCents(pricePerKgCents: bigint, weightGrams: number): bigint {
  return priceForWeight(pricePerKgCents, weightGrams);
}

/** Importe COMERCIAL único del paquete: el calculado, redondeado según el esquema EAN (divisor 100 = pesos enteros). Es el que se imprime, va en el EAN, muestra el POS y se cobra. */
export function packageCommercialTotalCents(pricePerKgCents: bigint, weightGrams: number, scheme: EanSchemeConfig | null): bigint {
  return vacuumCommercialTotalCents(scheme, packageTotalCents(pricePerKgCents, weightGrams));
}

/** Vencimiento por defecto = elaboración + vida útil configurada (null si el producto no tiene vida útil). */
export function defaultExpiry(packedOn: string, shelfLifeDays: number | null): string | null {
  if (shelfLifeDays === null || !isIsoDate(packedOn)) return null;
  return shiftIsoDate(packedOn, shelfLifeDays);
}

export interface DraftInput {
  product: VacuumProductOption | null;
  weightText: string;
  packedOn: string;
  expiresOn: string;
  settings: VacuumSettings | null;
}

export interface PackageDraft {
  /** null mientras falte algo para calcular (corte, peso válido o precio). */
  weightGrams: number | null;
  /** Importe comercial único (impreso, en el EAN y cobrado). */
  totalCents: bigint | null;
  /** Cálculo con centavos (sólo auditoría); igual a totalCents cuando el esquema no redondea. */
  computedTotalCents: bigint | null;
  ean: EanBuildResult | null;
  /** Problemas que impiden registrar (en castellano). */
  problems: string[];
  /** Avisos que no impiden registrar. */
  warnings: string[];
}

/** Estado derivado del formulario: importe, EAN y qué falta. Se recalcula en cada tecla para que el preview responda al instante. */
export function buildPackageDraft(input: DraftInput): PackageDraft {
  const problems: string[] = [];
  const warnings: string[] = [];
  const weight = parsePackageWeight(input.weightText);
  if (!input.product) problems.push("Elegí el corte");
  if (input.product?.pricePerKgCents === null) problems.push("El corte no tiene un precio vigente en esta sucursal");
  if (input.weightText.trim() !== "" && !weight.ok) problems.push(weight.message);
  if (input.weightText.trim() === "") problems.push("Ingresá el peso");
  if (!isIsoDate(input.packedOn)) problems.push("Fecha de elaboración inválida");
  if (!isIsoDate(input.expiresOn)) problems.push("Fecha de vencimiento inválida");
  else if (isIsoDate(input.packedOn) && input.expiresOn < input.packedOn) problems.push("El vencimiento no puede ser anterior a la elaboración");
  if (input.product?.shelfLifeDays === null) warnings.push("El corte no tiene vida útil configurada: revisá el vencimiento");

  const grams = weight.ok ? weight.grams : null;
  const price = input.product?.pricePerKgCents ?? null;
  const computedTotalCents = grams !== null && price !== null ? packageTotalCents(price, grams) : null;
  const totalCents = computedTotalCents !== null ? vacuumCommercialTotalCents(input.settings?.ean ?? null, computedTotalCents) : null;
  if (computedTotalCents !== null && totalCents !== null && totalCents !== computedTotalCents) {
    warnings.push(`El importe se redondea a pesos enteros: ${moneyText(totalCents)} (calculado ${moneyText(computedTotalCents)})`);
  }
  let ean: EanBuildResult | null = null;
  if (input.product && grams !== null && totalCents !== null) {
    ean = buildEan13(input.settings?.ean ?? null, { plu: input.product.plu, priceCents: totalCents, weightGrams: grams });
    if (!ean.ok) problems.push(ean.message);
  } else if (!input.settings?.ean) {
    problems.push("Falta configurar el esquema EAN-13 de envasados");
  }
  return { weightGrams: grams, totalCents, computedTotalCents, ean, problems, warnings };
}

/** Texto de importe para etiquetas y pantallas: «$18.052,50» (sin espacio tras el signo). */
export function moneyText(centsValue: bigint): string {
  return formatCurrency(centsValue).replace("$ ", "$");
}

export function weightText(grams: number): string {
  return formatWeight(grams);
}

export const VACUUM_PRINT_KINDS = ["INFO", "PRICE", "BOTH"] as const;
export type VacuumPrintKind = (typeof VACUUM_PRINT_KINDS)[number];

export function isVacuumPrintKind(value: unknown): value is VacuumPrintKind {
  return typeof value === "string" && (VACUUM_PRINT_KINDS as readonly string[]).includes(value);
}

export const VACUUM_PRINT_KIND_LABELS: Record<VacuumPrintKind, string> = { INFO: "Informativa", PRICE: "Precio", BOTH: "Ambas" };

// ---------------------------------------------------------------------------------------------------------------------
// Entrada del alta de paquete (la valida el servidor otra vez; esto da el mensaje en castellano antes de ir a la base)
// ---------------------------------------------------------------------------------------------------------------------

export interface CreatePackageInput {
  branchId: string;
  productId: string;
  weightGrams: number;
  packedOn: string;
  /** null = que el servidor lo calcule con la vida útil configurada. */
  expiresOn: string | null;
  /** null = lote automático. */
  lot: string | null;
  requestKey: string;
}

export type CreatePackageParse = { ok: true; value: CreatePackageInput } | { ok: false; error: string };

export function parseCreatePackageInput(raw: unknown): CreatePackageParse {
  const record = asRecord(raw);
  const branchId = str(record.branchId);
  if (!isUuid(branchId)) return { ok: false, error: "Elegí la sucursal" };
  const productId = str(record.productId);
  if (!isUuid(productId)) return { ok: false, error: "Elegí el corte" };
  const weightGrams = record.weightGrams;
  if (typeof weightGrams !== "number" || !Number.isInteger(weightGrams) || weightGrams < 1 || weightGrams > 99_999) return { ok: false, error: "El peso tiene que estar entre 1 g y 99,999 kg" };
  const packedOn = str(record.packedOn);
  if (!isIsoDate(packedOn)) return { ok: false, error: "La fecha de elaboración es inválida" };
  const expiresOn = strOrNull(record.expiresOn);
  if (expiresOn !== null && !isIsoDate(expiresOn)) return { ok: false, error: "La fecha de vencimiento es inválida" };
  if (expiresOn !== null && expiresOn < packedOn) return { ok: false, error: "El vencimiento no puede ser anterior a la elaboración" };
  const lot = strOrNull(record.lot);
  if (lot !== null && lot.trim().length > 40) return { ok: false, error: "El lote admite hasta 40 caracteres" };
  const requestKey = str(record.requestKey);
  if (!isUuid(requestKey)) return { ok: false, error: "Pedido inválido" };
  return { ok: true, value: { branchId, productId, weightGrams, packedOn, expiresOn, lot: lot === null ? null : lot.trim(), requestKey } };
}
