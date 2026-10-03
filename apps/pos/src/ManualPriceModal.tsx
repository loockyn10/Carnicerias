import { formatCurrency } from "@carnicerias/business-logic";
import { useState, type SyntheticEvent } from "react";

import { centsToPriceInput, validateManualPrice } from "./lib/manual-price";

interface ManualPriceModalProps {
  productName: string;
  /** "kg" para una línea por peso, "u" para una por unidad. */
  unitLabel: "kg" | "u";
  /** Lo que se lleva el cliente, para el resumen (`1,250 kg` / `3 u`). */
  quantityLabel: string;
  /** Precio normal del catálogo (nunca se modifica). */
  normalPriceCents: bigint;
  /** Precio manual vigente de la línea, o null si hoy usa el precio normal. */
  currentManualPriceCents: bigint | null;
  /** Importes de la línea con ese precio manual, o null si no se puede calcular (p. ej. la línea quedaría en $0). */
  preview: (priceCents: bigint) => { subtotalCents: bigint; adjustmentCents: bigint } | null;
  onApply: (priceCents: bigint) => void;
  /** "Usar precio normal": quita el precio manual y vuelve al motor de siempre. */
  onRestore: () => void;
  onCancel: () => void;
}

/**
 * Precio de ESTA línea de ESTA venta (POS de Central, D-061). No modifica el catálogo ni afecta ventas
 * futuras; es la decisión explícita del operador, así que la línea deja de recibir promociones y recargo.
 */
export function ManualPriceModal({ productName, unitLabel, quantityLabel, normalPriceCents, currentManualPriceCents, preview, onApply, onRestore, onCancel }: ManualPriceModalProps) {
  const [price, setPrice] = useState(currentManualPriceCents != null ? centsToPriceInput(currentManualPriceCents) : "");
  const [touched, setTouched] = useState(false);
  const validation = validateManualPrice(price);
  const computed = validation.ok ? preview(validation.priceCents) : null;
  const fieldError = touched && !validation.ok ? validation.error : validation.ok && computed === null ? "Con ese precio la línea queda en $0" : null;

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!validation.ok || computed === null) return;
    onApply(validation.priceCents);
  }

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-[55] grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-labelledby="manual-price-title">
      <form className="pos-modal-panel w-full max-w-lg rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl" onSubmit={submit} noValidate>
        <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Editar precio</p>
        <h2 id="manual-price-title" className="mt-1 text-3xl font-black" data-testid="manual-price-name">{productName}</h2>
        <p className="mt-2 text-lg text-stone-300" data-testid="manual-price-normal">Precio normal: <strong>{formatCurrency(normalPriceCents)}</strong> / {unitLabel}</p>

        <label className="mt-5 grid gap-2 text-sm font-bold text-stone-300">
          {unitLabel === "kg" ? "Precio por kg para esta venta" : "Precio por unidad para esta venta"}
          <span className="flex items-center gap-2">
            <span className="text-3xl font-black text-stone-400" aria-hidden="true">$</span>
            <input
              autoFocus
              className={`w-full rounded-2xl border bg-stone-950 px-4 py-3 text-3xl font-black outline-none focus:border-rose-500 ${fieldError ? "border-red-500" : "border-stone-600"}`}
              inputMode="decimal"
              placeholder="0"
              value={price}
              onChange={(event) => { setPrice(event.target.value); setTouched(true); }}
            />
          </span>
          {fieldError ? <span className="text-xs font-bold text-red-400" role="alert">{fieldError}</span> : null}
        </label>

        {computed ? (
          <div className="mt-4 rounded-2xl bg-stone-950 p-4 text-sm" data-testid="manual-price-preview">
            <p className="text-stone-400">{quantityLabel} → <strong className="text-lg text-rose-400">{formatCurrency(computed.subtotalCents)}</strong></p>
            {computed.adjustmentCents !== 0n ? (
              <p className={`mt-1 font-bold ${computed.adjustmentCents < 0n ? "text-emerald-400" : "text-amber-300"}`}>
                Ajuste manual: {computed.adjustmentCents < 0n ? "-" : "+"}{formatCurrency(computed.adjustmentCents < 0n ? -computed.adjustmentCents : computed.adjustmentCents)}
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="mt-4 text-xs text-stone-400">Sólo vale para esta venta: no cambia el precio del producto. Este precio no recibe promociones ni recargo por tarjeta.</p>

        <div className={`mt-6 grid gap-3 ${currentManualPriceCents != null ? "grid-cols-3" : "grid-cols-2"}`}>
          <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={onCancel}>Cancelar</button>
          {currentManualPriceCents != null ? (
            <button className="rounded-xl border border-amber-500/70 px-4 py-3 font-bold text-amber-200 hover:bg-amber-950/40" type="button" onClick={onRestore}>Usar precio normal</button>
          ) : null}
          <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500 disabled:opacity-50" type="submit" disabled={!validation.ok || computed === null}>Aplicar precio</button>
        </div>
      </form>
    </div>
  );
}
