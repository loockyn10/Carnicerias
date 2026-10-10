import { formatCurrency, formatStockQuantity, type StockUnit } from "@carnicerias/business-logic";

/**
 * «Completar costos faltantes» del Resumen de sucursal (D-080). Este módulo sólo VALIDA las respuestas de
 * `get_missing_sale_costs` / `complete_missing_sale_costs` y hace las cuentas de PRESENTACIÓN (cuánto costaría cada línea con el costo
 * tipeado). La reparación, los permisos, el aislamiento por organización/sucursal y la fórmula real del costo viven en el servidor:
 * acá nunca se arma un total por línea para enviar, sólo el costo POR MEDIDA ($/kg o $/u) y los ids de línea que se vieron.
 */

export interface MissingCostLine {
  lineId: string;
  saleId: string;
  soldAt: string;
  /** Gramos (WEIGHT) o unidades (UNIT). */
  quantity: number;
  /** Importe cobrado de la línea: subtotal - descuento general del ticket. */
  revenueCents: number;
}

export interface MissingCostProduct {
  productId: string;
  productName: string;
  unitType: StockUnit;
  quantity: number;
  lineCount: number;
  revenueCents: number;
  /** Datos de precios: sólo llegan si el usuario tiene prices.write (si no, null / false). */
  currentCostCents: number | null;
  currentPriceCents: number | null;
  marginBps: number | null;
  /** Guardar un costo vigente nuevo recalcularía el precio de venta (margen efectivo propio o global, producto vendible). */
  repricesOnCostChange: boolean;
  lines: MissingCostLine[];
}

export interface MissingCostsReport {
  canRepair: boolean;
  timezone: string;
  totalLines: number;
  totalRevenueCents: number;
  /** Hay más líneas que las devueltas (tope por llamada): se completan por tandas. */
  truncated: boolean;
  products: MissingCostProduct[];
}

export interface CompleteMissingCostsOutcome {
  repairedLines: number;
  skippedLines: number;
  repairedRevenueCents: number;
  unitCostCents: number;
  currentCostSaved: boolean;
  currentCostUnchanged: boolean;
  /** REPRICED | UNCHANGED | SCHEDULED | NO_MARGIN | NOT_SELLABLE | MANUAL_PRICE; null si no se tocó el costo vigente. */
  priceOutcome: string | null;
}

const UNEXPECTED = "Respuesta inesperada de los costos faltantes";
type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(UNEXPECTED);
  return value as Obj;
}
function int(source: Obj, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(UNEXPECTED);
  return value;
}
function intOrNull(source: Obj, key: string): number | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(UNEXPECTED);
  return value;
}
function str(source: Obj, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(UNEXPECTED);
  return value;
}
function bool(source: Obj, key: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new Error(UNEXPECTED);
  return value;
}
function list(source: Obj, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(UNEXPECTED);
  return value;
}

export function parseMissingCosts(value: unknown): MissingCostsReport {
  const root = obj(value);
  return {
    canRepair: bool(root, "canRepair"),
    timezone: str(root, "timezone"),
    totalLines: int(root, "totalLines"),
    totalRevenueCents: int(root, "totalRevenueCents"),
    truncated: bool(root, "truncated"),
    products: list(root, "products").map((entry): MissingCostProduct => {
      const row = obj(entry);
      const unitType = str(row, "unitType");
      if (unitType !== "WEIGHT" && unitType !== "UNIT") throw new Error(UNEXPECTED);
      return {
        productId: str(row, "productId"), productName: str(row, "productName"), unitType,
        quantity: int(row, "quantity"), lineCount: int(row, "lineCount"), revenueCents: int(row, "revenueCents"),
        currentCostCents: intOrNull(row, "currentCostCents"), currentPriceCents: intOrNull(row, "currentPriceCents"), marginBps: intOrNull(row, "marginBps"),
        repricesOnCostChange: bool(row, "repricesOnCostChange"),
        lines: list(row, "lines").map((lineEntry): MissingCostLine => {
          const line = obj(lineEntry);
          return { lineId: str(line, "lineId"), saleId: str(line, "saleId"), soldAt: str(line, "soldAt"), quantity: int(line, "quantity"), revenueCents: int(line, "revenueCents") };
        })
      };
    })
  };
}

