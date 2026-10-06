import { calculateListPriceFromMargin, formatBasisPointsPercent, formatCurrency } from "@carnicerias/business-logic";

import { parseCostCents } from "./bulk-costs";

/**
 * Alta de un producto en el Admin (D-068): con un costo válido y un margen global configurado el precio de lista se DERIVA siempre
 * (`costo ÷ (1 − margen)`, la misma función de `set_product_cost`) y un precio escrito a mano NO gana (se ignora). El precio manual sólo
 * es el fallback cuando falta el costo o el margen (o el producto es inactivo) y entonces se exige y se dice por qué.
 * (El ejemplo de la pantalla usa la gemela TypeScript de la fórmula; lo que se guarda lo calcula siempre el servidor.)
 */

export interface NewProductPricingState {
  /** ¿Hay que escribir el precio a mano? */
  priceRequired: boolean;
  /** Precio que formaría el servidor desde el costo y el margen (null si no puede formarse). */
  derivedPriceCents: number | null;
  /** Texto para el formulario: por qué hace falta el precio, o cuál se calcula. */
  message: string;
}

export function newProductPricingState(input: { marginBps: number | null; costRaw: string; priceRaw: string; active?: boolean }): NewProductPricingState {
  const cost = parseCostCents(input.costRaw);
  const hasManualPrice = input.priceRaw.trim() !== "";
  const active = input.active ?? true;
  if (input.marginBps !== null && cost !== null && active) {
    const derived = Number(calculateListPriceFromMargin(BigInt(cost), BigInt(input.marginBps)));
    return {
      priceRequired: false,
      derivedPriceCents: derived,
      message: `Precio calculado con el margen de ${formatBasisPointsPercent(input.marginBps)}%: ${formatCurrency(BigInt(derived))}. Con costo y margen el precio no se escribe a mano${hasManualPrice ? " (el que escribiste se ignora)" : ""}.`
    };
  }
  let reason: string;
  if (input.marginBps === null && cost === null) reason = "Hace falta el precio de venta: no hay costo cargado ni un margen configurado para calcularlo.";
  else if (input.marginBps === null) reason = "Hace falta el precio de venta: todavía no hay un margen configurado (Productos → Precios → Configuración de precios), así que no se puede calcular desde el costo.";
  else if (cost === null) reason = "Hace falta el precio de venta, o cargá un costo y el precio se calcula solo con el margen.";
  else reason = "Hace falta el precio de venta: un producto inactivo no forma el precio desde el costo.";
  return { priceRequired: true, derivedPriceCents: null, message: reason };
}

export type NewProductPricingSource = "NONE" | "MANUAL" | "DERIVED";

/**
 * Qué hay que hacer al crear el producto: `NONE` (materia prima pura, sin precio de venta), `DERIVED` (hay costo + margen: el costo se guarda y
 * el servidor forma el precio; un precio escrito se ignora) o `MANUAL` (fallback: sin costo o sin margen, con el precio escrito). Si no puede formarse un
 * precio lanza un Error con el motivo (antes de crear nada).
 */
export function resolveNewProductPricing(input: { sellable: boolean; active: boolean; marginBps: number | null; costRaw: string; priceRaw: string }): NewProductPricingSource {
  if (!input.sellable) return "NONE";
  const state = newProductPricingState(input);
  if (!state.priceRequired) return "DERIVED";
  if (input.priceRaw.trim() !== "") return "MANUAL";
  throw new Error(state.message);
}
