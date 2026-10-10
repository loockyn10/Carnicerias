import { buildOfferSlide, parsePromotionFact, summarizeOffer, type EditorUnavailableReason, type SlideFacts } from "./signage";
import { formatIsoDate, isIsoDate } from "./date-range";

/**
 * Promociones y grupos para la cartelería de TV (D-084): de los HECHOS que entrega `get_signage_promotion_catalog` a lo que muestra el editor.
 * Puro y sin red. No hay precio escrito a mano en ningún lado: el texto de cada oferta sale de `buildOfferSlide` (el motor de pricing de la
 * cartelería) con el precio de lista vigente que trae la base; un grupo sólo conoce los ids de sus promociones.
 */

export type PromotionStatus = "ACTIVE" | "UPCOMING" | "EXPIRED";

export const PROMOTION_STATUS_LABELS: Record<PromotionStatus, string> = { ACTIVE: "Activa", UPCOMING: "Próxima", EXPIRED: "Vencida" };

export interface PromotionOption {
  promotionId: string;
  productId: string;
  productName: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT";
  branchId: string | null;
  branchName: string | null;
  mode: "THRESHOLD" | "PACK_FIXED_TOTAL";
  status: PromotionStatus;
  validFrom: string | null;
  validUntil: string | null;
  /** El producto tiene foto comercial; sin foto la TV usa el reemplazo y el editor avisa «Sin foto». */
  hasPhoto: boolean;
  /** Producto inactivo o sin precio: la promoción no se puede mostrar aunque esté vigente. */
  unavailable: EditorUnavailableReason | null;
  /** «$ 11.000 / kg · desde 2 kg», «$ 5.400 · por 3 unidades»: lo que verá el TV, con el motor de pricing. */
  summary: string;
}

export interface PromotionGroup {
  id: string;
  name: string;
  /** Ids de las promociones en el orden del grupo (el orden en que rotan). */
  promotionIds: string[];
  /** Pantallas que usan el grupo (un grupo en uso no se puede eliminar). */
  usedByDisplays: number;
}

export interface PromotionCatalog {
  promotions: PromotionOption[];
  groups: PromotionGroup[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

function asDate(value: unknown): string | null {
  return typeof value === "string" && isIsoDate(value.slice(0, 10)) ? value.slice(0, 10) : null;
}

function bigint(value: unknown): bigint | null {
  return typeof value === "string" && /^\d{1,18}$/.test(value) ? BigInt(value) : null;
}

function parseOption(raw: unknown): PromotionOption | null {
  if (!isRecord(raw)) return null;
  const promotionId = asString(raw.promotionId);
  const productId = asString(raw.productId);
  const productName = asString(raw.productName);
  const unitType = raw.unitType;
  const status = raw.status;
  const mode = raw.mode;
  if (!promotionId || !productId || !productName || (unitType !== "UNIT" && unitType !== "WEIGHT")) return null;
  if (status !== "ACTIVE" && status !== "UPCOMING" && status !== "EXPIRED") return null;
  if (mode !== "THRESHOLD" && mode !== "PACK_FIXED_TOTAL") return null;
  const listPriceCents = bigint(raw.listPriceCents);
  const promotion = parsePromotionFact({ ...raw, status });
  let summary = "Sin precio vigente";
  if (listPriceCents !== null && listPriceCents > 0n && promotion) {
    const facts: SlideFacts = { key: promotionId, name: productName, unitType, listPriceCents, bulkMinimumUnits: null, bulkDiscountBps: null, weightTiers: [], promotion };
    const offer = buildOfferSlide(facts);
    if (offer) summary = summarizeOffer(offer);
  }
  const reason = raw.unavailableReason === "INACTIVE" || raw.unavailableReason === "NO_PRICE" ? raw.unavailableReason : null;
  return {
    promotionId, productId, productName, sku: asString(raw.sku), unitType, branchId: asString(raw.branchId), branchName: asString(raw.branchName), mode, status,
    validFrom: asDate(raw.validFrom), validUntil: asDate(raw.validUntil), hasPhoto: raw.hasPhoto === true, unavailable: reason, summary
  };
}

function parseGroup(raw: unknown): PromotionGroup | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name || !Array.isArray(raw.promotionIds)) return null;
  const used = typeof raw.usedByDisplays === "number" && Number.isSafeInteger(raw.usedByDisplays) ? raw.usedByDisplays : 0;
  return { id, name, promotionIds: (raw.promotionIds as unknown[]).filter((item): item is string => typeof item === "string"), usedByDisplays: used };
}

/** JSON de `get_signage_promotion_catalog` → catálogo del editor. Una fila rara se descarta: nunca rompe la pantalla. */
export function parsePromotionCatalog(raw: unknown): PromotionCatalog {
  if (!isRecord(raw)) throw new Error("Respuesta inválida del servidor");
  const promotions = (Array.isArray(raw.promotions) ? raw.promotions as unknown[] : []).map(parseOption).filter((item): item is PromotionOption => item !== null);
  const groups = (Array.isArray(raw.groups) ? raw.groups as unknown[] : []).map(parseGroup).filter((item): item is PromotionGroup => item !== null);
  return { promotions, groups };
}

/** «Hasta el 20/10/2026», «Desde el 15/10/2026», «Venció el 05/10/2026», «Sin fecha de fin». */
export function validityText(option: Pick<PromotionOption, "status" | "validFrom" | "validUntil">): string {
  if (option.status === "UPCOMING") return option.validFrom ? `Desde el ${formatIsoDate(option.validFrom)}` : "Próxima";
  if (option.status === "EXPIRED") return option.validUntil ? `Venció el ${formatIsoDate(option.validUntil)}` : "Desactivada";
  return option.validUntil ? `Hasta el ${formatIsoDate(option.validUntil)}` : "Sin fecha de fin";
}

/** Por defecto sólo se ofrecen las ACTIVAS; el resto (próximas, vencidas) se ve eligiendo la pestaña. */
export function filterByStatus(options: readonly PromotionOption[], status: PromotionStatus): PromotionOption[] {
  return options.filter((option) => option.status === status);
}

export function statusCounts(options: readonly PromotionOption[]): Record<PromotionStatus, number> {
  const counts: Record<PromotionStatus, number> = { ACTIVE: 0, UPCOMING: 0, EXPIRED: 0 };
  for (const option of options) counts[option.status] += 1;
  return counts;
}

/** Cuántas de las promociones elegidas no tienen foto comercial (el editor avisa: no impide reproducirlas). */
export function countWithoutPhoto(options: readonly PromotionOption[], selected: ReadonlySet<string>): number {
  return options.filter((option) => selected.has(option.promotionId) && !option.hasPhoto).length;
}

/** Texto corto del estado de una promoción dentro de un grupo ya guardado (vigencia, producto, foto). */
export function groupItemNote(option: PromotionOption | undefined): string {
  if (!option) return "La promoción ya no existe";
  const parts: string[] = [];
  if (option.status !== "ACTIVE") parts.push(`${PROMOTION_STATUS_LABELS[option.status]}: la TV la saltea`);
  if (option.unavailable === "INACTIVE") parts.push("Producto inactivo");
  if (option.unavailable === "NO_PRICE") parts.push("Sin precio vigente");
  if (!option.hasPhoto) parts.push("Sin foto");
  return parts.join(" · ");
}
