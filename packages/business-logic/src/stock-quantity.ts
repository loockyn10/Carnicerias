/**
 * Stock quantities live in ONE ledger column (`stock_movements.quantity_grams`): grams for a
 * WEIGHT product, whole units for a UNIT product (D-038/D-042). These helpers are the only place
 * the UI converts between what an operator reads/types and that raw ledger number, so a kilogram
 * figure is never shown for a unit count (or the other way around).
 */

export type StockUnit = "WEIGHT" | "UNIT";

const KG_FORMATTER = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const UNITS_FORMATTER = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

/** "kg" for weighed products, "u" for counted ones. */
export function stockUnitLabel(unitType: StockUnit): string {
  return unitType === "WEIGHT" ? "kg" : "u";
}

/** Operator-facing text of a raw ledger quantity: "8,000 kg" or "24 u". Negative stock is kept. */
export function formatStockQuantity(quantity: number, unitType: StockUnit): string {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError("Stock quantity must be a safe integer (grams or units)");
  }
  return unitType === "WEIGHT" ? `${KG_FORMATTER.format(quantity / 1_000)} kg` : `${UNITS_FORMATTER.format(quantity)} u`;
}

export interface ParseStockQuantityOptions {
  /** A physical count may legitimately be 0; a purchase/waste/transfer may not. Default false. */
  allowZero?: boolean;
}

/**
 * Converts what the operator typed into the raw ledger quantity: kilograms (comma or dot, up to 3
 * decimals) -> grams for WEIGHT, a whole number -> units for UNIT. Throws RangeError with a
 * message meant to be shown to the operator.
 */
export function parseStockQuantityInput(raw: string, unitType: StockUnit, options: ParseStockQuantityOptions = {}): number {
  const text = raw.trim().replace(",", ".");
  let quantity: number;
  if (unitType === "WEIGHT") {
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
    if (!match) throw new RangeError("Ingresá los kilos con hasta tres decimales (ej. 2,5)");
    quantity = Number(BigInt(match[1] ?? "0") * 1_000n + BigInt((match[2] ?? "").padEnd(3, "0")));
  } else {
    if (!/^\d+$/.test(text)) throw new RangeError("Ingresá una cantidad entera de unidades");
    quantity = Number(text);
  }
  if (!Number.isSafeInteger(quantity)) throw new RangeError("La cantidad es demasiado grande");
  if (quantity === 0 && !options.allowZero) throw new RangeError("La cantidad debe ser mayor a cero");
  return quantity;
}

/** Grams -> the kilogram string a form field shows back ("2,5"), or whole units as-is. */
export function stockQuantityToInput(quantity: number, unitType: StockUnit): string {
  return unitType === "WEIGHT"
    ? (quantity / 1_000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",")
    : String(quantity);
}
