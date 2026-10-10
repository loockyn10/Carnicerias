import { formatBasisPointsPercent, formatCurrency, normalizeQuantityTiers, type QuantityTier } from "@carnicerias/business-logic";

import { percentageToBasisPointsAllowZero, text } from "./form-parsing";

/**
 * Configuración global de precios (D-068): margen de ganancia sobre el PRECIO DE VENTA, descuentos por cantidad con escalones
 * (D-083: «3 unidades → 15 %, 5 unidades → 20 %»), "% dto por pack" y recargo por tarjeta, más (D-069) las categorías excluidas del margen automático. Puro y con tests; el servidor
 * (`save_pricing_config`) vuelve a validar todo.
 */

export interface PricingConfigInput {
  marginBps: number;
  /** Escalones del descuento por cantidad, ordenados por cantidad (vacío = sin descuento por cantidad). */
  quantityTiers: QuantityTier[];
  /** Espejo histórico del «Dto llevando 3u»: el porcentaje del escalón más bajo (0 sin escalones). */
  unitBulkDiscountBps: number;
  packDiscountBps: number;
  cardSurchargeBps: number;
}

/** Una fila del editor de escalones tal como se escribe (texto): la cantidad y el porcentaje. */
export interface QuantityTierRow {
  units: string;
  percent: string;
}

export type QuantityTierRowsResult = { ok: true; tiers: QuantityTier[] } | { ok: false; error: string };

/**
 * Filas escritas → escalones en basis points enteros, validados y ORDENADOS por cantidad (cantidad entera >= 2, porcentaje > 0 y < 100,
 * sin cantidades repetidas, descuento creciente con la cantidad). La usan el editor (mensaje en pantalla) y la acción del servidor.
 */
export function parseQuantityTierRows(rows: readonly QuantityTierRow[]): QuantityTierRowsResult {
  const tiers: QuantityTier[] = [];
  for (const [index, row] of rows.entries()) {
    const units = row.units.trim();
    const percentText = row.percent.trim();
    if (!/^\d{1,4}$/.test(units)) return { ok: false, error: `Escalón ${String(index + 1)}: la cantidad tiene que ser un número entero (2 o más).` };
    let discountBps: number;
    try {
      discountBps = percentageToBasisPointsAllowZero(percentText, "El porcentaje", MAX_BPS);
    } catch {
      return { ok: false, error: `Escalón ${String(index + 1)}: el porcentaje tiene que ser mayor a 0 y menor a 100 (hasta 2 decimales).` };
    }
    tiers.push({ minimumUnits: Number(units), discountBps });
  }
  return normalizeQuantityTiers(tiers);
}

/** El campo oculto `quantity_tiers` (JSON `[{units, percent}]`) → filas. Una forma inesperada es un error. */
export function parseQuantityTiersField(raw: string): QuantityTierRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Los descuentos por cantidad no se pudieron leer: recargá la pantalla.");
  }
  if (!Array.isArray(parsed)) throw new Error("Los descuentos por cantidad no se pudieron leer: recargá la pantalla.");
  return (parsed as unknown[]).map((item) => {
    const record = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    return { units: typeof record.units === "string" ? record.units : "", percent: typeof record.percent === "string" ? record.percent : "" };
  });
}

const MAX_BPS = 9_999n;

function percent(raw: string, label: string, { allowZero }: { allowZero: boolean }): number {
  if (raw.trim() === "") throw new Error(`Completá ${label}.`);
  let bps: number;
  try {
    bps = percentageToBasisPointsAllowZero(raw, label, MAX_BPS);
  } catch {
    throw new Error(`${label} tiene que ser un porcentaje entre ${allowZero ? "0" : "0,01"} y 99,99 (hasta 2 decimales).`);
  }
  if (!allowZero && bps < 1) throw new Error(`${label} tiene que ser mayor a 0 y menor a 100.`);
  return bps;
}

