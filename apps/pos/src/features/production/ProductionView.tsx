import { useCallback, useEffect, useState, type SyntheticEvent } from "react";

import { formatCurrency, formatWeight, parseWeightToGrams } from "@carnicerias/business-logic";

import { supabase } from "../../lib/supabase";

interface ProductionCatalogProduct {
  productId: string;
  productName: string;
  productSku: string | null;
  salePricePerKgCents: bigint | null;
}

interface BatchListRow {
  id: string;
  branchName: string;
  sourceProductId: string;
  sourceProductName: string;
  status: "DRAFT" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  completedAt: string | null;
  inputWeightGrams: number;
  producedWeightGrams: number;
  wasteGrams: number;
  yieldBps: number | null;
  costTotalCents: bigint;
  totalSaleValueCents: bigint | null;
}

interface BatchOutputRow {
  id: string;
  productId: string;
  productName: string;
  outputWeightGrams: number;
  salePricePerKgCents: bigint | null;
  saleValueCents: bigint | null;
  allocatedCostCents: bigint | null;
  allocatedCostPerKgCents: bigint | null;
  isSnapshot: boolean;
}

interface BatchSummary {
  producedWeightGrams: number;
  wasteGrams: number;
  yieldBps: number | null;
  wastePercentageBps: number | null;
  averageCostPerKgCents: bigint | null;
  totalSaleValueCents: bigint | null;
  grossMarginCents: bigint | null;
  marginOverSalesBps: number | null;
  profitabilityOverCostBps: number | null;
  canFinalize: boolean;
  missingPriceProductName: string | null;
}

interface BatchDetail {
  batch: {
    id: string;
    branchId: string;
    branchName: string;
    sourceProductId: string;
    sourceProductName: string;
    description: string | null;
    inputWeightGrams: number;
    costPerKgCents: bigint;
    costTotalCents: bigint;
    status: "DRAFT" | "COMPLETED" | "CANCELLED";
    notes: string | null;
    createdAt: string;
    createdByName: string;
    completedAt: string | null;
    completedByName: string | null;
    cancelledAt: string | null;
    cancelledByName: string | null;
  };
  outputs: BatchOutputRow[];
  summary: BatchSummary;
}

interface YieldSummary {
  sampleSize: number;
  averageYieldBps: number | null;
  averageWastePercentageBps: number | null;
}

function toBigIntOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as number | string);
}

