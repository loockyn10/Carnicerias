"use client";

import { calculatePriceFormation, formatCurrency } from "@carnicerias/business-logic";
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
function parseBps(value: string) {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  return match ? BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0")) : null;
}

export function ProductPricingFields({ unitType, costCents, profitMarkupBps, cashDiscountBps, currentPriceCents, required = false }: { unitType: "WEIGHT" | "UNIT"; costCents: number | null; profitMarkupBps: number | null; cashDiscountBps: number; currentPriceCents: number | null; required?: boolean }) {
  const [cost, setCost] = useState(centsInput(costCents));
  const [profit, setProfit] = useState(profitMarkupBps == null ? "" : String(profitMarkupBps / 100));
  const preview = useMemo(() => {
    const parsedCost = parseCents(cost); const parsedProfit = parseBps(profit);
    if (parsedCost == null || parsedCost <= 0n || parsedProfit == null) return null;
    try { return calculatePriceFormation(parsedCost, parsedProfit, BigInt(cashDiscountBps)); } catch { return null; }
  }, [cashDiscountBps, cost, profit]);
  const suffix = unitType === "WEIGHT" ? "/ kg" : "/ unidad";
  return <div className="grid gap-3 rounded-xl border border-stone-200 p-4">
    <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-medium">{unitType === "WEIGHT" ? "Costo por kg" : "Costo por unidad"}<input className={input} min="0.01" name="cost" onChange={(event) => setCost(event.target.value)} required={required} step="0.01" type="number" value={cost} /></label><label className="grid gap-1 text-sm font-medium">Margen de ganancia sobre costo<input className={input} min="0" max="1000" name="profit_markup" onChange={(event) => setProfit(event.target.value)} required={required} step="0.01" type="number" value={profit} /></label></div>
    {preview ? <dl className="grid gap-2 border-t pt-3 text-sm sm:grid-cols-2"><div><dt className="text-stone-500">Precio de lista</dt><dd className="font-black">{formatCurrency(preview.listPriceCents)} {suffix}</dd></div><div><dt className="text-stone-500">Precio en efectivo (-{(cashDiscountBps / 100).toLocaleString("es-AR")}%)</dt><dd className="font-black text-emerald-700">{formatCurrency(preview.effectiveCashPriceCents)} {suffix}</dd></div></dl> : <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{currentPriceCents ? `Configuración de precio pendiente. Precio vigente: ${formatCurrency(BigInt(currentPriceCents))} ${suffix}.` : "SIN PRECIO · no disponible en POS. Completá costo y margen para generar el primer precio."}</div>}
  </div>;
}
