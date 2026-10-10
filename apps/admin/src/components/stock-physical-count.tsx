"use client";

import { formatStockQuantity, stockUnitLabel, type StockUnit } from "@carnicerias/business-logic";
import { useState, useTransition } from "react";

import { applyPhysicalCountAdjustmentAction } from "../app/admin/actions";
import { formatSignedQuantity, physicalCountDifference } from "../lib/stock-audit";

const field = "rounded-lg border border-stone-300 bg-white px-3 py-2";

/**
 * Conteo físico dentro de la auditoría. Escribir el valor sólo CALCULA la diferencia contra el stock del
 * sistema: no guarda nada. El ajuste se registra únicamente al confirmar (motivo obligatorio) y lo hace el
 * flujo de inventario físico que ya existe (`record_stock_operation` ADJUSTMENT → ADJUSTMENT_POSITIVE/NEGATIVE
 * en el ledger); acá no hay un segundo mecanismo de stock.
 */
export function StockPhysicalCount({ branchId, productId, unitType, systemQuantity, onApplied }: {
  branchId: string;
  productId: string;
  unitType: StockUnit;
  systemQuantity: number;
  /** Se llama después de registrar el ajuste (el Resumen de sucursal recarga sus números). */
  onApplied?: (() => void) | undefined;
}) {
  const [raw, setRaw] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const result = physicalCountDifference(raw, unitType, systemQuantity);
  const unit = stockUnitLabel(unitType);

  function confirm() {
    setError(null);
    startTransition(async () => {
      const outcome = await applyPhysicalCountAdjustmentAction({ branchId, productId, physicalRaw: raw, expectedSystemQuantity: systemQuantity, note });
      if (outcome.ok) {
        setDone(`Ajuste registrado: ${formatSignedQuantity(outcome.difference, unitType)}. El stock del sistema ahora coincide con el conteo.`);
        setRaw("");
        setNote("");
        setConfirming(false);
        onApplied?.();
      } else {
        setError(outcome.error);
      }
    });
  }

  return <section aria-labelledby="physical-count-title" className="mt-6 rounded-xl bg-white p-4 shadow-sm">
    <h2 className="text-lg font-black" id="physical-count-title">Conteo físico</h2>
    <p className="mt-1 text-sm text-stone-600">Escribí lo que hay en la góndola o cámara para ver la diferencia. <strong>No se modifica nada</strong> hasta que confirmes el ajuste.</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs font-bold text-stone-500">Stock físico ({unit})
        <input
          autoComplete="off"
          className={`${field} w-40 text-base font-normal text-stone-900`}
          inputMode={unitType === "WEIGHT" ? "decimal" : "numeric"}
          onChange={(event) => { setRaw(event.target.value); setConfirming(false); setError(null); setDone(null); }}
          placeholder={unitType === "WEIGHT" ? "0,000" : "0"}
          value={raw}
        />
      </label>
    </div>
    {result.state === "invalid" ? <p className="mt-2 text-sm text-red-700" role="alert">{result.message}</p> : null}
    {result.state === "ok" ? <dl className="mt-3 grid max-w-md gap-1 text-sm" data-testid="physical-count-result">
      <div className="flex justify-between"><dt className="text-stone-500">Stock sistema</dt><dd className="font-bold">{formatStockQuantity(result.systemQuantity, unitType)}</dd></div>
      <div className="flex justify-between"><dt className="text-stone-500">Stock físico</dt><dd className="font-bold">{formatStockQuantity(result.physicalQuantity, unitType)}</dd></div>
      <div className="flex justify-between border-t border-stone-200 pt-1"><dt className="font-bold">Diferencia</dt><dd className={`font-black ${result.matches ? "text-emerald-700" : result.difference < 0 ? "text-red-700" : "text-amber-700"}`}>{result.matches ? "Coincide" : formatSignedQuantity(result.difference, unitType)}</dd></div>
    </dl> : null}
    {result.state === "ok" && !result.matches && !confirming ? <button className="mt-3 rounded-lg border border-rose-800 px-4 py-2 text-sm font-bold text-rose-800 hover:bg-rose-50" onClick={() => setConfirming(true)} type="button">Registrar ajuste de {formatSignedQuantity(result.difference, unitType)}…</button> : null}
    {result.state === "ok" && !result.matches && confirming ? <div className="mt-3 grid max-w-md gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
      <p className="text-sm text-rose-900">Se registrará un ajuste de inventario físico en el ledger que deja el stock en <strong>{formatStockQuantity(result.physicalQuantity, unitType)}</strong> ({formatSignedQuantity(result.difference, unitType)}). Queda en el historial; no se borra nada.</p>
      <input aria-label="Motivo del ajuste" className={field} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Motivo / observación (obligatorio)" value={note} />
      <div className="flex gap-2">
        <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-60" disabled={pending || note.trim().length < 2} onClick={confirm} type="button">{pending ? "Registrando…" : "Confirmar ajuste"}</button>
        <button className="rounded-lg border px-4 py-2 text-sm font-bold" disabled={pending} onClick={() => setConfirming(false)} type="button">Cancelar</button>
      </div>
    </div> : null}
    {error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
    {done ? <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{done}</p> : null}
  </section>;
}