/**
 * Los valores del formulario, en basis points enteros (nunca floats). Margen: > 0 y < 100 %; dto pack y tarjeta: 0 ≤ % < 100 (el pack con 0 % sigue
 * siendo un pack, sin descuento). Descuentos por cantidad: la lista de escalones (`quantity_tiers`); un formulario anterior sólo manda
 * `unit_bulk` (el «Dto llevando 3u»), que equivale a un único escalón «desde 3».
 */
export function parsePricingConfigForm(formData: FormData): PricingConfigInput {
  let quantityTiers: QuantityTier[];
  const rawTiers = text(formData, "quantity_tiers");
  if (rawTiers !== "") {
    const parsed = parseQuantityTierRows(parseQuantityTiersField(rawTiers));
    if (!parsed.ok) throw new Error(parsed.error);
    quantityTiers = parsed.tiers;
  } else {
    const legacyBps = percent(text(formData, "unit_bulk"), "El descuento llevando 3u", { allowZero: true });
    quantityTiers = legacyBps > 0 ? [{ minimumUnits: 3, discountBps: legacyBps }] : [];
  }
  return {
    quantityTiers,
    unitBulkDiscountBps: quantityTiers[0]?.discountBps ?? 0,
    marginBps: percent(text(formData, "margin"), "El margen de ganancia", { allowZero: false }),
    packDiscountBps: percent(text(formData, "pack"), "El descuento por pack", { allowZero: true }),
    cardSurchargeBps: percent(text(formData, "card"), "El recargo por tarjeta", { allowZero: true })
  };
}

/**
 * Categorías excluidas del margen automático (D-069), por ID. `null` = el formulario no envió la lista (el servidor la deja como está);
 * `[]` = se vació. El formulario siempre manda `excluded_sent` junto con las casillas marcadas, porque una casilla desmarcada no viaja.
 */
export function parseExcludedCategoryIds(formData: FormData): string[] | null {
  if (text(formData, "excluded_sent") !== "1") return null;
  const ids = formData.getAll("excluded_category").map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value !== "");
  return [...new Set(ids)];
}

export interface PricingConfigSampleRow { name: string; currentCents: number | null; newCents: number }

export interface PricingConfigOutcome {
  /** true = hay que confirmar (cambió el margen y/o se sacó una categoría de la exclusión): no se escribió nada. */
  requiresConfirmation: boolean;
  previousMarginBps: number | null;
  marginBps: number;
  /** Productos cuyo precio se recalculó (o se recalcularía, en la vista previa). */
  recalculated: number;
  /** Productos que ya tenían ese precio. */
  unchanged: number;
  /** Productos de venta automáticos sin costo vigente: conservan su precio. */
  withoutCost: number;
  /** Productos con un precio global programado a futuro: se respeta. */
  scheduledPrice: number;
  packsUpdated: number;
  branchPromotionsUpdated: number;
  /** Precios VIGENTES por sucursal de productos que este recálculo reprecia: en el POS le ganan al precio global recién formado. */
  branchOverrides: number;
  /** Precios por sucursal de productos que quedan fuera del recálculo (sin costo, programados, excluidos, inactivos). */
  branchOverridesOther: number;
  /** Precios por sucursal que se cerraron (conservan su historial). */
  branchOverridesClosed: number;
  /** Productos de venta activos de una categoría excluida (sin margen propio): conservan su precio (precio manual). */
  excludedByCategory: number;
  /** Productos de venta activos con margen personalizado (D-070): no dependen del margen global, así que este recálculo no los toca. */
  customMargin: number;
  /** ¿Cambió el margen? (si no, la confirmación se pide porque se sacó una categoría de la exclusión). */
  marginChanged: boolean;
  /** Productos que empezarían a ser automáticos porque su categoría sale de la exclusión. */
  newlyAutomatic: number;
  /** Lista de categorías excluidas resultante (ids). */
  excludedCategoryIds: string[];
  addedExcludedCategoryIds: string[];
  removedExcludedCategoryIds: string[];
  /** Vista previa: hasta 10 precios que cambiarían. */
  sample: PricingConfigSampleRow[];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sampleRows(value: unknown): PricingConfigSampleRow[] {
  if (!Array.isArray(value)) return [];
  const rows: PricingConfigSampleRow[] = [];
  for (const item of value) {
    const row = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof row.name === "string" && typeof row.newCents === "number") {
      rows.push({ name: row.name, currentCents: typeof row.currentCents === "number" ? row.currentCents : null, newCents: row.newCents });
    }
  }
  return rows;
}

