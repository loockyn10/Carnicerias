"use client";

import { calculateListPriceFromMargin, formatBasisPointsPercent, formatCurrency } from "@carnicerias/business-logic";

import { parseCustomMarginPercent } from "../lib/product-margin";

const input = "w-28 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm disabled:bg-stone-100 disabled:text-stone-400";

export type MarginMode = "default" | "custom";

/**
 * Margen de ganancia del producto (D-070): «usar la configuración general» (margen global, o precio manual si la categoría está excluida)
 * o «usar margen personalizado». Controlado por el modal (necesita saber si el precio se deriva del costo). El servidor decide todo al
 * guardar (`set_product_custom_margin`); la «vista previa» sólo informa el precio que daría el costo vigente con ese margen.
 */
export function ProductMarginField({
  mode, percent, onModeChange, onPercentChange, globalMarginBps, excludedCategory, currentCustomMarginBps, currentCostCents, unitType
}: {
  mode: MarginMode;
  percent: string;
  onModeChange: (mode: MarginMode) => void;
  onPercentChange: (percent: string) => void;
  /** Margen global de la organización en basis points (null = sin configurar). */
  globalMarginBps: number | null;
  /** La categoría elegida está excluida del margen automático (D-069): sin margen propio el precio es manual. */
  excludedCategory: boolean;
  /** Margen propio guardado hoy (null = no tiene): viaja como referencia para que el servidor sólo escriba si cambió. */
  currentCustomMarginBps: number | null;
  currentCostCents: number | null;
  unitType: "WEIGHT" | "UNIT";
}) {
  let customBps: number | null = null;
  try { customBps = mode === "custom" ? parseCustomMarginPercent(percent) : null; } catch { customBps = null; }
  const preview = customBps !== null && currentCostCents !== null && currentCostCents > 0
    ? calculateListPriceFromMargin(BigInt(currentCostCents), BigInt(customBps)) : null;

  return <fieldset className="grid gap-2 rounded-lg bg-stone-50 p-3" data-testid="margin-field">
    <legend className="px-1 text-sm font-bold">Margen de ganancia</legend>
    <input name="current_custom_margin_bps" type="hidden" value={currentCustomMarginBps ?? ""} />
    <label className="flex items-start gap-2 text-sm">
      <input checked={mode === "default"} className="mt-1" name="margin_mode" onChange={() => onModeChange("default")} type="radio" value="default" />
      <span>
        <span className="font-medium" data-testid="margin-default-label">{excludedCategory ? "Precio manual" : "Usar configuración general"}</span>
        <span className="block text-xs text-stone-500" data-testid="margin-default-note">
          {excludedCategory
            ? "Esta categoría está excluida del margen automático: el precio de venta se escribe a mano."
            : globalMarginBps !== null ? `Margen actual: ${formatBasisPointsPercent(globalMarginBps)}%` : "Todavía no hay un margen general configurado (Productos → Precios)."}
        </span>
      </span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input checked={mode === "custom"} className="mt-2.5" name="margin_mode" onChange={() => onModeChange("custom")} type="radio" value="custom" />
      <span className="grid gap-1">
        <span className="font-medium">Usar margen personalizado</span>
        <span className="flex items-center gap-2">
          <input
            aria-label="Margen personalizado (%)" className={input} disabled={mode !== "custom"} inputMode="decimal" max="99.99" min="0.01"
            name="custom_margin" onChange={(event) => onPercentChange(event.target.value)} placeholder="30" required={mode === "custom"} step="0.01" type="number" value={percent}
          />
          <span className="text-sm">%</span>
        </span>
      </span>
    </label>
    {mode === "custom" ? <p className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-900" data-testid="margin-custom-note">
      El precio se forma con este margen (costo ÷ (1 − margen)), incluso en una categoría excluida. Al guardar se recalcula con el costo vigente; el precio anterior queda en el historial.
      {preview !== null ? <strong className="ml-1" data-testid="margin-custom-preview">{`Con el costo actual: ${formatCurrency(preview)} ${unitType === "WEIGHT" ? "/ kg" : "/ unidad"}.`}</strong> : null}
    </p> : currentCustomMarginBps !== null ? <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="margin-remove-note">
      {excludedCategory
        ? "Al guardar se quita el margen personalizado: vuelve a precio manual y el precio vigente NO se recalcula."
        : "Al guardar se quita el margen personalizado: el precio se recalcula con el margen general y el costo vigente."}
    </p> : null}
  </fieldset>;
}
