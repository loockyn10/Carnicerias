"use client";

import { calculateGrossMarginCents, calculateProfitabilityOverCostBps, formatCurrency } from "@carnicerias/business-logic";
import { useMemo, useState } from "react";

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
 * Precio de venta = decisión manual del admin; costo = evidencia derivada (desposte automático o
 * carga directa para productos comprados terminados). Nunca se deriva un precio de costo+margen
 * acá: eso quedó descartado (ver docs/DECISIONS.md). Ganancia/rentabilidad son métricas
 * informativas calculadas con precio (input) − costo (vigente, de sólo lectura).
 */
export function ProductPricingFields({
  unitType, currentPriceCents, currentCostCents, required = false
}: { unitType: "WEIGHT" | "UNIT"; currentPriceCents: number | null; currentCostCents: number | null; required?: boolean }) {
  const [price, setPrice] = useState(centsInput(currentPriceCents));
  const [directCost, setDirectCost] = useState("");
  const suffix = unitType === "WEIGHT" ? "/ kg" : "/ unidad";

  const parsedPrice = useMemo(() => parseCents(price), [price]);
  const margin = useMemo(() => {
    if (parsedPrice === null || parsedPrice <= 0n || currentCostCents === null) return null;
    const costCents = BigInt(currentCostCents);
    const grossMarginCents = calculateGrossMarginCents(parsedPrice, costCents);
    return { grossMarginCents, profitabilityBps: calculateProfitabilityOverCostBps(grossMarginCents, costCents) };
  }, [parsedPrice, currentCostCents]);

  return <div className="grid gap-3 rounded-xl border border-stone-200 p-4">
    <label className="grid gap-1 text-sm font-medium">{unitType === "WEIGHT" ? "Precio de venta por kg" : "Precio de venta por unidad"}
      <input className={input} min="0.01" name="price" onChange={(event) => setPrice(event.target.value)} required={required} step="0.01" type="number" value={price} />
    </label>
    <dl className="grid gap-2 border-t pt-3 text-sm sm:grid-cols-3">
      <div><dt className="text-stone-500">Costo estimado vigente</dt><dd className="font-black">{currentCostCents !== null ? `${formatCurrency(BigInt(currentCostCents))} ${suffix}` : "No disponible"}</dd></div>
      <div><dt className="text-stone-500">Ganancia estimada</dt><dd className={`font-black ${margin && margin.grossMarginCents < 0 ? "text-red-700" : "text-emerald-700"}`}>{margin ? `${formatCurrency(margin.grossMarginCents)} ${suffix}` : "—"}</dd></div>
      <div><dt className="text-stone-500">Rentabilidad sobre costo</dt><dd className="font-black">{margin ? formatBps(margin.profitabilityBps) : "—"}</dd></div>
    </dl>
    <p className="text-xs text-stone-500">El costo se calcula solo (desposte) o se carga a mano si el producto se compra ya terminado; nunca determina el precio.</p>
    <label className="grid gap-1 text-sm font-medium">Costo directo (opcional, sólo si se compra ya terminado)
      <input className={input} min="0.01" name="direct_cost" onChange={(event) => setDirectCost(event.target.value)} step="0.01" type="number" value={directCost} />
    </label>
  </div>;
}
