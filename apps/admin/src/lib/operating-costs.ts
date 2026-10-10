import { formatCurrency } from "@carnicerias/business-logic";

import { parseCostCents } from "./bulk-costs";
import { formatIsoDate, isIsoDate, shiftIsoDate } from "./date-range";

/**
 * Costos operativos por sucursal y RESULTADO OPERATIVO (D-082). Este módulo sólo VALIDA las respuestas de
 * `get_branch_operating_result` / `get_branch_operating_costs` y arma lo que se MUESTRA. Ninguna cuenta del resultado se hace acá: la
 * ganancia bruta sale del motor de rentabilidad existente y el prorrateo de los costos mensuales (por días reales de cada mes, con la zona
 * horaria de la organización) lo hace el servidor. Lo único que viaja del navegador son importes en centavos, fechas y nombres.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | null => typeof value === "string" ? value : null;
const asInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const asDate = (value: unknown): string | null => typeof value === "string" && isIsoDate(value.slice(0, 10)) ? value.slice(0, 10) : null;

// ---------------------------------------------------------------------------------------------------------------------
// Resultado operativo (tarjeta del detalle de sucursal y del Inicio)
// ---------------------------------------------------------------------------------------------------------------------

/** Una fila de `get_branch_operating_result` ya en camelCase. */
export interface OperatingResult {
  branchId: string;
  branchName: string;
  revenueCents: number;
  grossProfitCents: number;
  recurringCostCents: number;
  expenseCents: number;
  operatingCostCents: number;
  resultCents: number;
  /** Resultado / ventas en basis points; null si no hubo ventas. */
  marginBps: number | null;
  /** Hay líneas vendidas sin costo histórico: el resultado NO es exacto. */
  partial: boolean;
  missingCostItems: number;
  missingCostSales: number;
  missingCostRevenueCents: number;
  /** Costo de personal automático (horas fichadas x valor hora, D-085): ya está INCLUIDO en operatingCostCents y en resultCents. */
  laborCostCents: number;
  laborWorkedSeconds: number;
  /** Fichadas abiertas dentro del período: su costo crece con el tiempo (la pantalla se refresca sola mientras haya alguna). */
  laborOpenShifts: number;
  /** Fichadas a revisar (salida inferida o excedida). */
  laborReviewShifts: number;
  /** Hay horas sin valor hora cargado: el costo de personal está incompleto. */
  laborRateMissing: boolean;
}

export interface OperatingResultRow {
  branch_id: string;
  branch_name: string;
  revenue_cents: number;
  gross_profit_cents: number;
  recurring_cost_cents: number;
  expense_cents: number;
  operating_cost_cents: number;
  operating_result_cents: number;
  operating_margin_bps: number | null;
  is_partial: boolean;
  missing_cost_items: number;
  missing_cost_sales: number;
  missing_cost_revenue_cents: number;
  // Personal (202610200083): opcionales para tolerar un servidor que todavía no tiene la migración (cuentan como 0).
  labor_cost_cents?: number;
  labor_worked_seconds?: number;
  labor_open_shifts?: number;
  labor_review_shifts?: number;
  labor_rate_missing?: boolean;
}

export function toOperatingResult(row: OperatingResultRow): OperatingResult {
  return {
    branchId: row.branch_id, branchName: row.branch_name, revenueCents: row.revenue_cents, grossProfitCents: row.gross_profit_cents,
    recurringCostCents: row.recurring_cost_cents, expenseCents: row.expense_cents, operatingCostCents: row.operating_cost_cents,
    resultCents: row.operating_result_cents, marginBps: row.operating_margin_bps, partial: row.is_partial,
    missingCostItems: row.missing_cost_items, missingCostSales: row.missing_cost_sales, missingCostRevenueCents: row.missing_cost_revenue_cents,
    laborCostCents: row.labor_cost_cents ?? 0, laborWorkedSeconds: row.labor_worked_seconds ?? 0, laborOpenShifts: row.labor_open_shifts ?? 0,
    laborReviewShifts: row.labor_review_shifts ?? 0, laborRateMissing: row.labor_rate_missing === true
  };
}

/** "$ 1.165.000" / "-$ 120.000" (el signo va delante del $, igual que el resto del sistema). */
export function formatResult(cents: number): string {
  return formatCurrency(BigInt(cents));
}

export interface OperatingTotal {
  resultCents: number;
  /** Alguna sucursal tiene ventas sin costo conocido: el total tampoco es exacto. */
  partial: boolean;
  branches: number;
}

