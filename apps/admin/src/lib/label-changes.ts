import { formatCurrency } from "@carnicerias/business-logic";

import type { LabelValues } from "./product-label";

/**
 * Detección de etiquetas físicas desactualizadas (D-073): compara lo que se imprimió la ÚLTIMA vez para un producto dentro de su grupo
 * (snapshot de `product_label_print_run_items`) con lo que se imprimiría HOY (precio vigente de la sucursal + promoción, resueltos por la
 * base y el motor de pricing). El snapshot es sólo historial: jamás reemplaza al precio vigente.
 */

/** NEW = nunca se imprimió (falta la etiqueta física) · UPDATED = lo impreso coincide con lo vigente · CHANGED = hay que reimprimir. */
export type LabelFreshness = "NEW" | "UPDATED" | "CHANGED";
export type LabelChangeReason = "PRICE" | "PROMO" | "NAME";

export interface LabelFreshnessResult {
  status: LabelFreshness;
  reasons: LabelChangeReason[];
}

/** Compara en valores exactos (centavos, unidades mínimas, basis points y nombre impreso): nunca en texto formateado. */
export function compareWithLastPrint(current: LabelValues, last: LabelValues | null): LabelFreshnessResult {
  if (!last) return { status: "NEW", reasons: [] };
  const reasons: LabelChangeReason[] = [];
  const listChanged = current.listPriceCents !== last.listPriceCents;
  // La regla de la promoción (mínimo, porcentaje o su presencia) vs. su precio derivado: si sólo cambió el precio de lista, el precio de
  // oferta se mueve con él y se informa UNA razón («Precio cambió»), no dos.
  const ruleChanged = current.promoMinimumUnits !== last.promoMinimumUnits || current.promoDiscountBps !== last.promoDiscountBps;
  const promoPriceChanged = current.promoPriceCents !== last.promoPriceCents;
  if (listChanged) reasons.push("PRICE");
  if (ruleChanged || (promoPriceChanged && !listChanged)) reasons.push("PROMO");
  if (current.displayedName !== last.displayedName) reasons.push("NAME");
  return { status: reasons.length ? "CHANGED" : "UPDATED", reasons };
}

/** ¿Falta o quedó vieja la etiqueta física? (lo que selecciona «Seleccionar precios cambiados»). */
export function needsPrinting(status: LabelFreshness | null): boolean {
  return status === "NEW" || status === "CHANGED";
}

const REASON_TEXT: Record<LabelChangeReason, string> = { PRICE: "Precio cambió", PROMO: "Promo cambió", NAME: "Nombre cambió" };

/** Texto corto del estado para la lista del grupo: «Actualizada», «Precio cambió», «Nunca impresa»… */
export function freshnessText(result: LabelFreshnessResult): string {
  if (result.status === "NEW") return "Nunca impresa";
  if (result.status === "UPDATED") return "Actualizada";
  return result.reasons.length ? result.reasons.map((reason) => REASON_TEXT[reason]).join(" · ") : "Cambió";
}

/** «$ 2.050» · «$ 1.742,50 (llevando 3) · normal $ 2.050» · «$ 11.000/kg»: lo impreso (o por imprimir) en una línea. */
export function describeValues(values: LabelValues, unitType: "UNIT" | "WEIGHT"): string {
  const list = formatCurrency(BigInt(values.listPriceCents));
  if (values.promoPriceCents !== null) {
    const units = values.promoMinimumUnits === null ? "" : ` (${String(values.promoMinimumUnits)}+ u)`;
    return `${formatCurrency(BigInt(values.promoPriceCents))}${units} · normal ${list}`;
  }
  return unitType === "WEIGHT" ? `${list}/kg` : list;
}
