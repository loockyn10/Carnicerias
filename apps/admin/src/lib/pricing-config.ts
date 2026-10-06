import { percentageToBasisPointsAllowZero, text } from "./form-parsing";

/**
 * Configuración global de precios (D-068): margen de ganancia sobre el PRECIO DE VENTA, "% dto llevando 3u", "% dto por pack" y
 * recargo por tarjeta. Puro y con tests; el servidor (`save_pricing_config`) vuelve a validar todo.
 */

export interface PricingConfigInput {
  marginBps: number;
  unitBulkDiscountBps: number;
  packDiscountBps: number;
  cardSurchargeBps: number;
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

/** Los cuatro valores del formulario, en basis points enteros (nunca floats). Margen: > 0 y < 100 %; dto 3u, dto pack y tarjeta: 0 ≤ % < 100 (el pack con 0 % sigue siendo un pack, sin descuento). */
export function parsePricingConfigForm(formData: FormData): PricingConfigInput {
  return {
    marginBps: percent(text(formData, "margin"), "El margen de ganancia", { allowZero: false }),
    unitBulkDiscountBps: percent(text(formData, "unit_bulk"), "El descuento llevando 3u", { allowZero: true }),
    packDiscountBps: percent(text(formData, "pack"), "El descuento por pack", { allowZero: true }),
    cardSurchargeBps: percent(text(formData, "card"), "El recargo por tarjeta", { allowZero: true })
  };
}

export interface PricingConfigOutcome {
  /** true = el margen cambió y falta confirmar: no se escribió nada. */
  requiresConfirmation: boolean;
  previousMarginBps: number | null;
  marginBps: number;
  /** Productos cuyo precio se recalculó (o se recalcularía, en la vista previa). */
  recalculated: number;
  /** Productos que ya tenían ese precio. */
  unchanged: number;
  /** Productos de venta sin costo vigente: conservan su precio. */
  withoutCost: number;
  /** Productos con un precio global programado a futuro: se respeta. */
  scheduledPrice: number;
  packsUpdated: number;
  branchPromotionsUpdated: number;
  /** Precios VIGENTES por sucursal de productos que este recálculo reprecia: en el POS le ganan al precio global recién formado. */
  branchOverrides: number;
  /** Precios por sucursal de productos que quedan fuera del recálculo (sin costo, programados, inactivos). */
  branchOverridesOther: number;
  /** Precios por sucursal que se cerraron (conservan su historial). */
  branchOverridesClosed: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
    branchOverridesClosed: count(record.branchOverridesClosed)
  };
}

function plural(value: number, singular: string, pluralText: string): string {
  return `${value.toLocaleString("es-AR")} ${value === 1 ? singular : pluralText}`;
}

/** Líneas legibles del resultado del guardado: "Productos recalculados: 1.843", "Productos sin costo: 27", "Sin cambios: 54". */
export function describePricingConfigOutcome(outcome: PricingConfigOutcome, marginChanged: boolean): string[] {
  const lines: string[] = [];
  if (marginChanged) {
    lines.push(`Productos recalculados: ${outcome.recalculated.toLocaleString("es-AR")}`);
    lines.push(`Productos sin costo (conservan su precio): ${outcome.withoutCost.toLocaleString("es-AR")}`);
    lines.push(`Sin cambios: ${outcome.unchanged.toLocaleString("es-AR")}`);
    if (outcome.scheduledPrice > 0) lines.push(`Con precio programado (no se tocan): ${outcome.scheduledPrice.toLocaleString("es-AR")}`);
  }
  if (outcome.branchOverridesClosed > 0) lines.push(`Precios por sucursal cerrados (rige el precio global; el historial se conserva): ${outcome.branchOverridesClosed.toLocaleString("es-AR")}`);
  if (outcome.branchOverrides > outcome.branchOverridesClosed) {
    lines.push(`ATENCIÓN: ${plural(outcome.branchOverrides - outcome.branchOverridesClosed, "precio por sucursal sigue vigente y le gana", "precios por sucursal siguen vigentes y le ganan")} al precio global en el POS`);
  }
  if (outcome.packsUpdated > 0) lines.push(`Packs actualizados: ${outcome.packsUpdated.toLocaleString("es-AR")}`);
  if (outcome.branchPromotionsUpdated > 0) lines.push(`Sucursales con la promoción actualizada: ${outcome.branchPromotionsUpdated.toLocaleString("es-AR")}`);
  return lines;
}

/** Mensaje de la vista previa que pide confirmar un cambio de margen. */
export function describePricingConfigPreview(outcome: PricingConfigOutcome): string {
  const recalculated = `Cambiar el margen va a recalcular el precio de lista de ${plural(outcome.recalculated, "producto", "productos")}`;
  const withoutCost = `${plural(outcome.withoutCost, "producto sin costo conserva", "productos sin costo conservan")} su precio`;
  const unchanged = `${plural(outcome.unchanged, "producto ya tiene", "productos ya tienen")} ese precio`;
  const overrides = outcome.branchOverrides > 0
    ? ` ATENCIÓN: ${plural(outcome.branchOverrides, "producto tiene un precio propio de sucursal que", "productos tienen un precio propio de sucursal que")} le ganaría al precio global en el POS: elegí abajo si cerrarlos (se conserva el historial).`
    : "";
  const elsewhere = outcome.branchOverridesOther > 0
    ? ` Además hay ${plural(outcome.branchOverridesOther, "precio por sucursal", "precios por sucursal")} de productos que este recálculo no toca (sin costo, programados o inactivos).`
    : "";
  return `${recalculated}; ${withoutCost}; ${unchanged}. Los precios anteriores quedan en el historial.${overrides}${elsewhere}`;
}