/** Suma de las sucursales visibles: es la suma de los resultados que calculó el servidor (no se recalcula nada). */
export function sumOperatingResults(results: readonly OperatingResult[]): OperatingTotal {
  return { resultCents: results.reduce((sum, result) => sum + result.resultCents, 0), partial: results.some((result) => result.partial), branches: results.length };
}

/** Alguna sucursal tiene una fichada abierta: su costo de personal sigue corriendo, así que el resultado se vuelve a pedir cada tanto. */
export function hasOpenLaborShifts(results: readonly OperatingResult[]): boolean {
  return results.some((result) => result.laborOpenShifts > 0);
}

/** Cada cuánto se vuelve a pedir el resultado mientras haya fichadas abiertas (no hace falta cada segundo: el costo crece por minuto). */
export const LABOR_REFRESH_MS = 120_000;

export const PARTIAL_NOTE = "Parcial: existen ventas sin costo";
export const LABOR_RATE_MISSING_NOTE = "Hay horas de personal sin valor hora cargado";
export const NO_COSTS_NOTE = "Sin costos operativos cargados: el resultado es igual a la ganancia bruta";

// ---------------------------------------------------------------------------------------------------------------------
// Modal «Costos operativos»
// ---------------------------------------------------------------------------------------------------------------------

export interface CostVersion {
  id: string;
  amountCents: number;
  /** Primer día en que rige. */
  from: string;
  /** Primer día en que YA NO rige (exclusivo); null = vigente. */
  to: string | null;
}

export type RecurringStatus = "ACTIVE" | "SCHEDULED" | "ENDED";

export interface RecurringCost {
  id: string;
  name: string;
  /** Importe mensual que rige hoy (o el último que tuvo / el programado). */
  amountCents: number;
  /** Desde cuándo rige ese importe. */
  amountFrom: string;
  /** Hasta cuándo rige (último día incluido) si ya tiene baja; null = sin fecha de baja. */
  lastDay: string | null;
  status: RecurringStatus;
  /** Lo imputado al período elegido (importe * días del período / días de cada mes). */
  imputedCents: number;
  /** Versiones en orden cronológico (las correcciones vacías del mismo día no se muestran). */
  history: CostVersion[];
}

export interface BranchExpense {
  id: string;
  date: string;
  concept: string;
  amountCents: number;
  /** El gasto cae dentro del período del Resumen (se imputa a ese resultado). */
  inPeriod: boolean;
}

/** Una persona en la sección «Personal — automático» (horas fichadas en ESTA sucursal x su valor hora). */
export interface LaborEmployee {
  employeeId: string;
  name: string;
  workedSeconds: number;
  costCents: number;
  /** Valor hora más bajo y más alto usados en el período (distintos si cambió de valor dentro del período). */
  minRateCents: number | null;
  maxRateCents: number | null;
  /** Parte de sus horas no tiene valor hora cargado. */
  rateMissing: boolean;
  openShifts: number;
  reviewShifts: number;
}

/** Personal de la sucursal en el período (D-085). `employees` viene vacío sin el permiso de control horario (`canSeeDetail` false). */
export interface LaborReport {
  costCents: number;
  workedSeconds: number;
  openShifts: number;
  reviewShifts: number;
  rateMissing: boolean;
  canSeeDetail: boolean;
  employees: LaborEmployee[];
}

export interface OperatingCostsReport {
  canWrite: boolean;
  /** Hoy en la zona horaria de la organización (YYYY-MM-DD). */
  today: string;
  period: { from: string; to: string };
  recurring: RecurringCost[];
  expenses: BranchExpense[];
  recurringCents: number;
  expenseCents: number;
  /** Personal automático del período; null si el servidor todavía no tiene la migración de personal. */
  labor: LaborReport | null;
  /** Total imputado al período: costos mensuales + gastos + personal. */
  operatingCostCents: number;
}

function parseLaborEmployee(raw: unknown): LaborEmployee | null {
  if (!isRecord(raw)) return null;
  const employeeId = asString(raw.employeeId);
  const name = asString(raw.name);
  const workedSeconds = asInteger(raw.workedSeconds);
  const costCents = asInteger(raw.costCents);
  if (!employeeId || name === null || workedSeconds === null || costCents === null) return null;
  return {
    employeeId, name, workedSeconds, costCents, minRateCents: asInteger(raw.minRateCents), maxRateCents: asInteger(raw.maxRateCents),
    rateMissing: raw.rateMissing === true, openShifts: asInteger(raw.openShifts) ?? 0, reviewShifts: asInteger(raw.reviewShifts) ?? 0
  };
}