/** Normaliza el JSON que devuelve `save_pricing_config` (vista previa o resultado). */
export function parsePricingConfigOutcome(data: unknown): PricingConfigOutcome {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  return {
    requiresConfirmation: record.requiresConfirmation === true,
    previousMarginBps: typeof record.previousMarginBps === "number" ? record.previousMarginBps : null,
    marginBps: count(record.marginBps),
    recalculated: count(record.recalculated),
    unchanged: count(record.unchanged),
    withoutCost: count(record.withoutCost),
    scheduledPrice: count(record.scheduledPrice),
    packsUpdated: count(record.packsUpdated),
    branchPromotionsUpdated: count(record.branchPromotionsUpdated),
    branchOverrides: count(record.branchOverrides),
    branchOverridesOther: count(record.branchOverridesOther),
    branchOverridesClosed: count(record.branchOverridesClosed),
    excludedByCategory: count(record.excludedByCategory),
    customMargin: count(record.customMargin),
    marginChanged: record.marginChanged === true,
    newlyAutomatic: count(record.newlyAutomatic),
    excludedCategoryIds: ids(record.excludedCategoryIds),
    addedExcludedCategoryIds: ids(record.addedExcludedCategoryIds),
    removedExcludedCategoryIds: ids(record.removedExcludedCategoryIds),
    sample: sampleRows(record.sample)
  };
}

function plural(value: number, singular: string, pluralText: string): string {
  return `${value.toLocaleString("es-AR")} ${value === 1 ? singular : pluralText}`;
}

/** Líneas legibles del resultado del guardado: "Productos recalculados: 1.843", "Productos sin costo: 27", "Sin cambios: 54". */
export function describePricingConfigOutcome(outcome: PricingConfigOutcome, marginChanged: boolean): string[] {
  const lines: string[] = [];
  const recalculatedByRemoval = !marginChanged && outcome.removedExcludedCategoryIds.length > 0;
  if (marginChanged) {
    lines.push(`Productos recalculados: ${outcome.recalculated.toLocaleString("es-AR")}`);
    lines.push(`Productos sin costo (conservan su precio): ${outcome.withoutCost.toLocaleString("es-AR")}`);
    lines.push(`Sin cambios: ${outcome.unchanged.toLocaleString("es-AR")}`);
    if (outcome.scheduledPrice > 0) lines.push(`Con precio programado (no se tocan): ${outcome.scheduledPrice.toLocaleString("es-AR")}`);
  } else if (recalculatedByRemoval) {
    lines.push(`Productos que pasaron a pricing automático y se recalcularon: ${outcome.recalculated.toLocaleString("es-AR")}`);
  }
  if ((marginChanged || recalculatedByRemoval) && outcome.excludedByCategory > 0) {
    lines.push(`Productos con precio manual (categorías excluidas, no se tocan): ${outcome.excludedByCategory.toLocaleString("es-AR")}`);
  }
  if ((marginChanged || recalculatedByRemoval) && outcome.customMargin > 0) {
    lines.push(`Productos con margen personalizado (no dependen del margen global, no se tocan): ${outcome.customMargin.toLocaleString("es-AR")}`);
  }
  if (outcome.branchOverridesClosed > 0) lines.push(`Precios por sucursal cerrados (rige el precio global; el historial se conserva): ${outcome.branchOverridesClosed.toLocaleString("es-AR")}`);
  if (outcome.branchOverrides > outcome.branchOverridesClosed) {
    lines.push(`ATENCIÓN: ${plural(outcome.branchOverrides - outcome.branchOverridesClosed, "precio por sucursal sigue vigente y le gana", "precios por sucursal siguen vigentes y le ganan")} al precio global en el POS`);
  }
  if (outcome.packsUpdated > 0) lines.push(`Packs actualizados: ${outcome.packsUpdated.toLocaleString("es-AR")}`);
  if (outcome.branchPromotionsUpdated > 0) lines.push(`Sucursales con los descuentos por cantidad actualizados: ${outcome.branchPromotionsUpdated.toLocaleString("es-AR")}`);
  return lines;
}

