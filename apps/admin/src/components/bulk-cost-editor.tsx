"use client";

import { calculateListPriceFromMargin, formatCurrency } from "@carnicerias/business-logic";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";

import { applyPricingReceiptAction, searchPricingRowsAction, type BulkCostState } from "../app/admin/actions";
import {
  centsToField, changedBulkItems, costAfterEdit, costPlaceholder, displayedMarginBps, hasBlockingErrors, marginChange,
  priceEditable, ruleAfterEdit, rowFieldErrors, type RowEdit
} from "../lib/bulk-costs";
import { toEditRef, type PricingRow, type PricingRowsPage } from "../lib/pricing-rows";
import { bpsToPercentField } from "../lib/product-margin";

const input = "w-28 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";
const marginInput = "w-20 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm";
const invalidClass = "border-red-500";

const COLUMNS = 7;

/**
 * Productos → Precios como pantalla de REMITO (D-077): Fran recibe la boleta del proveedor y desde esta única planilla busca CUALQUIER
 * producto del catálogo (UN solo buscador, en el servidor), carga el costo nuevo, ajusta el margen, anota la cantidad RECIBIDA y, donde el
 * precio es manual (p. ej. Cerdo), el precio. Un solo «Guardar cambios» manda todas las filas modificadas en UNA operación transaccional.
 *
 * Cantidad = lo recibido en esta entrega: SE SUMA al stock de la sucursal productiva; no es el stock total. Vacía = ningún movimiento.
 * Ninguna fórmula vive acá: el precio automático lo forma el servidor (sólo se proyecta para mostrar con la misma función de business-logic)
 * y el ingreso lo escribe el flujo canónico de stock. Los cambios escritos NO se pierden al cambiar la búsqueda: quedan en esta pantalla.
 */