function parseLabor(raw: unknown): LaborReport | null {
  if (!isRecord(raw)) return null;
  const costCents = asInteger(raw.costCents);
  const workedSeconds = asInteger(raw.workedSeconds);
  if (costCents === null || workedSeconds === null) return null;
  return {
    costCents, workedSeconds, openShifts: asInteger(raw.openShifts) ?? 0, reviewShifts: asInteger(raw.reviewShifts) ?? 0, rateMissing: raw.rateMissing === true,
    canSeeDetail: raw.canSeeDetail === true,
    employees: (Array.isArray(raw.employees) ? raw.employees as unknown[] : []).map(parseLaborEmployee).filter((employee): employee is LaborEmployee => employee !== null)
  };
}

function parseVersion(raw: unknown): CostVersion | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const amountCents = asInteger(raw.amountCents);
  const from = asDate(raw.from);
  if (!id || amountCents === null || from === null) return null;
  const to = raw.to === null || raw.to === undefined ? null : asDate(raw.to);
  if (raw.to !== null && raw.to !== undefined && to === null) return null;
  return { id, amountCents, from, to };
}

/** Estado de un costo mensual respecto de HOY, y cuál de sus versiones es la que se muestra. */
export function describeRecurring(history: readonly CostVersion[], today: string): { status: RecurringStatus; shown: CostVersion } | null {
  const last = history[history.length - 1];
  if (!last) return null;
  const current = history.find((version) => version.from <= today && (version.to === null || version.to > today));
  if (current) return { status: "ACTIVE", shown: current };
  return { status: last.to === null ? "SCHEDULED" : "ENDED", shown: last };
}

function parseRecurring(raw: unknown, today: string): RecurringCost | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const name = asString(raw.name);
  const imputedCents = asInteger(raw.imputedCents);
  if (!id || name === null || imputedCents === null || !Array.isArray(raw.history)) return null;
  const history = (raw.history as unknown[]).map(parseVersion).filter((version): version is CostVersion => version !== null)
    .sort((a, b) => a.from.localeCompare(b.from));
  const described = describeRecurring(history, today);
  if (!described) return null;
  const { status, shown } = described;
  return {
    id, name, amountCents: shown.amountCents, amountFrom: shown.from, lastDay: shown.to === null ? null : shown.to <= shown.from ? shown.from : shiftIsoDate(shown.to, -1),
    status, imputedCents, history
  };
}

function parseExpense(raw: unknown): BranchExpense | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const date = asDate(raw.date);
  const concept = asString(raw.concept);
  const amountCents = asInteger(raw.amountCents);
  if (!id || date === null || concept === null || amountCents === null) return null;
  return { id, date, concept, amountCents, inPeriod: raw.inPeriod === true };
}

/** JSON de `get_branch_operating_costs` → modelo del modal. Un campo raro descarta esa fila, nunca rompe la pantalla. */
export function parseOperatingCosts(raw: unknown): OperatingCostsReport {
  if (!isRecord(raw)) throw new Error("Respuesta inválida del servidor");
  const today = asDate(raw.today);
  const period = isRecord(raw.period) ? { from: asDate(raw.period.from), to: asDate(raw.period.to) } : null;
  const recurringCents = asInteger(raw.recurringCents);
  const expenseCents = asInteger(raw.expenseCents);
  const operatingCostCents = asInteger(raw.operatingCostCents);
  if (today === null || !period?.from || !period.to || recurringCents === null || expenseCents === null || operatingCostCents === null) {
    throw new Error("Respuesta inválida del servidor");
  }
  const recurring = (Array.isArray(raw.recurring) ? raw.recurring as unknown[] : []).map((item) => parseRecurring(item, today))
    .filter((cost): cost is RecurringCost => cost !== null);
  const expenses = (Array.isArray(raw.expenses) ? raw.expenses as unknown[] : []).map(parseExpense).filter((expense): expense is BranchExpense => expense !== null);
  return { canWrite: raw.canWrite === true, today, period: { from: period.from, to: period.to }, recurring, expenses, recurringCents, expenseCents, labor: parseLabor(raw.labor), operatingCostCents };
}

// ---------------------------------------------------------------------------------------------------------------------
// Personal — automático (D-085): sólo se MUESTRA lo que calcula el servidor
// ---------------------------------------------------------------------------------------------------------------------