function formatBps(bps: number | bigint | null): string {
  if (bps === null) return "—";
  return `${(Number(bps) / 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("es-AR") : "—";
}

const STATUS_LABELS: Record<BatchListRow["status"], string> = {
  DRAFT: "Borrador",
  COMPLETED: "Finalizado",
  CANCELLED: "Cancelado"
};

export function ProductionView({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [catalog, setCatalog] = useState<ProductionCatalogProduct[]>([]);
  const [batches, setBatches] = useState<BatchListRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<"ALL" | BatchListRow["status"]>("ALL");
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [yieldSummary, setYieldSummary] = useState<YieldSummary | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [headerSourceProductId, setHeaderSourceProductId] = useState("");
  const [headerWeightInput, setHeaderWeightInput] = useState("");
  const [headerCostInput, setHeaderCostInput] = useState("");
  const [headerDescription, setHeaderDescription] = useState("");
  const [headerNotes, setHeaderNotes] = useState("");

  const [outputProductId, setOutputProductId] = useState("");
  const [outputWeightInput, setOutputWeightInput] = useState("");

  const loadCatalog = useCallback(async () => {
    const { data, error: catalogError } = await supabase.rpc("get_production_catalog", { p_branch_id: branchId });
    if (catalogError) throw catalogError;
    setCatalog(
      data.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        productSku: row.product_sku,
        salePricePerKgCents: toBigIntOrNull(row.sale_price_per_kg_cents)
      }))
    );
  }, [branchId]);

  const loadBatches = useCallback(async () => {
    const { data, error: listError } = await supabase.rpc("list_production_batches", {
      p_branch_id: branchId,
      p_status: statusFilter === "ALL" ? null : statusFilter
    });
    if (listError) throw listError;
    const rows = data as unknown as {
      id: string; branchName: string; sourceProductId: string; sourceProductName: string;
      status: BatchListRow["status"]; createdAt: string; completedAt: string | null;
      inputWeightGrams: number; producedWeightGrams: number; wasteGrams: number; yieldBps: number | null;
      costTotalCents: number; totalSaleValueCents: number | null;
    }[];
    setBatches(
      rows.map((row) => ({
        ...row,
        costTotalCents: BigInt(row.costTotalCents),
        totalSaleValueCents: toBigIntOrNull(row.totalSaleValueCents)
      }))
    );
  }, [branchId, statusFilter]);

  const loadDetail = useCallback(async (batchId: string) => {
    const { data, error: detailError } = await supabase.rpc("get_production_batch_detail", { p_batch_id: batchId });
    if (detailError) throw detailError;
    const raw = data as unknown as {
      batch: BatchDetail["batch"] & { costPerKgCents: number; costTotalCents: number };
      outputs: (Omit<BatchOutputRow, "salePricePerKgCents" | "saleValueCents" | "allocatedCostCents" | "allocatedCostPerKgCents"> & {
        salePricePerKgCents: number | null; saleValueCents: number | null; allocatedCostCents: number | null; allocatedCostPerKgCents: number | null;
      })[];
      summary: Omit<BatchSummary, "averageCostPerKgCents" | "totalSaleValueCents" | "grossMarginCents"> & {
        averageCostPerKgCents: number | null; totalSaleValueCents: number | null; grossMarginCents: number | null;
      };
    };
    setDetail({
      batch: { ...raw.batch, costPerKgCents: BigInt(raw.batch.costPerKgCents), costTotalCents: BigInt(raw.batch.costTotalCents) },
      outputs: raw.outputs.map((output) => ({
        ...output,
        salePricePerKgCents: toBigIntOrNull(output.salePricePerKgCents),
        saleValueCents: toBigIntOrNull(output.saleValueCents),
        allocatedCostCents: toBigIntOrNull(output.allocatedCostCents),
        allocatedCostPerKgCents: toBigIntOrNull(output.allocatedCostPerKgCents)
      })),
      summary: {
        ...raw.summary,
        averageCostPerKgCents: toBigIntOrNull(raw.summary.averageCostPerKgCents),
        totalSaleValueCents: toBigIntOrNull(raw.summary.totalSaleValueCents),
        grossMarginCents: toBigIntOrNull(raw.summary.grossMarginCents)
      }
    });

    const { data: summaryData, error: summaryError } = await supabase.rpc("get_production_yield_summary", {
      p_source_product_id: raw.batch.sourceProductId,
      p_limit: 10
    });
    if (!summaryError) setYieldSummary(summaryData as unknown as YieldSummary);
  }, []);

  useEffect(() => {
    void loadCatalog().catch((catalogError: unknown) => setError(catalogError instanceof Error ? catalogError.message : "No se pudo cargar el catálogo de productos"));
  }, [loadCatalog]);

  useEffect(() => {
    setLoading(true);
    void loadBatches()
      .catch((listError: unknown) => setError(listError instanceof Error ? listError.message : "No se pudieron cargar los despostes"))
      .finally(() => setLoading(false));
  }, [loadBatches]);

  useEffect(() => {
    if (!selectedBatchId) return;
    setLoading(true);
    setYieldSummary(null);
    void loadDetail(selectedBatchId)
      .catch((detailError: unknown) => setError(detailError instanceof Error ? detailError.message : "No se pudo cargar el desposte"))
      .finally(() => setLoading(false));
  }, [selectedBatchId, loadDetail]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2_400);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function resetHeaderForm() {
    setHeaderSourceProductId("");
    setHeaderWeightInput("");
    setHeaderCostInput("");
    setHeaderDescription("");
    setHeaderNotes("");
  }

  function openCreateForm() {
    resetHeaderForm();
    setDetail(null);
    setSelectedBatchId(null);
    setCreatingNew(true);
    setError(null);
  }

  function openEditHeaderForm() {
    if (!detail) return;
    setHeaderSourceProductId(detail.batch.sourceProductId);
    setHeaderWeightInput((detail.batch.inputWeightGrams / 1_000).toString().replace(".", ","));
    setHeaderCostInput((Number(detail.batch.costPerKgCents) / 100).toString().replace(".", ","));
    setHeaderDescription(detail.batch.description ?? "");
    setHeaderNotes(detail.batch.notes ?? "");
    setCreatingNew(true);
  }

  function parseCostInputToCents(input: string): bigint {
    const normalized = input.trim().replace(",", ".");
    const value = Number(normalized);
    if (!Number.isFinite(value) || value < 0) throw new RangeError("El costo por kilogramo no es válido");
    return BigInt(Math.round(value * 100));
  }

  async function submitHeaderForm(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const grams = parseWeightToGrams(headerWeightInput);
      const costCents = parseCostInputToCents(headerCostInput);
      if (!headerSourceProductId) throw new RangeError("Elegí el insumo de origen");

      if (detail) {
        const { error: updateError } = await supabase.rpc("update_production_batch_header", {
          p_batch_id: detail.batch.id,
          p_source_product_id: headerSourceProductId,
          p_input_weight_grams: grams,
          p_cost_per_kg_cents: Number(costCents),
          p_description: headerDescription.trim() || null,
          p_notes: headerNotes.trim() || null
        });
        if (updateError) throw updateError;
        setCreatingNew(false);
        await loadDetail(detail.batch.id);
        setNotice("Desposte actualizado");
      } else {
        const { data: newBatchId, error: createError } = await supabase.rpc("create_production_batch", {
          p_branch_id: branchId,
          p_source_product_id: headerSourceProductId,
          p_input_weight_grams: grams,
          p_cost_per_kg_cents: Number(costCents),
          p_description: headerDescription.trim() || null,
          p_notes: headerNotes.trim() || null
        });
        if (createError) throw createError;
        setCreatingNew(false);
        await loadBatches();
        setSelectedBatchId(newBatchId);
        setNotice("Desposte creado");
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "No se pudo guardar el desposte");
    }
  }

  async function submitOutput(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    setError(null);
    try {
      const grams = parseWeightToGrams(outputWeightInput);
      if (!outputProductId) throw new RangeError("Elegí un producto");
      const { error: outputError } = await supabase.rpc("set_production_batch_output", {
        p_batch_id: detail.batch.id,
        p_product_id: outputProductId,
        p_output_weight_grams: grams
      });
      if (outputError) throw outputError;
      setOutputProductId("");
      setOutputWeightInput("");
      await loadDetail(detail.batch.id);
    } catch (outputError) {
      setError(outputError instanceof Error ? outputError.message : "No se pudo agregar el producto obtenido");
    }
  }

  async function removeOutput(outputId: string) {
    if (!detail) return;
    setError(null);
    try {
      const { error: removeError } = await supabase.rpc("remove_production_batch_output", { p_output_id: outputId });
      if (removeError) throw removeError;
      await loadDetail(detail.batch.id);
    } catch (removeErrorCaught) {
      setError(removeErrorCaught instanceof Error ? removeErrorCaught.message : "No se pudo quitar el producto");
    }
  }

  async function finalizeBatch() {
    if (!detail) return;
    if (!window.confirm("¿Finalizar este desposte? Una vez finalizado no podrá modificarse.")) return;
    setError(null);
    setLoading(true);
    try {
      const { error: finalizeError } = await supabase.rpc("complete_production_batch", { p_batch_id: detail.batch.id });
      if (finalizeError) throw finalizeError;
      await loadDetail(detail.batch.id);
      await loadBatches();
      setNotice("Desposte finalizado");
    } catch (finalizeErrorCaught) {
      setError(finalizeErrorCaught instanceof Error ? finalizeErrorCaught.message : "No se pudo finalizar el desposte");
    } finally {
      setLoading(false);
    }
  }

  async function cancelBatch() {
    if (!detail) return;
    if (!window.confirm("¿Cancelar este borrador de desposte?")) return;
    setError(null);
    try {
      const { error: cancelError } = await supabase.rpc("cancel_production_batch", { p_batch_id: detail.batch.id });
      if (cancelError) throw cancelError;
      setSelectedBatchId(null);
      setDetail(null);
      await loadBatches();
      setNotice("Desposte cancelado");
    } catch (cancelErrorCaught) {
      setError(cancelErrorCaught instanceof Error ? cancelErrorCaught.message : "No se pudo cancelar el desposte");
    }
  }

  const headerPreviewCostTotal = (() => {
    try {
      const grams = parseWeightToGrams(headerWeightInput);
      const costCents = parseCostInputToCents(headerCostInput);
      return (costCents * BigInt(grams) + 500n) / 1_000n;
    } catch {
      return null;
    }
  })();

  return (
    <div className="pos-modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/80 p-3" role="dialog" aria-modal="true">
      <section className="pos-modal-panel flex h-full max-h-[95vh] w-full max-w-5xl flex-col rounded-3xl border border-stone-700 bg-stone-900 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-rose-400">Producción</p>
            <h2 className="mt-1 text-3xl font-black">Desposte</h2>
          </div>
          <button className="rounded-lg border border-stone-600 px-3 py-2" onClick={onClose} type="button">Cerrar</button>
        </div>

        {error ? <div className="mt-4 rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-red-100">{error}</div> : null}
        {notice ? <div className="pos-toast" role="status">✓ {notice}</div> : null}

        {!creatingNew && !selectedBatchId ? (
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {(["ALL", "DRAFT", "COMPLETED", "CANCELLED"] as const).map((status) => (
                  <button
                    key={status}
                    className={`rounded-xl px-4 py-2 text-sm font-bold ${statusFilter === status ? "bg-rose-600" : "bg-stone-800 hover:bg-stone-700"}`}
                    onClick={() => setStatusFilter(status)}
                    type="button"
                  >
                    {status === "ALL" ? "Todos" : STATUS_LABELS[status]}
                  </button>
                ))}
              </div>
              <button className="rounded-xl bg-rose-600 px-5 py-3 font-black hover:bg-rose-500" onClick={openCreateForm} type="button">+ Nuevo desposte</button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-stone-800">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-stone-950 text-xs uppercase tracking-wide text-stone-400">
                  <tr>
                    <th className="px-3 py-3">Fecha</th>
                    <th className="px-3 py-3">Insumo</th>
                    <th className="px-3 py-3">Peso entrada</th>
                    <th className="px-3 py-3">Peso obtenido</th>
                    <th className="px-3 py-3">Merma</th>
                    <th className="px-3 py-3">Rendimiento</th>
                    <th className="px-3 py-3">Costo</th>
                    <th className="px-3 py-3">Venta potencial</th>
                    <th className="px-3 py-3">Margen potencial</th>
                    <th className="px-3 py-3">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const margin = batch.totalSaleValueCents !== null ? batch.totalSaleValueCents - batch.costTotalCents : null;
                    return (
                      <tr key={batch.id} className="cursor-pointer border-t border-stone-800 hover:bg-stone-800" onClick={() => setSelectedBatchId(batch.id)}>
                        <td className="px-3 py-3">{formatDate(batch.createdAt)}</td>
                        <td className="px-3 py-3 font-bold">{batch.sourceProductName}</td>
                        <td className="px-3 py-3">{formatWeight(batch.inputWeightGrams)}</td>
                        <td className="px-3 py-3">{formatWeight(batch.producedWeightGrams)}</td>
                        <td className="px-3 py-3">{formatWeight(batch.wasteGrams)}</td>
                        <td className="px-3 py-3">{formatBps(batch.yieldBps)}</td>
                        <td className="px-3 py-3">{formatCurrency(batch.costTotalCents)}</td>
                        <td className="px-3 py-3">{batch.totalSaleValueCents !== null ? formatCurrency(batch.totalSaleValueCents) : "—"}</td>
                        <td className={`px-3 py-3 font-bold ${margin !== null && margin < 0n ? "text-red-400" : "text-emerald-400"}`}>{margin !== null ? formatCurrency(margin) : "—"}</td>
                        <td className="px-3 py-3">
                          <span className={`rounded-lg px-2 py-1 text-xs font-black ${batch.status === "DRAFT" ? "bg-amber-900 text-amber-200" : batch.status === "COMPLETED" ? "bg-emerald-900 text-emerald-200" : "bg-stone-700 text-stone-300"}`}>
                            {STATUS_LABELS[batch.status]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!loading && batches.length === 0 ? <p className="p-8 text-center text-stone-500">Todavía no hay despostes para este filtro.</p> : null}
            </div>
          </div>
        ) : null}

        {creatingNew ? (
          <form className="mt-5 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1" onSubmit={(event) => void submitHeaderForm(event)}>
            <label className="grid gap-1 text-sm font-bold text-stone-300">
              Producto / insumo de origen
              <select className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-lg" value={headerSourceProductId} onChange={(event) => setHeaderSourceProductId(event.target.value)} required>
                <option value="">Elegí un producto…</option>
                {catalog.map((product) => <option key={product.productId} value={product.productId}>{product.productName}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-bold text-stone-300">
              Descripción (opcional)
              <input className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3" value={headerDescription} onChange={(event) => setHeaderDescription(event.target.value)} placeholder="Media res de cerdo #1" />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="grid gap-1 text-sm font-bold text-stone-300">
                Peso de entrada (kg)
                <input className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-xl font-black" inputMode="decimal" value={headerWeightInput} onChange={(event) => setHeaderWeightInput(event.target.value)} placeholder="20" required />
              </label>
              <label className="grid gap-1 text-sm font-bold text-stone-300">
                Costo de compra por kg
                <input className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-xl font-black" inputMode="decimal" value={headerCostInput} onChange={(event) => setHeaderCostInput(event.target.value)} placeholder="4200" required />
              </label>
            </div>
            <div className="rounded-2xl bg-stone-950 p-4">
              <span className="text-sm text-stone-400">Costo total (calculado)</span>
              <strong className="block text-3xl font-black text-rose-400">{headerPreviewCostTotal !== null ? formatCurrency(headerPreviewCostTotal) : "—"}</strong>
            </div>
            <label className="grid gap-1 text-sm font-bold text-stone-300">
              Notas (opcional)
              <textarea className="rounded-xl border border-stone-700 bg-stone-950 px-4 py-3" rows={2} value={headerNotes} onChange={(event) => setHeaderNotes(event.target.value)} />
            </label>
            <div className="mt-2 flex gap-3">
              <button className="rounded-xl border border-stone-600 px-4 py-3 font-bold hover:bg-stone-800" type="button" onClick={() => { setCreatingNew(false); if (!detail) setSelectedBatchId(null); }}>
                Volver
              </button>
              <button className="rounded-xl bg-rose-600 px-4 py-3 font-black hover:bg-rose-500" type="submit">{detail ? "Guardar cambios" : "Crear desposte"}</button>
            </div>
          </form>
        ) : null}

        {!creatingNew && selectedBatchId && detail ? (
          <div className="mt-5 grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <button className="text-sm font-bold text-stone-400 hover:text-stone-200" onClick={() => { setSelectedBatchId(null); setDetail(null); }} type="button">← Volver al listado</button>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-2xl font-black">{detail.batch.description ?? detail.batch.sourceProductName}</h3>
                  <p className="text-sm text-stone-400">{detail.batch.sourceProductName} · {formatWeight(detail.batch.inputWeightGrams)} · {formatCurrency(detail.batch.costPerKgCents)}/kg · {formatDate(detail.batch.createdAt)}</p>
                </div>
                <span className={`rounded-lg px-3 py-1 text-xs font-black ${detail.batch.status === "DRAFT" ? "bg-amber-900 text-amber-200" : detail.batch.status === "COMPLETED" ? "bg-emerald-900 text-emerald-200" : "bg-stone-700 text-stone-300"}`}>
                  {STATUS_LABELS[detail.batch.status]}
                </span>
              </div>
              {detail.batch.notes ? <p className="mt-2 rounded-xl bg-stone-950 p-3 text-sm text-stone-300">{detail.batch.notes}</p> : null}

              {detail.batch.status === "DRAFT" ? (
                <div className="mt-3 flex gap-3">
                  <button className="rounded-xl border border-stone-600 px-3 py-2 text-sm font-bold hover:bg-stone-800" onClick={openEditHeaderForm} type="button">Editar datos de entrada</button>
                  <button className="rounded-xl border border-red-800 px-3 py-2 text-sm font-bold text-red-300 hover:bg-red-950" onClick={() => void cancelBatch()} type="button">Cancelar borrador</button>
                </div>
              ) : null}

              {detail.summary.missingPriceProductName ? (
                <div className="mt-4 rounded-xl border border-amber-700 bg-amber-950 px-4 py-3 text-amber-100">
                  El producto <strong>{detail.summary.missingPriceProductName}</strong> no tiene un precio de venta vigente. Configurá su precio antes de finalizar.
                </div>
              ) : null}
              {detail.summary.producedWeightGrams > detail.batch.inputWeightGrams ? (
                <div className="mt-4 rounded-xl border border-red-800 bg-red-950 px-4 py-3 text-red-100">
                  Los productos obtenidos ({formatWeight(detail.summary.producedWeightGrams)}) superan el peso de entrada ({formatWeight(detail.batch.inputWeightGrams)}). Ajustá los pesos antes de finalizar.
                </div>
              ) : null}

              <h4 className="mt-6 text-lg font-black">Productos obtenidos</h4>
              <div className="mt-2 overflow-x-auto rounded-2xl border border-stone-800">
                <table className="w-full text-left text-sm">
                  <thead className="bg-stone-950 text-xs uppercase tracking-wide text-stone-400">
                    <tr>
                      <th className="px-3 py-2">Producto</th>
                      <th className="px-3 py-2">Peso obtenido</th>
                      <th className="px-3 py-2">Precio venta/kg</th>
                      <th className="px-3 py-2">Valor potencial</th>
                      <th className="px-3 py-2">% del valor total</th>
                      <th className="px-3 py-2">Costo asignado</th>
                      <th className="px-3 py-2">Costo asignado/kg</th>
                      {detail.batch.status === "DRAFT" ? <th className="px-3 py-2" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.outputs.map((output) => {
                      const shareBps = output.saleValueCents !== null && detail.summary.totalSaleValueCents
                        ? (output.saleValueCents * 10_000n) / detail.summary.totalSaleValueCents
                        : null;
                      return (
                        <tr key={output.id} className="border-t border-stone-800">
                          <td className="px-3 py-2 font-bold">{output.productName}</td>
                          <td className="px-3 py-2">{formatWeight(output.outputWeightGrams)}</td>
                          <td className="px-3 py-2">{output.salePricePerKgCents !== null ? formatCurrency(output.salePricePerKgCents) : <span className="text-amber-400">Sin precio</span>}</td>
                          <td className="px-3 py-2">{output.saleValueCents !== null ? formatCurrency(output.saleValueCents) : "—"}</td>
                          <td className="px-3 py-2">{shareBps !== null ? formatBps(shareBps) : "—"}</td>
                          <td className="px-3 py-2">{output.allocatedCostCents !== null ? formatCurrency(output.allocatedCostCents) : "—"}</td>
                          <td className="px-3 py-2">{output.allocatedCostPerKgCents !== null ? formatCurrency(output.allocatedCostPerKgCents) : "—"}</td>
                          {detail.batch.status === "DRAFT" ? (
                            <td className="px-3 py-2">
                              <button className="text-xs font-bold text-red-400 hover:text-red-300" onClick={() => void removeOutput(output.id)} type="button">Quitar</button>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {detail.outputs.length === 0 ? <p className="p-6 text-center text-stone-500">Todavía no se agregaron productos obtenidos.</p> : null}
              </div>

              {detail.batch.status === "DRAFT" ? (
                <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => void submitOutput(event)}>
                  <label className="grid gap-1 text-sm font-bold text-stone-300">
                    Producto
                    <select className="rounded-xl border border-stone-700 bg-stone-950 px-3 py-2" value={outputProductId} onChange={(event) => setOutputProductId(event.target.value)} required>
                      <option value="">Elegí un producto…</option>
                      {catalog.filter((product) => product.productId !== detail.batch.sourceProductId).map((product) => (
                        <option key={product.productId} value={product.productId}>{product.productName}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-bold text-stone-300">
                    Peso obtenido (kg)
                    <input className="w-32 rounded-xl border border-stone-700 bg-stone-950 px-3 py-2" inputMode="decimal" value={outputWeightInput} onChange={(event) => setOutputWeightInput(event.target.value)} placeholder="5,050" required />
                  </label>
                  <button className="rounded-xl bg-stone-800 px-4 py-2 font-bold hover:bg-stone-700" type="submit">+ Agregar producto</button>
                </form>
              ) : null}
            </div>

            <aside className="rounded-2xl border border-stone-800 bg-stone-950 p-4">
              <h4 className="text-lg font-black">Resumen</h4>
              <dl className="mt-3 grid gap-2 text-sm">
                <div className="flex justify-between"><dt className="text-stone-400">Peso entrada</dt><dd className="font-bold">{formatWeight(detail.batch.inputWeightGrams)}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Peso producido</dt><dd className="font-bold">{formatWeight(detail.summary.producedWeightGrams)}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Merma</dt><dd className="font-bold text-amber-300">{formatWeight(Math.max(detail.summary.wasteGrams, 0))}{detail.summary.wasteGrams < 0 ? " (excedido)" : ""}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Merma %</dt><dd className="font-bold">{formatBps(detail.summary.wastePercentageBps)}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Rendimiento</dt><dd className="font-bold text-emerald-400">{formatBps(detail.summary.yieldBps)}</dd></div>
                <div className="mt-2 border-t border-stone-800 pt-2 flex justify-between"><dt className="text-stone-400">Costo del lote</dt><dd className="font-bold">{formatCurrency(detail.batch.costTotalCents)}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Costo promedio/kg producido</dt><dd className="font-bold">{detail.summary.averageCostPerKgCents !== null ? formatCurrency(detail.summary.averageCostPerKgCents) : "—"}</dd></div>
                <div className="mt-2 border-t border-stone-800 pt-2 flex justify-between"><dt className="text-stone-400">Venta potencial</dt><dd className="font-bold">{detail.summary.totalSaleValueCents !== null ? formatCurrency(detail.summary.totalSaleValueCents) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Margen bruto potencial</dt><dd className={`font-bold ${detail.summary.grossMarginCents !== null && detail.summary.grossMarginCents < 0n ? "text-red-400" : "text-emerald-400"}`}>{detail.summary.grossMarginCents !== null ? formatCurrency(detail.summary.grossMarginCents) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Margen sobre ventas</dt><dd className="font-bold">{formatBps(detail.summary.marginOverSalesBps)}</dd></div>
                <div className="flex justify-between"><dt className="text-stone-400">Rentabilidad sobre costo</dt><dd className="font-bold">{formatBps(detail.summary.profitabilityOverCostBps)}</dd></div>
              </dl>
              <p className="mt-3 text-xs text-stone-500">El costo por producto es una asignación por valor relativo de venta, no el costo de compra individual de cada corte.</p>

              {yieldSummary && yieldSummary.sampleSize > 0 ? (
                <div className="mt-4 rounded-xl bg-stone-900 p-3">
                  <p className="text-xs font-black uppercase text-stone-500">Últimos {yieldSummary.sampleSize} despostes de {detail.batch.sourceProductName}</p>
                  <p className="mt-1 text-sm">Rendimiento promedio: <strong>{formatBps(yieldSummary.averageYieldBps)}</strong></p>
                  <p className="text-sm">Merma promedio: <strong>{formatBps(yieldSummary.averageWastePercentageBps)}</strong></p>
                </div>
              ) : null}

              {detail.batch.status === "DRAFT" ? (
                <button
                  className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-3 font-black hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!detail.summary.canFinalize || loading}
                  onClick={() => void finalizeBatch()}
                  type="button"
                >
                  Finalizar desposte
                </button>
              ) : null}
              {detail.batch.status === "COMPLETED" ? (
                <p className="mt-5 text-sm text-stone-400">Finalizado el {formatDate(detail.batch.completedAt)} por {detail.batch.completedByName ?? "—"}.</p>
              ) : null}
              {detail.batch.status === "CANCELLED" ? (
                <p className="mt-5 text-sm text-stone-400">Cancelado el {formatDate(detail.batch.cancelledAt)} por {detail.batch.cancelledByName ?? "—"}.</p>
              ) : null}
            </aside>
          </div>
        ) : null}
      </section>
    </div>
  );
}
