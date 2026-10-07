import { compareWithLastPrint, describeValues, freshnessText, needsPrinting, type LabelChangeReason, type LabelFreshness } from "./label-changes";
import { buildLabelLayout, type LabelLayout } from "./label-layout";
import { formatIsoStamp } from "./label-stamp";
import { buildProductLabel, type BulkPromotionFact, type LabelValues, type ProductLabelData, type ProductLabelInput } from "./product-label";

/**
 * Grupos de etiquetas (D-073): de los HECHOS que entrega la base (`get_label_group`: producto, precio vigente de la sucursal del grupo,
 * regla «llevando N» y última impresión) a lo que muestra el Admin y a lo que imprime el PDF. Puro y sin red.
 *
 * El JSON de la base nunca se da por bueno: un campo raro descarta ese producto del grupo (no rompe la pantalla ni el PDF).
 */

export type LabelUnavailableReason = "INACTIVE" | "NOT_IN_BRANCH" | "NO_PRICE";

export const UNAVAILABLE_TEXT: Record<LabelUnavailableReason, string> = {
  INACTIVE: "Producto inactivo o no vendible",
  NOT_IN_BRANCH: "No se vende en la sucursal del grupo",
  NO_PRICE: "Sin precio vigente"
};

/** La última impresión conocida de un producto DENTRO del grupo (snapshot). */
export interface LastPrintFacts extends LabelValues {
  runId: string;
  generatedAt: string;
  copies: number;
}

export interface LabelItemFacts {
  productId: string;
  position: number;
  name: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT";
  unavailableReason: LabelUnavailableReason | null;
  /** Precio de lista vigente (de la sucursal del grupo, o el global); null = sin precio. */
  listPriceCents: bigint | null;
  bulk: BulkPromotionFact | null;
  last: LastPrintFacts | null;
}