/**
 * Vista previa que pide confirmar (cambio de margen y/o categorías que salen de la exclusión). Una línea por dato: cuánto se recalcula, qué
 * NO cambia (excluidos por categoría, sin costo, ya con ese precio) y qué categorías siguen excluidas. `categoryNames`: id → nombre para
 * mostrar «Vaca · Cerdo · Pollo» (el servidor sólo devuelve ids).
 */
export function describePricingConfigPreview(outcome: PricingConfigOutcome, categoryNames: Readonly<Record<string, string>> = {}): string[] {
  const n = (value: number) => value.toLocaleString("es-AR");
  const names = (list: string[]) => list.map((id) => categoryNames[id] ?? "Categoría").join(" · ");
  const lines: string[] = [];
  lines.push(outcome.marginChanged ? `Margen nuevo: ${formatBasisPointsPercent(outcome.marginBps)}%` : `Margen: ${formatBasisPointsPercent(outcome.marginBps)}% (sin cambios)`);
  lines.push(`Se recalcularán (automáticos con margen global): ${plural(outcome.recalculated, "producto", "productos")}`);
  lines.push(`Margen personalizado (no se tocan): ${n(outcome.customMargin)}`);
  lines.push(`Excluidos / precio manual (conservan su precio): ${n(outcome.excludedByCategory)}`);
  lines.push(`Sin costo (conservan su precio): ${n(outcome.withoutCost)}`);
  lines.push(`Ya tienen ese precio: ${n(outcome.unchanged)}`);
  if (outcome.scheduledPrice > 0) lines.push(`Con precio programado (no se tocan): ${n(outcome.scheduledPrice)}`);
  lines.push(`Con precio por sucursal: ${n(outcome.branchOverrides)}`);
  if (outcome.removedExcludedCategoryIds.length > 0) {
    lines.push(`Pasan a pricing automático (salen de la exclusión: ${names(outcome.removedExcludedCategoryIds)}): ${plural(outcome.newlyAutomatic, "producto", "productos")}`);
  }
  lines.push(`Categorías excluidas: ${outcome.excludedCategoryIds.length > 0 ? names(outcome.excludedCategoryIds) : "ninguna"}`);
  return lines;
}

/** Advertencias de la vista previa (no son conteos). */
export function describePricingConfigPreviewNotes(outcome: PricingConfigOutcome): string[] {
  const notes: string[] = [];
  if (outcome.excludedByCategory > 0) notes.push("Los productos de las categorías excluidas NO van a cambiar de precio: su costo se sigue guardando para la rentabilidad.");
  if (outcome.removedExcludedCategoryIds.length > 0) notes.push("Las categorías que salen de la exclusión empiezan a repreciarse con el margen: se abre una vigencia nueva de precio por producto (el precio manual anterior queda en el historial).");
  notes.push("Los precios anteriores quedan en el historial.");
  if (outcome.branchOverrides > 0) {
    notes.push(`ATENCIÓN: ${plural(outcome.branchOverrides, "producto tiene un precio propio de sucursal que", "productos tienen un precio propio de sucursal que")} le ganaría al precio global en el POS: elegí abajo si cerrarlos (se conserva el historial).`);
  }
  if (outcome.branchOverridesOther > 0) {
    notes.push(`Además hay ${plural(outcome.branchOverridesOther, "precio por sucursal", "precios por sucursal")} de productos que este recálculo no toca (sin costo, programados, excluidos o inactivos).`);
  }
  return notes;
}

/** Hasta 10 precios que cambiarían: «Aceite: $ 10.000,00 → $ 14.285,71». */
export function describePricingConfigSample(outcome: PricingConfigOutcome): string[] {
  return outcome.sample.map((row) => `${row.name}: ${row.currentCents !== null ? formatCurrency(BigInt(row.currentCents)) : "sin precio"} → ${formatCurrency(BigInt(row.newCents))}`);
}
