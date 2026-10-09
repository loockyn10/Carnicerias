import type { BulkEditRowRef } from "./bulk-costs";
import type { MarginRule } from "./product-margin";

/**
 * Fila de la planilla Productos → Precios tal como la devuelve `list_pricing_rows` (D-077). La búsqueda es global y paginada en el servidor:
 * el navegador nunca recibe el catálogo entero. Todo el dinero en centavos enteros.
 */
export type PricingMarginSource = "CUSTOM" | "GLOBAL" | "MANUAL" | "NO_MARGIN";

export interface PricingRow {
  productId: string;
  name: string;
  sku: string | null;
  categoryName: string;
  unitType: "WEIGHT" | "UNIT";
  /** Costo vigente (null = sin costo). */
  costCents: number | null;
  /** Precio de lista global vigente (null = sin precio; un $0 de importación también es «sin precio»). */
  priceCents: number | null;
  /** Regla que el SERVIDOR aplica a este producto (app_private.effective_margin). */
  marginSource: PricingMarginSource;
  marginBps: number | null;
  customMarginBps: number | null;
  excludedCategory: boolean;
}

/** Filas por página de la búsqueda (el RPC admite hasta 100). */
export const PRICING_PAGE_SIZE = 50;

export interface PricingRowsPage { total: number; rows: PricingRow[] }

const SOURCES: readonly PricingMarginSource[] = ["CUSTOM", "GLOBAL", "MANUAL", "NO_MARGIN"];

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Valida la respuesta del RPC (viene de la base, pero se tipa en un solo lugar y una forma inesperada falla fuerte). */
export function parsePricingRowsPage(data: unknown): PricingRowsPage {
  const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (typeof root.total !== "number" || !Array.isArray(root.rows)) throw new Error("Respuesta inesperada de la búsqueda de productos");
  const rows = root.rows.map((entry: unknown): PricingRow => {
    const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const source = SOURCES.find((candidate) => candidate === row.marginSource);
    if (typeof row.productId !== "string" || typeof row.name !== "string" || !source || (row.unitType !== "WEIGHT" && row.unitType !== "UNIT")) {
      throw new Error("Respuesta inesperada de la búsqueda de productos");
    }
    return {
      productId: row.productId, name: row.name, sku: typeof row.sku === "string" ? row.sku : null,
      categoryName: typeof row.categoryName === "string" ? row.categoryName : "Sin categoría", unitType: row.unitType,
      costCents: positiveOrNull(row.costCents), priceCents: positiveOrNull(row.priceCents),
      marginSource: source, marginBps: positiveOrNull(row.marginBps), customMarginBps: positiveOrNull(row.customMarginBps),
      excludedCategory: row.excludedCategory === true
    };
  });
  return { total: root.total, rows };
}

/** Regla de margen vigente de la fila, para mostrarla («Global 40%», «Propio 30%», «Precio manual»). */
export function ruleOfRow(row: PricingRow): MarginRule {
  switch (row.marginSource) {
    case "CUSTOM": return { kind: "CUSTOM", bps: row.marginBps };
    case "GLOBAL": return { kind: "GLOBAL", bps: row.marginBps };
    case "MANUAL": return { kind: "MANUAL", bps: null };
    case "NO_MARGIN": return { kind: "NONE", bps: null };
  }
}

/** Lo que la lógica de edición necesita saber de una fila (ver bulk-costs.ts). */
export function toEditRef(row: PricingRow, organizationMarginBps: number | null): BulkEditRowRef {
  const rule = ruleOfRow(row);
  return {
    id: row.productId, currentCostCents: row.costCents, customMarginBps: rule.kind === "CUSTOM" ? rule.bps : null,
    globalMarginBps: rule.kind === "GLOBAL" ? rule.bps : null, unitType: row.unitType, currentPriceCents: row.priceCents,
    excludedCategory: row.excludedCategory, organizationMarginBps
  };
}
