"use client";

import { calculateGrossMarginCents, calculateProfitabilityOverCostBps, formatCurrency } from "@carnicerias/business-logic";
import { useMemo, useState } from "react";

import { parseCostCents } from "../lib/bulk-costs";
import { newProductPricingState } from "../lib/new-product-pricing";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";

function centsInput(cents: number | null) {
  if (cents == null) return "";
  const value = BigInt(cents); return `${String(value / 100n)}.${(value % 100n).toString().padStart(2, "0")}`;
}
function parseCents(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  return match ? BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0")) : null;
}
function formatBps(bps: bigint | null) {
  if (bps === null) return "—";
  return `${(Number(bps) / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/**
 * Costo + precio de lista (D-068). El precio de venta se DERIVA del costo con el margen global (Productos → Precios →
 * Configuración de precios): guardar un costo directo nuevo recalcula el precio en el servidor, en la misma operación. Con costo válido y
 * margen configurado el precio es SIEMPRE el derivado: el campo se muestra deshabilitado (no se envía). El precio manual sólo existe como
 * fallback cuando falta el costo o el margen. Ganancia/rentabilidad son métricas informativas (precio − costo vigente, sólo lectura).
 */
export function ProductPricingFields({
  unitType, currentPriceCents, currentCostCents, required = false, marginConfigured = false, creationMarginBps, excludedCategory = false, customMargin = false
}: {
  unitType: "WEIGHT" | "UNIT"; currentPriceCents: number | null; currentCostCents: number | null; required?: boolean; marginConfigured?: boolean;
  /** La categoría elegida está excluida del margen automático (D-069): el precio es manual aunque haya costo y margen. */
  excludedCategory?: boolean;
  /** El producto tiene (o se está eligiendo) un margen personalizado (D-070): gana sobre el margen global y sobre la exclusión de categoría. */
  customMargin?: boolean;
  /** Sólo en el ALTA: margen global en basis points (null = sin configurar). Con costo + margen el precio no hace falta escribirlo. */
  creationMarginBps?: number | null;
}) {
  const [price, setPrice] = useState(centsInput(currentPriceCents));
  const [directCost, setDirectCost] = useState("");
  const suffix = unitType === "WEIGHT" ? "/ kg" : "/ unidad";

  const parsedPrice = useMemo(() => parseCents(price), [price]);
  // Alta: el precio sólo es obligatorio cuando no puede formarse solo (sin costo válido o sin margen configurado). El servidor lo vuelve a decidir.
  const creation = creationMarginBps !== undefined ? newProductPricingState({ marginBps: creationMarginBps, costRaw: directCost, priceRaw: price, excludedCategory }) : null;
  // ¿El precio se deriva del costo? Alta: costo válido + margen. Producto existente: margen + costo vigente o un costo nuevo escrito.
  // Nunca en una categoría excluida del margen automático: ahí el precio es manual y un costo nuevo sólo se guarda.
  // Con margen propio (D-070) se deriva aunque la categoría esté excluida o no haya margen global.
  const derived = creation ? !creation.priceRequired : (customMargin || (marginConfigured && !excludedCategory)) && ((currentCostCents !== null && currentCostCents > 0) || parseCostCents(directCost) !== null);
  const margin = useMemo(() => {
    if (parsedPrice === null || parsedPrice <= 0n || currentCostCents === null) return null;
    const costCents = BigInt(currentCostCents);
    const grossMarginCents = calculateGrossMarginCents(parsedPrice, costCents);
    return { grossMarginCents, profitabilityBps: calculateProfitabilityOverCostBps(grossMarginCents, costCents) };
  }, [parsedPrice, currentCostCents]);

  return <div className="grid gap-3 rounded-xl border border-stone-200 p-4">
    <label className="grid gap-1 text-sm font-medium">{unitType === "WEIGHT" ? "Precio de venta por kg" : "Precio de venta por unidad"}
      <input className={input} min="0.01" name="price" onChange={(event) => setPrice(event.target.value)} disabled={derived} required={required && !derived} step="0.01" type="number" value={derived && creation?.derivedPriceCents != null ? centsInput(creation.derivedPriceCents) : price} />
    </label>
    {creation ? <p className={`rounded-lg p-2 text-xs ${creation.priceRequired ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"}`} data-testid="new-product-price-note">{creation.message}</p> : null}
    {!creation && excludedCategory && !customMargin ? <p className="rounded-lg bg-sky-50 p-2 text-xs text-sky-900" data-testid="price-manual-note">Categoría con precio manual (excluida del margen automático): el precio de venta se escribe a mano y un costo nuevo no lo recalcula. El costo se guarda igual, para la rentabilidad.</p> : null}
    {!creation && derived ? <p className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-900" data-testid="price-derived-note">Con el margen configurado el precio de venta se forma desde el costo (no se escribe a mano): al guardar un costo nuevo se recalcula.</p> : null}
    <dl className="grid gap-2 border-t pt-3 text-sm sm:grid-cols-3">
      <div><dt className="text-stone-500">Costo estimado vigente</dt><dd className="font-black">{currentCostCents !== null ? `${formatCurrency(BigInt(currentCostCents))} ${suffix}` : "No disponible"}</dd></div>
      <div><dt className="text-stone-500">Ganancia estimada</dt><dd className={`font-black ${margin && margin.grossMarginCents < 0 ? "text-red-700" : "text-emerald-700"}`}>{margin ? `${formatCurrency(margin.grossMarginCents)} ${suffix}` : "—"}</dd></div>
      <div><dt className="text-stone-500">Rentabilidad sobre costo</dt><dd className="font-black">{margin ? formatBps(margin.profitabilityBps) : "—"}</dd></div>
    </dl>
    <p className="text-xs text-stone-500" data-testid="cost-price-note">
      El costo se calcula solo (desposte) o se carga a mano si el producto se compra ya terminado.{" "}
      {customMargin
        ? "Este producto usa un margen personalizado: al guardar un costo nuevo, el precio de venta se recalcula con ese margen. El precio manual sólo se usa si el producto no tiene costo."
        : excludedCategory
        ? "Esta categoría tiene precio manual: guardar un costo nuevo no cambia el precio de venta."
        : marginConfigured
        ? "Al guardar un costo nuevo, el precio de venta se recalcula con el margen configurado. El precio manual sólo se usa si el producto no tiene costo."
        : "Todavía no hay un margen configurado (Productos → Precios): guardar un costo no modifica el precio de venta y el precio se escribe a mano."}
    </p>
    <label className="grid gap-1 text-sm font-medium">Costo directo (opcional, sólo si se compra ya terminado)
      <input className={input} min="0.01" name="direct_cost" onChange={(event) => setDirectCost(event.target.value)} step="0.01" type="number" value={directCost} />
    </label>
  </div>;
}
