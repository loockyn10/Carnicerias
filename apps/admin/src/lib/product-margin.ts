import { formatBasisPointsPercent } from "@carnicerias/business-logic";

import { percentageToBasisPointsAllowZero, text } from "./form-parsing";

/**
 * Margen de ganancia PERSONALIZADO por producto (D-070). Puro y con tests; el servidor (`set_product_custom_margin`, y el helper SQL
 * `app_private.effective_margin` en cada costo nuevo) vuelve a decidir todo. Prioridad: 1) margen propio; 2) categoría excluida → precio
 * manual; 3) margen global. Esta función SÓLO sirve para mostrar qué regla va a aplicar el servidor (nunca forma un precio por su cuenta).
 */

export type MarginRuleKind = "CUSTOM" | "GLOBAL" | "MANUAL" | "NONE";

export interface MarginRule {
  kind: MarginRuleKind;
  /** Basis points que forman el precio (null en MANUAL y NONE). */
  bps: number | null;
}

export function effectiveMarginRule({ customMarginBps, globalMarginBps, excludedCategory }: {
  customMarginBps: number | null; globalMarginBps: number | null; excludedCategory: boolean;
}): MarginRule {
  if (customMarginBps !== null) return { kind: "CUSTOM", bps: customMarginBps };
  if (globalMarginBps === null) return { kind: "NONE", bps: null };
  if (excludedCategory) return { kind: "MANUAL", bps: null };
  return { kind: "GLOBAL", bps: globalMarginBps };
}

/** «Global 40%», «Propio 30%», «Precio manual» o «Sin margen» (carga masiva de costos). */
export function describeMarginRule(rule: MarginRule): string {
  switch (rule.kind) {
    case "CUSTOM": return `Propio ${formatBasisPointsPercent(rule.bps ?? 0)}%`;
    case "GLOBAL": return `Global ${formatBasisPointsPercent(rule.bps ?? 0)}%`;
    case "MANUAL": return "Precio manual";
    case "NONE": return "Sin margen";
  }
}

const MAX_BPS = 9_999n;

/** «30», «32,5», «32.50» → basis points enteros (nunca floats). Debe ser mayor a 0 y menor a 100 (los mismos límites que el margen global). */
export function parseCustomMarginPercent(raw: string): number {
  if (raw.trim() === "") throw new Error("Completá el margen personalizado.");
  let bps: number;
  try {
    bps = percentageToBasisPointsAllowZero(raw, "El margen personalizado", MAX_BPS);
  } catch {
    throw new Error("El margen personalizado tiene que ser un porcentaje entre 0,01 y 99,99 (hasta 2 decimales).");
  }
  if (bps < 1) throw new Error("El margen personalizado tiene que ser mayor a 0 y menor a 100.");
  return bps;
}

/** Basis points → valor del input de porcentaje («30», «32.5»). */
export function bpsToPercentField(bps: number | null): string {
  return bps === null ? "" : String(bps / 100);
}

/**
 * Selección del editor del producto: `margin_mode` = "custom" con `custom_margin` → ese margen; cualquier otra cosa ("default" o ausente) →
 * null = sin margen propio (usa la configuración general / precio manual). `null` también si el formulario no trae el selector.
 */
export function parseCustomMarginForm(formData: FormData): number | null {
  if (text(formData, "margin_mode") !== "custom") return null;
  return parseCustomMarginPercent(text(formData, "custom_margin"));
}

/** Margen propio vigente que el formulario recibió como referencia (hidden): vacío = no tenía. */
export function parseCurrentCustomMargin(raw: string): number | null {
  const value = Number(raw);
  return raw.trim() !== "" && Number.isSafeInteger(value) && value >= 1 && value <= 9_999 ? value : null;
}
