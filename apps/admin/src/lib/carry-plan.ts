import { parseStockQuantityInput, stockQuantityToInput, type StockUnit } from "@carnicerias/business-logic";

/**
 * "Qué llevar ahora": presentación del informe que calcula `get_branch_carry_plan` (la FÓRMULA vive
 * sólo en SQL, sobre la misma base que `get_replenishment_plan`: sugerido = max(vendido 7d − stock
 * actual, 0), con el stock negativo contado como 0). Este módulo no recalcula nada: agrupa por
 * sucursal, oculta lo que no necesita carga y valida las cantidades que el operador ajusta en
 * pantalla ("A llevar ahora"). Esas cantidades viven sólo en el estado de la pantalla.
 *
 * Las cantidades son crudas, como en el ledger: gramos para WEIGHT, unidades enteras para UNIT.
 */

export interface CarryPlanRow {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  unitType: StockUnit;
  soldQuantity: number;
  currentQuantity: number;
  suggestedQuantity: number;
}

export interface CarryPlanReport {
  /** ISO del instante del cálculo. */
  calculatedAt: string;
  /** ISO del inicio de la ventana de demanda (medianoche local de hace 6 días). */
  windowStart: string;
  windowDays: number;
  rows: CarryPlanRow[];
}

export interface CarryBranchGroup {
  branchId: string;
  branchName: string;
  /** Filas a mostrar (con necesidad, o todas si `showAll`). */
  rows: CarryPlanRow[];
  /** Cuántas filas del surtido quedan ocultas por no necesitar carga. */
  hiddenCount: number;
}

export const carryKey = (row: Pick<CarryPlanRow, "branchId" | "productId">) => `${row.branchId}:${row.productId}`;

/** Agrupa por sucursal conservando el orden que ya trae el servidor (mayor necesidad primero). */
export function groupCarryPlan(rows: readonly CarryPlanRow[], options: { showAll: boolean }): CarryBranchGroup[] {
  const groups = new Map<string, CarryBranchGroup>();
  for (const row of rows) {
    let group = groups.get(row.branchId);
    if (!group) {
      group = { branchId: row.branchId, branchName: row.branchName, rows: [], hiddenCount: 0 };
      groups.set(row.branchId, group);
    }
    if (options.showAll || row.suggestedQuantity > 0) group.rows.push(row);
    else group.hiddenCount += 1;
  }
  return [...groups.values()];
}

/** Valor inicial de cada campo "A llevar ahora": el sugerido, en kg (coma decimal) o unidades. */
export function initialCarryInputs(rows: readonly CarryPlanRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [carryKey(row), stockQuantityToInput(row.suggestedQuantity, row.unitType)]));
}

export interface CarryQuantity {
  /** Gramos (WEIGHT) o unidades (UNIT); null si lo escrito no es válido. */
  quantity: number | null;
  error?: string;
}

/**
 * Convierte lo que escribió el operador en cantidades crudas. Sin negativos; WEIGHT en kg con hasta
 * 3 decimales (conversión exacta a gramos, sin flotantes); UNIT sólo enteros. Cero es válido: "no
 * llevo nada de esto".
 */
export function resolveCarryQuantity(raw: string, unitType: StockUnit): CarryQuantity {
  try {
    return { quantity: parseStockQuantityInput(raw, unitType, { allowZero: true }) };
  } catch (error) {
    return { quantity: null, error: error instanceof RangeError ? error.message : "Cantidad inválida" };
  }
}

/** Total a llevar por tipo de cantidad (kg y unidades nunca se suman entre sí). Ignora campos inválidos. */
export function carryTotals(rows: readonly CarryPlanRow[], inputs: Readonly<Record<string, string>>): { grams: number; units: number; invalid: number } {
  let grams = 0;
  let units = 0;
  let invalid = 0;
  for (const row of rows) {
    const { quantity } = resolveCarryQuantity(inputs[carryKey(row)] ?? "", row.unitType);
    if (quantity === null) { invalid += 1; continue; }
    if (row.unitType === "WEIGHT") grams += quantity; else units += quantity;
  }
  return { grams, units, invalid };
}