export function BulkCostEditor({ initialPage, marginConfigured, marginBps = null, productionBranchName = null }: {
  initialPage: PricingRowsPage;
  marginConfigured: boolean;
  /** Margen global en basis points: sólo para volver a la regla por defecto y mostrar el precio que va a formar el servidor (no se envía). */
  marginBps?: number | null;
  /** Nombre de la sucursal productiva (destino del ingreso). null = no configurada: la cantidad queda deshabilitada. */
  productionBranchName?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PricingRow[]>(initialPage.rows);
  const [total, setTotal] = useState(initialPage.total);
  const [known, setKnown] = useState<Record<string, PricingRow>>(() => indexRows(initialPage.rows));
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [saved, setSaved] = useState<BulkCostState>({});
  const [pending, startTransition] = useTransition();
  const searchSequence = useRef(0);
  const firstRun = useRef(true);
  const submitting = useRef(false);
  // Un intento de guardado = una clave de idempotencia: el MISMO pedido reintentado (doble click, red caída) reusa la clave.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const patch = (id: string, change: RowEdit) => setEdits((current) => ({ ...current, [id]: { ...current[id], ...change } }));

  // Buscador ÚNICO: pega al servidor (todo el catálogo) con debounce. Una respuesta vieja nunca pisa a una más nueva.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const sequence = ++searchSequence.current;
    const handle = setTimeout(() => {
      setSearching(true);
      void searchPricingRowsAction(query, 0).then((result) => {
        if (sequence !== searchSequence.current) return;
        setSearching(false);
        if (result.page) {
          setSearchError(null);
          setResults(result.page.rows);
          setTotal(result.page.total);
          setKnown((current) => ({ ...current, ...indexRows(result.page.rows) }));
        } else {
          setSearchError(result.error);
        }
      }).catch(() => {
        if (sequence !== searchSequence.current) return;
        setSearching(false);
        setSearchError("No se pudo buscar: revisá la conexión");
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  const loadMore = () => {
    const sequence = ++searchSequence.current;
    setSearching(true);
    void searchPricingRowsAction(query, results.length).then((result) => {
      if (sequence !== searchSequence.current) return;
      setSearching(false);
      if (result.page) {
        setSearchError(null);
        setResults((current) => [...current, ...result.page.rows.filter((row) => !current.some((existing) => existing.productId === row.productId))]);
        setTotal(result.page.total);
        setKnown((current) => ({ ...current, ...indexRows(result.page.rows) }));
      } else {
        setSearchError(result.error);
      }
    }).catch(() => {
      if (sequence !== searchSequence.current) return;
      setSearching(false);
      setSearchError("No se pudo buscar: revisá la conexión");
    });
  };

  // Todo lo escrito vive en `edits` (por id de producto), así que cambiar la búsqueda nunca descarta cambios. Las filas con cambios o con un
  // campo inválido que ya no están en la búsqueda actual se muestran aparte, debajo, para que se vean y se puedan corregir.
  const editedRefs = useMemo(
    () => Object.keys(edits).flatMap((id) => { const row = known[id]; return row ? [toEditRef(row, marginBps)] : []; }),
    [edits, known, marginBps]
  );
  const changedItems = useMemo(() => changedBulkItems(editedRefs, edits), [editedRefs, edits]);
  const blocked = useMemo(() => hasBlockingErrors(editedRefs, edits), [editedRefs, edits]);
  const dirtyIds = useMemo(() => new Set(changedItems.map((item) => item.productId)), [changedItems]);
  const resultIds = useMemo(() => new Set(results.map((row) => row.productId)), [results]);
  const pinnedRows = useMemo(
    () => editedRefs.filter((ref) => !resultIds.has(ref.id) && (dirtyIds.has(ref.id) || Object.keys(rowFieldErrors(ref, edits[ref.id])).length > 0))
      .flatMap((ref) => { const row = known[ref.id]; return row ? [row] : []; }),
    [editedRefs, resultIds, dirtyIds, edits, known]
  );

  const save = () => {
    if (submitting.current || pending || blocked || changedItems.length === 0) return;
    submitting.current = true;
    const submitted = changedItems;
    const signature = JSON.stringify(submitted);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    const requestKey = attempt.current.key;
    const snapshot = new Map(submitted.map((item) => [item.productId, JSON.stringify(edits[item.productId])]));
    startTransition(async () => {
      try {
        const result = await applyPricingReceiptAction({ requestKey, items: submitted });
        setSaved(result);
        if (!result.error) {
          attempt.current = null;
          const fresh = indexRows(result.rows ?? []);
          setKnown((current) => ({ ...current, ...fresh }));
          setResults((current) => current.map((row) => fresh[row.productId] ?? row));
          // Después de guardar, Cantidad (y todo lo guardado) vuelve a vacío: no se puede volver a sumar la misma entrega por error.
          setEdits((current) => Object.fromEntries(Object.entries(current).filter(([id, edit]) => !(snapshot.has(id) && JSON.stringify(edit) === snapshot.get(id)))));
        }
      } catch {
        // Sin respuesta (red caída): el intento conserva su clave; reintentar el MISMO pedido no duplica el ingreso.
        setSaved({ error: "No se pudo confirmar el guardado. Revisá la conexión y volvé a tocar «Guardar cambios»: no se suma dos veces." });
      } finally {
        submitting.current = false;
      }
    });
  };

  const renderRow = (row: PricingRow): ReactNode => {
    const ref = toEditRef(row, marginBps);
    const edit = edits[row.productId];
    const errors = rowFieldErrors(ref, edit);
    const suffix = row.unitType === "WEIGHT" ? "/kg" : "/u";
    const dirty = dirtyIds.has(row.productId);
    const change = marginChange(ref, edit);
    const reset = change === null;
    // El input MUESTRA lo escrito; si no, el margen propio o el global efectivo (vacío en precio manual). No es un override hasta que cambia.
    const marginValue = reset ? "" : edit?.margin ?? bpsToPercentField(displayedMarginBps(ref));
    const finalRule = ruleAfterEdit(ref, edit);
    const source = finalRule.kind === "CUSTOM" ? "Propio" : finalRule.kind === "GLOBAL" ? "Global" : finalRule.kind === "MANUAL" ? "Precio manual" : "Sin margen";
    const defaultLabel = row.excludedCategory ? "Usar precio manual" : "Usar global";
    const editablePrice = priceEditable(ref, edit);
    const projectedCost = costAfterEdit(ref, edit);
    const showProjection = dirty && !editablePrice && finalRule.bps !== null && projectedCost !== null && projectedCost > 0;
    const quantityUnit = row.unitType === "WEIGHT" ? "kg" : "u";
    const priceValue = edit?.price ?? (row.priceCents !== null ? centsToField(row.priceCents) : "");
    return <tr className={`border-t ${dirty ? "bg-amber-50" : ""}`} data-product-id={row.productId} key={row.productId}>
      <td className="p-3 font-bold">{row.name}</td>
      <td className="p-3 text-stone-600">{row.categoryName}</td>
      <td className="p-3 text-stone-600">{row.unitType === "WEIGHT" ? "Por kg" : "Unidad"}</td>
      <td className="p-3">
        <input
          aria-invalid={errors.cost !== undefined}
          aria-label={`Costo de ${row.name}`}
          className={`${input} ${errors.cost ? invalidClass : ""}`}
          inputMode="decimal"
          onChange={(event) => patch(row.productId, { cost: event.target.value })}
          placeholder={costPlaceholder(row.costCents)}
          type="text"
          value={edit?.cost ?? ""}
        />
        {errors.cost ? <span className="block text-xs font-bold text-red-800">{errors.cost}</span> : null}
      </td>
      <td className="p-3">
        <span className="flex items-center gap-1">
          <input
            aria-invalid={errors.margin !== undefined}
            aria-label={`Margen de ${row.name} (%)`}
            className={`${marginInput} ${errors.margin ? invalidClass : ""}`}
            inputMode="decimal"
            onChange={(event) => patch(row.productId, { margin: event.target.value, reset: false })}
            type="text"
            value={marginValue}
          />
          <span>%</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span
            className={`rounded px-1.5 py-0.5 font-bold ${source === "Propio" ? "bg-violet-100 text-violet-900" : source === "Precio manual" ? "bg-sky-100 text-sky-900" : "bg-stone-100 text-stone-700"}`}
            data-testid="margin-source"
            title={source === "Precio manual" ? "Categoría excluida del margen automático: el precio se carga a mano" : source === "Propio" ? "Margen personalizado de este producto" : "Margen general de la organización"}
          >{source}</span>
          {ref.customMarginBps !== null && !reset
            ? <button className="font-bold text-rose-800 underline" data-testid="margin-reset" onClick={() => patch(row.productId, { reset: true })} type="button">{defaultLabel}</button>
            : null}
          {reset ? <button className="font-bold text-stone-600 underline" data-testid="margin-reset-undo" onClick={() => patch(row.productId, { reset: false })} type="button">Deshacer</button> : null}
        </span>
        {errors.margin ? <span className="block text-xs font-bold text-red-800" data-testid="margin-invalid">{errors.margin}</span> : null}
      </td>
      <td className="p-3">
        <span className="flex items-center gap-1">
          <input
            aria-invalid={errors.quantity !== undefined}
            aria-label={`Cantidad recibida de ${row.name}`}
            className={`${marginInput} ${errors.quantity ? invalidClass : ""}`}
            disabled={productionBranchName === null}
            inputMode="decimal"
            onChange={(event) => patch(row.productId, { quantity: event.target.value })}
            placeholder="—"
            title={productionBranchName === null ? "Configurá la sucursal productiva (Desposte) para registrar el ingreso" : `Se suma al stock de ${productionBranchName}`}
            type="text"
            value={edit?.quantity ?? ""}
          />
          <span className="text-stone-500">{quantityUnit}</span>
        </span>
        {errors.quantity ? <span className="block max-w-[11rem] text-xs font-bold text-red-800" data-testid="quantity-invalid">{errors.quantity}</span> : null}
      </td>
      <td className="p-3">
        {editablePrice
          ? <>
            <span className="flex items-center gap-1">
              <span className="text-stone-500">$</span>
              <input
                aria-invalid={errors.price !== undefined}
                aria-label={`Precio de ${row.name}`}
                className={`${input} ${errors.price ? invalidClass : ""}`}
                inputMode="decimal"
                onChange={(event) => patch(row.productId, { price: event.target.value })}
                placeholder="Sin precio"
                type="text"
                value={priceValue}
              />
              <span className="text-stone-500">{suffix}</span>
            </span>
            {errors.price ? <span className="block text-xs font-bold text-red-800">{errors.price}</span> : null}
            {finalRule.kind === "GLOBAL" || finalRule.kind === "CUSTOM" ? <span className="block text-xs text-stone-500">Sin costo: precio manual</span> : null}
          </>
          : <>
            {row.priceCents !== null ? `${formatCurrency(BigInt(row.priceCents))} ${suffix}` : "SIN PRECIO"}
            {showProjection
              ? <span className="ml-2 font-bold text-emerald-800" data-testid="projected-price">{`→ ${formatCurrency(calculateListPriceFromMargin(BigInt(projectedCost), BigInt(finalRule.bps ?? 0)))}`}</span>
              : null}
          </>}
      </td>
    </tr>;
  };

  const emptyMessage = query.trim() ? "Ningún producto coincide con la búsqueda." : "No hay productos de venta para cargar costos.";

  return <div className="mt-4">
    {!marginConfigured ? <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">
      Todavía no configuraste el margen de ganancia: los costos se guardan, pero el precio de venta no se recalcula hasta que lo hagas (arriba, en «Configuración de precios») o le pongas un margen propio al producto.
    </p> : null}
    {productionBranchName === null ? <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" role="status">
      Para registrar la cantidad recibida hay que configurar la sucursal productiva (Desposte). Mientras tanto la cantidad está deshabilitada.
    </p> : null}
    <label className="mb-3 grid max-w-sm gap-1 text-sm font-medium">
      Buscar
      <input
        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Producto o categoría…"
        type="search"
        value={query}
      />
    </label>
    {searchError ? <p className="mb-3 text-sm font-bold text-red-800" role="alert">{searchError}</p> : null}
    <div className="overflow-hidden rounded-xl border">
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="sticky top-0 bg-stone-50 text-stone-500"><tr>
            <th className="p-3">Producto</th><th className="p-3">Categoría</th><th className="p-3">Tipo de venta</th>
            <th className="p-3">Costo</th><th className="p-3">Margen</th>
            <th className="p-3" title="Cantidad recibida en esta entrega: se suma al stock, no lo reemplaza">Cantidad</th>
            <th className="p-3">Precio actual</th>
          </tr></thead>
          <tbody>
            {results.map(renderRow)}
            {pinnedRows.length ? <tr className="border-t bg-stone-100"><td className="p-2 text-xs font-bold text-stone-700" colSpan={COLUMNS}>Con cambios sin guardar (fuera de esta búsqueda)</td></tr> : null}
            {pinnedRows.map(renderRow)}
          </tbody>
        </table>
      </div>
      {!results.length && !searching ? <p className="p-8 text-center text-stone-500">{emptyMessage}</p> : null}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-stone-500">
      <span>{searching ? "Buscando…" : `Mostrando ${String(results.length)} de ${String(total)}`}</span>
      {results.length < total
        ? <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-bold text-stone-700 disabled:opacity-50" disabled={searching} onClick={loadMore} type="button">Mostrar más</button>
        : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-stone-500">
        {changedItems.length > 0 ? `${String(changedItems.length)} producto(s) modificado(s)` : "Sin cambios"}
        {blocked ? <span className="ml-2 font-bold text-red-800">Revisá los campos marcados en rojo para poder guardar.</span> : null}
      </p>
      {saved.error ? <p className="text-sm font-bold text-red-800" role="alert">{saved.error}</p> : null}
      {saved.successToken ? <p className="text-sm font-bold text-emerald-700" role="status">{describeSaved(saved)}</p> : null}
      <button className="rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={pending || blocked || changedItems.length === 0} onClick={save} type="button">
        {pending ? "Guardando…" : "Guardar cambios"}
      </button>
    </div>
  </div>;
}

function indexRows(rows: PricingRow[]): Record<string, PricingRow> {
  return Object.fromEntries(rows.map((row) => [row.productId, row]));
}

/** Resumen de lo que hizo el servidor, en palabras de Fran (sólo muestra lo que efectivamente pasó). */
export function describeSaved(state: BulkCostState): string {
  if (state.replayed) return "Esta carga ya estaba registrada: no se volvió a sumar el stock ni se repitió ningún cambio.";
  const parts = [`${String(state.applied ?? 0)} producto(s)`];
  if (state.costsSaved) parts.push(`${String(state.costsSaved)} costo(s)`);
  if (state.marginsChanged) parts.push(`${String(state.marginsChanged)} margen(es)`);
  if (state.repriced) parts.push(`${String(state.repriced)} precio(s) recalculado(s)`);
  if (state.manualPrices) parts.push(`${String(state.manualPrices)} precio(s) manual(es)`);
  if (state.stockMovements) parts.push(`${String(state.stockMovements)} ingreso(s) de stock`);
  const extra = [
    state.scheduledPrice ? `${String(state.scheduledPrice)} con precio programado (no se tocó)` : "",
    state.branchOverrides ? `ATENCIÓN: ${String(state.branchOverrides)} producto(s) tienen un precio propio de sucursal que le gana al precio global en el POS (cerralos desde «Configuración de precios»).` : ""
  ].filter(Boolean);
  return `Guardado: ${parts.join(", ")}.${extra.length ? ` ${extra.join(" ")}` : ""}`;
}