export function parseCompleteOutcome(value: unknown): CompleteMissingCostsOutcome {
  const root = obj(value);
  const outcome = root.priceOutcome;
  return {
    repairedLines: int(root, "repairedLines"), skippedLines: int(root, "skippedLines"), repairedRevenueCents: int(root, "repairedRevenueCents"),
    unitCostCents: int(root, "unitCostCents"), currentCostSaved: bool(root, "currentCostSaved"), currentCostUnchanged: bool(root, "currentCostUnchanged"),
    priceOutcome: typeof outcome === "string" ? outcome : null
  };
}

/** «/kg» para un producto de peso y «/u» para uno por unidad: el costo siempre se carga POR MEDIDA. */
export function costUnitSuffix(unitType: StockUnit): string {
  return unitType === "WEIGHT" ? "/kg" : "/u";
}

/** «$ 3.800/kg» o «$ 2.000/u». */
export function formatCostPerMeasure(cents: number, unitType: StockUnit): string {
  return `${formatCurrency(BigInt(cents))}${costUnitSuffix(unitType)}`;
}

/**
 * Costo total de UNA línea con un costo por medida: la misma regla que `app_private.sale_item_cost_cents` (UNIT: costo × unidades;
 * WEIGHT: round(costo × gramos / 1000), mitad hacia arriba), en enteros (BigInt), sin floats. Sólo para mostrar cuánto sumaría el costo
 * tipeado: el valor que queda guardado es el costo por medida y el servidor deriva el total.
 */
export function lineCostCents(unitType: StockUnit, unitCostCents: number, quantity: number): number {
  const product = BigInt(unitCostCents) * BigInt(quantity);
  return Number(unitType === "UNIT" ? product : (product + 500n) / 1000n);
}

/** Suma del costo de las líneas del producto con el costo tipeado (cada línea se redondea por separado, como el servidor). */
export function productCostTotalCents(product: Pick<MissingCostProduct, "unitType" | "lines">, unitCostCents: number): number {
  return product.lines.reduce((sum, line) => sum + lineCostCents(product.unitType, unitCostCents, line.quantity), 0);
}

/**
 * ¿Viene tildado «Guardar también como costo vigente»? Sólo cuando hacerlo NO toca el precio de venta. Si repreciaría, arranca destildado
 * y la fila lo explica: completar un costo histórico nunca puede cambiar un precio sin que Fran lo decida.
 */
export function defaultAlsoSetCurrentCost(product: Pick<MissingCostProduct, "repricesOnCostChange">): boolean {
  return !product.repricesOnCostChange;
}

/** «12,5 kg» / «8 u» de la cantidad vendida de un producto. */
export function formatMissingQuantity(unitType: StockUnit, quantity: number): string {
  return formatStockQuantity(quantity, unitType);
}

/** «1 línea» / «11 líneas». */
export function linesLabel(count: number): string {
  return count === 1 ? "1 línea" : `${String(count)} líneas`;
}

/** Texto de resultado para la confirmación en la pantalla. */
export function describeOutcome(productName: string, unitType: StockUnit, outcome: CompleteMissingCostsOutcome): string {
  const cost = formatCostPerMeasure(outcome.unitCostCents, unitType);
  const base = outcome.repairedLines === 0
    ? `${productName}: no había líneas para completar (ya tenían costo)`
    : `${productName}: ${linesLabel(outcome.repairedLines)} completada${outcome.repairedLines === 1 ? "" : "s"} con ${cost}`;
  const one = outcome.skippedLines === 1;
  const skipped = outcome.skippedLines > 0 ? ` · ${linesLabel(outcome.skippedLines)} ya no ${one ? "estaba" : "estaban"} sin costo y no se ${one ? "tocó" : "tocaron"}` : "";
  if (outcome.currentCostSaved) {
    return `${base}${skipped} · costo actual guardado${outcome.priceOutcome === "REPRICED" ? " y precio de venta recalculado" : ""}`;
  }
  return `${base}${skipped}${outcome.currentCostUnchanged ? " · el costo actual ya era ese" : ""}`;
}