/** "10 h", "7 h 30 min", "45 min": las horas trabajadas con los minutos exactos (sin redondear a horas enteras). */
export function formatWorked(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${String(minutes)} min`;
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

/** "$ 4.000 / hora" o "$ 3.500 – $ 4.000 / hora" si el valor cambió dentro del período; "Sin valor hora" si no hay ninguno. */
export function formatHourlyRate(employee: Pick<LaborEmployee, "minRateCents" | "maxRateCents">): string {
  const { minRateCents: min, maxRateCents: max } = employee;
  if (min === null || max === null) return "Sin valor hora";
  const money = (cents: number) => formatCurrency(BigInt(cents));
  return min === max ? `${money(min)} / hora` : `${money(min)} – ${money(max)} / hora`;
}

/** "hoy" si el período es sólo el día de hoy; si no, "el 09/10" o "del 01/10 al 10/10" (para el total de Personal). */
export function laborPeriodName(period: { from: string; to: string }, today: string): string {
  if (period.from === today && period.to === today) return "hoy";
  if (period.from === period.to) return `el ${formatIsoDate(period.from)}`;
  return `del ${formatIsoDate(period.from)} al ${formatIsoDate(period.to)}`;
}

/**
 * Un costo mensual cargado a mano que probablemente sea el sueldo de una empleada («Sueldo Lucía», «Empleada», «Personal»...). Con el
 * personal calculado por horas ESTE costo duplicaría el gasto: la pantalla lo señala (no se borra nada solo).
 */
export function looksLikePersonnelCost(name: string): boolean {
  return /\b(sueldos?|salarios?|emplead[oa]s?|personal|jornal(?:es)?|haberes|n[oó]mina|mano de obra)\b/i.test(name);
}

export const LABOR_AUTOMATIC_NOTE = "Se calcula solo con las horas fichadas y el valor hora de cada persona: no cargues sueldos de empleadas como costo mensual.";
export const LABOR_DUPLICATE_NOTE = "Posible duplicado: el personal ya se calcula por horas fichadas.";

/** "dd/mm" para las listas del modal (sin año si es el año de `today`). */
export function formatShortDate(iso: string, today: string): string {
  const full = formatIsoDate(iso);
  return iso.slice(0, 4) === today.slice(0, 4) ? full.slice(0, 5) : full;
}

/** "$ 900.000 / mes". */
export function monthlyLabel(cents: number): string {
  return `${formatCurrency(BigInt(cents))} / mes`;
}

/** "01/01 → 30/09: $ 450.000 / mes", "01/10 → vigente: $ 500.000 / mes". */
export function describeVersion(version: CostVersion, today: string): string {
  const last = version.to === null ? "vigente" : formatShortDate(shiftIsoDate(version.to, -1), today);
  return `${formatShortDate(version.from, today)} → ${last}: ${monthlyLabel(version.amountCents)}`;
}

/** Primer día del mes de `today` (fecha por defecto de un costo nuevo: cuenta desde el comienzo del mes en curso). */
export function firstDayOfMonth(today: string): string {
  return `${today.slice(0, 8)}01`;
}

/** Las versiones que se muestran en el historial (todas las reales; las correcciones vacías ya vienen filtradas del servidor). */
export function visibleHistory(cost: RecurringCost): CostVersion[] {
  return cost.history.filter((version) => version.to === null || version.to > version.from);
}

// ---------------------------------------------------------------------------------------------------------------------
// Formularios (validación de lo que se escribe; el servidor vuelve a validar todo)
// ---------------------------------------------------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MIN_DATE = "2020-01-01";

export function parseMonthlyForm(input: { name: string; amount: string; from: string }): Parsed<{ name: string; amountCents: number; from: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) return { ok: false, error: "Escribí el nombre del costo (hasta 80 caracteres)." };
  const amountCents = parseCostCents(input.amount);
  if (amountCents === null) return { ok: false, error: "Escribí el importe mensual, por ejemplo 450000 o 450000,50." };
  if (!isIsoDate(input.from) || input.from < MIN_DATE) return { ok: false, error: "Elegí desde qué fecha rige." };
  return { ok: true, value: { name, amountCents, from: input.from } };
}

export function parseExpenseForm(input: { date: string; concept: string; amount: string }, today: string): Parsed<{ date: string; concept: string; amountCents: number }> {
  const concept = input.concept.trim();
  if (concept.length < 1 || concept.length > 120) return { ok: false, error: "Escribí en qué se gastó (hasta 120 caracteres)." };
  const amountCents = parseCostCents(input.amount);
  if (amountCents === null) return { ok: false, error: "Escribí el importe, por ejemplo 70000 o 70000,50." };
  if (!isIsoDate(input.date) || input.date < MIN_DATE) return { ok: false, error: "Elegí la fecha del gasto." };
  if (input.date > today) return { ok: false, error: "La fecha del gasto no puede estar en el futuro." };
  return { ok: true, value: { date: input.date, concept, amountCents } };
}

export function parseEndForm(input: { date: string }): Parsed<string> {
  if (!isIsoDate(input.date) || input.date < MIN_DATE) return { ok: false, error: "Elegí desde qué fecha deja de aplicarse." };
  return { ok: true, value: input.date };
}