export interface LabelGroupFacts {
  groupId: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  items: LabelItemFacts[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function asCents(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d{1,18}$/.test(value)) return BigInt(value);
  return null;
}
function isReason(value: unknown): value is LabelUnavailableReason {
  return value === "INACTIVE" || value === "NOT_IN_BRANCH" || value === "NO_PRICE";
}

function parseLast(raw: unknown): LastPrintFacts | null {
  if (!isRecord(raw)) return null;
  const runId = asString(raw.runId);
  const generatedAt = asString(raw.generatedAt);
  const displayedName = asString(raw.displayedName);
  const list = asCents(raw.listPriceCents);
  const promo = raw.promoPriceCents === null || raw.promoPriceCents === undefined ? null : asCents(raw.promoPriceCents);
  const copies = asInteger(raw.copies);
  if (!runId || !generatedAt || displayedName === null || list === null || copies === null) return null;
  return {
    runId, generatedAt, copies, displayedName, listPriceCents: list.toString(), promoPriceCents: promo === null ? null : promo.toString(),
    promoMinimumUnits: asInteger(raw.promoMinimumUnits), promoDiscountBps: asInteger(raw.promoDiscountBps)
  };
}

export function parseLabelGroupFacts(payload: unknown): LabelGroupFacts | null {
  if (!isRecord(payload)) return null;
  const groupId = asString(payload.groupId);
  const name = asString(payload.name);
  if (!groupId || name === null) return null;
  const items: LabelItemFacts[] = [];
  if (Array.isArray(payload.items)) {
    for (const raw of payload.items as unknown[]) {
      if (!isRecord(raw)) continue;
      const productId = asString(raw.productId);
      const productName = asString(raw.name);
      const position = asInteger(raw.position);
      const unitType = raw.unitType;
      if (!productId || !productName?.trim() || position === null || (unitType !== "UNIT" && unitType !== "WEIGHT")) continue;
      const minimum = asInteger(raw.bulkMinimumUnits);
      const bps = asInteger(raw.bulkDiscountBps);
      items.push({
        productId, position, name: productName, sku: asString(raw.sku), unitType,
        unavailableReason: isReason(raw.unavailableReason) ? raw.unavailableReason : null,
        listPriceCents: raw.listPriceCents === null || raw.listPriceCents === undefined ? null : asCents(raw.listPriceCents),
        bulk: minimum !== null && bps !== null && bps > 0 ? { minimumUnits: minimum, discountBps: bps } : null,
        last: parseLast(raw.last)
      });
    }
  }
  return {
    groupId, name, branchId: asString(payload.branchId), branchName: asString(payload.branchName), active: payload.active !== false,
    items: items.sort((a, b) => a.position - b.position)
  };
}

/** Entrada del constructor de etiquetas: un producto sin motivo de indisponibilidad usa su precio vigente; si no, sale «SIN PRECIO». */
export function labelInputOf(item: LabelItemFacts): ProductLabelInput {
  return {
    name: item.name, unitType: item.unitType,
    listPriceCents: item.unavailableReason === null ? item.listPriceCents : null,
    bulk: item.unavailableReason === null ? item.bulk : null
  };
}

/** Un producto del grupo tal como lo muestra el Admin (serializable: viaja del servidor al navegador). */
export interface LabelGroupItemView {
  productId: string;
  name: string;
  sku: string | null;
  unitType: "UNIT" | "WEIGHT";
  /** false = no se puede imprimir hoy (inactivo, fuera de la sucursal o sin precio). */
  printable: boolean;
  unavailableReason: LabelUnavailableReason | null;
  /** Motivo en palabras ("Sin precio vigente"); null si es imprimible. */
  unavailableText: string | null;
  freshness: LabelFreshness | null;
  reasons: LabelChangeReason[];
  /** «Actualizada», «Precio cambió», «Nunca impresa»… (null si no es imprimible). */
  freshnessText: string | null;
  /** true cuando falta o quedó vieja la etiqueta física (lo que selecciona «Seleccionar precios cambiados»). */
  needsPrint: boolean;
  /** Lo que llevaría la etiqueta HOY ("$ 1.742,50 (3+ u) · normal $ 2.050"); null si no es imprimible. */
  currentText: string | null;
  /** Lo que lleva la etiqueta física impresa la última vez; null = nunca. */
  lastPrintedText: string | null;
  /** Fecha y hora de esa impresión en la zona horaria de la organización («07/10/2026 15:42»). */
  lastPrintedAtText: string | null;
  lastCopies: number | null;
  layout: LabelLayout;
}

export interface LabelGroupView {
  groupId: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  items: LabelGroupItemView[];
}

export interface LabelItemResolution {
  item: LabelItemFacts;
  label: ProductLabelData;
  printable: boolean;
  freshness: ReturnType<typeof compareWithLastPrint> | null;
}

/** Resuelve UN producto: la etiqueta de hoy (motor de pricing) y, si es imprimible, su estado frente a la última impresión. */
export function resolveLabelItem(item: LabelItemFacts): LabelItemResolution {
  const label = buildProductLabel(labelInputOf(item));
  const printable = item.unavailableReason === null && label.values !== null;
  return { item, label, printable, freshness: printable && label.values ? compareWithLastPrint(label.values, item.last) : null };
}

export function buildLabelGroupView(facts: LabelGroupFacts, timeZone: string): LabelGroupView {
  return {
    groupId: facts.groupId, name: facts.name, branchId: facts.branchId, branchName: facts.branchName, active: facts.active,
    items: facts.items.map((item) => {
      const { label, printable, freshness } = resolveLabelItem(item);
      return {
        productId: item.productId, name: item.name, sku: item.sku, unitType: item.unitType, printable, unavailableReason: item.unavailableReason,
        unavailableText: item.unavailableReason ? UNAVAILABLE_TEXT[item.unavailableReason] : printable ? null : UNAVAILABLE_TEXT.NO_PRICE,
        freshness: freshness?.status ?? null, reasons: freshness?.reasons ?? [],
        freshnessText: freshness ? freshnessText(freshness) : null,
        needsPrint: needsPrinting(freshness?.status ?? null),
        currentText: printable && label.values ? describeValues(label.values, item.unitType) : null,
        lastPrintedText: item.last ? describeValues(item.last, item.unitType) : null,
        lastPrintedAtText: item.last ? formatIsoStamp(item.last.generatedAt, timeZone) : null,
        lastCopies: item.last?.copies ?? null,
        layout: buildLabelLayout(label)
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Listado de grupos (`list_label_groups`)
// ---------------------------------------------------------------------------------------------------------------------

export interface LabelGroupListEntry {
  groupId: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  itemCount: number;
  lastRunAt: string | null;
}

export function parseLabelGroupList(payload: unknown): LabelGroupListEntry[] {
  if (!Array.isArray(payload)) return [];
  const entries: LabelGroupListEntry[] = [];
  for (const raw of payload as unknown[]) {
    if (!isRecord(raw)) continue;
    const groupId = asString(raw.groupId);
    const name = asString(raw.name);
    if (!groupId || name === null) continue;
    entries.push({
      groupId, name, branchId: asString(raw.branchId), branchName: asString(raw.branchName), active: raw.active !== false,
      itemCount: asInteger(raw.itemCount) ?? 0, lastRunAt: asString(raw.lastRunAt)
    });
  }
  return entries;
}
