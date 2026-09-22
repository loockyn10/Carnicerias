import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { AddProductionBatchOutputForm } from "../../../components/add-production-batch-output-form";
import { CancelProductionBatchButton } from "../../../components/cancel-production-batch-button";
import { CreateProductionBatchForm } from "../../../components/create-production-batch-form";
import { EditProductionBatchHeaderForm } from "../../../components/edit-production-batch-header-form";
import { FinalizeProductionBatchButton } from "../../../components/finalize-production-batch-button";
import { requireAdminContext } from "../../../lib/admin";
import { createPerfLogger } from "../../../lib/perf";
import {
  formatBps,
  PRODUCTION_STATUS_LABELS,
  type ProductionBatchDetail,
  type ProductionBatchListItem,
  type ProductionBatchStatus,
  type ProductionYieldSummary
} from "../../../lib/production";
import { createClient } from "../../../lib/supabase/server";
import { removeProductionBatchOutputAction } from "../actions";

const STATUS_FILTERS: { value: "" | ProductionBatchStatus; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "DRAFT", label: "Borrador" },
  { value: "COMPLETED", label: "Finalizado" },
  { value: "CANCELLED", label: "Cancelado" }
];

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function dateTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("es-AR", { timeZone, dateStyle: "short", timeStyle: "short" });
}

function statusTone(status: ProductionBatchStatus) {
  if (status === "DRAFT") return "bg-amber-100 text-amber-800";
  if (status === "COMPLETED") return "bg-emerald-100 text-emerald-800";
  return "bg-stone-200 text-stone-600";
}

export default async function ProductionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/production");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const batchId = value("batch");
  const isNew = value("new") === "1";
  const statusFilter = value("status") as ProductionBatchStatus | "";

  const supabase = await createClient();
  const [batchesResult, branchesResult, productsResult] = await Promise.all([
    perf.measure("batches", supabase.rpc("list_production_batches", { p_branch_id: null, p_status: statusFilter || null, p_limit: 50 })),
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("products", supabase.from("products").select("id, name, sku").eq("organization_id", context.organizationId).eq("active", true).eq("unit_type", "WEIGHT").order("name"))
  ]);
  const batches = jsonArray<ProductionBatchListItem>(batchesResult.data);
  const branches = branchesResult.data ?? [];
  const products = productsResult.data ?? [];

  const detailResult = batchId
    ? await perf.measure("detail", supabase.rpc("get_production_batch_detail", { p_batch_id: batchId }))
    : { data: null, error: null };
  const detail = detailResult.data as unknown as ProductionBatchDetail | null;

  const yieldSummaryResult = detail
    ? await perf.measure("yieldSummary", supabase.rpc("get_production_yield_summary", { p_source_product_id: detail.batch.sourceProductId, p_limit: 10 }))
    : { data: null, error: null };
  const yieldSummary = yieldSummaryResult.data as unknown as ProductionYieldSummary | null;

  const error = batchesResult.error ?? branchesResult.error ?? productsResult.error ?? detailResult.error;
  perf.flush();

  const outputProducts = detail ? products.filter((product) => product.id !== detail.batch.sourceProductId) : products;

  return <main className="mx-auto max-w-6xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Producción</p>
    <h1 className="mt-1 text-3xl font-black">Desposte</h1>
    <p className="mt-2 text-stone-600">Transformar un insumo comprado por peso en productos del catálogo, con costo asignado por valor relativo de venta y rentabilidad proyectada.</p>
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-800">No se pudo cargar Desposte: {error.message}</p> : null}
    {batchId && !detail && !error ? <p className="mt-5 rounded-xl bg-amber-50 p-4 text-amber-900">El desposte solicitado no existe o no pertenece a tu organización. <Link className="font-bold underline" href="/admin/production">Volver al listado</Link></p> : null}

    {!batchId && !isNew ? <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => <Link
            className={`rounded-lg px-3 py-2 text-sm font-bold ${statusFilter === filter.value ? "bg-rose-800 text-white" : "bg-white text-stone-600 hover:bg-stone-100"}`}
            href={filter.value ? `/admin/production?status=${filter.value}` : "/admin/production"}
            key={filter.value || "all"}
          >{filter.label}</Link>)}
        </div>
        <Link className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white hover:bg-rose-700" href="/admin/production?new=1">+ Nuevo desposte</Link>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-stone-50"><tr>
            <th className="p-3">Fecha</th><th className="p-3">Sucursal</th><th className="p-3">Insumo</th>
            <th className="p-3">Peso entrada</th><th className="p-3">Peso obtenido</th><th className="p-3">Merma</th>
            <th className="p-3">Rendimiento</th><th className="p-3">Costo</th><th className="p-3">Venta potencial</th>
            <th className="p-3">Margen potencial</th><th className="p-3">Estado</th>
          </tr></thead>
          <tbody>{batches.map((batch) => {
            const margin = batch.totalSaleValueCents !== null ? batch.totalSaleValueCents - batch.costTotalCents : null;
            return <tr className="cursor-pointer border-t hover:bg-stone-50" key={batch.id}>
              <td className="p-3"><Link className="block" href={`/admin/production?batch=${batch.id}`}>{dateTime(batch.createdAt, context.timezone)}</Link></td>
              <td className="p-3">{batch.branchName}</td>
              <td className="p-3 font-bold">{batch.sourceProductName}</td>
              <td className="p-3">{formatWeight(batch.inputWeightGrams)}</td>
              <td className="p-3">{formatWeight(batch.producedWeightGrams)}</td>
              <td className="p-3">{formatWeight(batch.wasteGrams)}</td>
              <td className="p-3">{formatBps(batch.yieldBps)}</td>
              <td className="p-3">{formatCurrency(BigInt(batch.costTotalCents))}</td>
              <td className="p-3">{batch.totalSaleValueCents !== null ? formatCurrency(BigInt(batch.totalSaleValueCents)) : "—"}</td>
              <td className={`p-3 font-bold ${margin !== null && margin < 0 ? "text-red-700" : "text-emerald-700"}`}>{margin !== null ? formatCurrency(BigInt(margin)) : "—"}</td>
              <td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-black ${statusTone(batch.status)}`}>{PRODUCTION_STATUS_LABELS[batch.status]}</span></td>
            </tr>;
          })}</tbody>
        </table></div>
        {!batches.length && !error ? <p className="p-8 text-center text-stone-500">No hay despostes para este filtro.</p> : null}
      </div>
    </section> : null}

    {isNew ? <section className="mt-6">
      <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/production">← Volver al listado</Link>
      <h2 className="mt-2 text-2xl font-black">Nuevo desposte</h2>
      <CreateProductionBatchForm branches={branches} products={products} />
    </section> : null}

    {detail ? <section className="mt-6">
      <Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/production">← Volver al listado</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black">{detail.batch.description ?? detail.batch.sourceProductName}</h2>
          <p className="text-sm text-stone-500">{detail.batch.branchName} · {detail.batch.sourceProductName} · {dateTime(detail.batch.createdAt, context.timezone)} · registrado por {detail.batch.createdByName}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-black ${statusTone(detail.batch.status)}`}>{PRODUCTION_STATUS_LABELS[detail.batch.status]}</span>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-5">
          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h3 className="font-black">Datos de entrada</h3>
            {detail.batch.status === "DRAFT" ? (
              <EditProductionBatchHeaderForm batch={detail.batch} products={products} />
            ) : (
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-stone-500">Insumo</dt><dd className="font-bold">{detail.batch.sourceProductName}</dd></div>
                <div><dt className="text-stone-500">Descripción</dt><dd className="font-bold">{detail.batch.description ?? "—"}</dd></div>
                <div><dt className="text-stone-500">Peso de entrada</dt><dd className="font-bold">{formatWeight(detail.batch.inputWeightGrams)}</dd></div>
                <div><dt className="text-stone-500">Costo/kg</dt><dd className="font-bold">{formatCurrency(BigInt(detail.batch.costPerKgCents))}</dd></div>
                <div><dt className="text-stone-500">Notas</dt><dd className="font-bold">{detail.batch.notes ?? "—"}</dd></div>
              </dl>
            )}
          </section>

          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h3 className="font-black">Productos obtenidos</h3>
            {detail.summary.missingPriceProductName ? <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">El producto <strong>{detail.summary.missingPriceProductName}</strong> no tiene un precio de venta vigente. Configurá su precio antes de finalizar.</p> : null}
            {detail.summary.producedWeightGrams > detail.batch.inputWeightGrams ? <p className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">Los productos obtenidos ({formatWeight(detail.summary.producedWeightGrams)}) superan el peso de entrada ({formatWeight(detail.batch.inputWeightGrams)}).</p> : null}
            <div className="mt-3 overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-stone-50"><tr>
                  <th className="p-2">Producto</th><th className="p-2">Peso</th><th className="p-2">Precio venta/kg</th>
                  <th className="p-2">Valor potencial</th><th className="p-2">% del valor total</th>
                  <th className="p-2">Costo asignado</th><th className="p-2">Costo asignado/kg</th>
                  {detail.batch.status === "DRAFT" ? <th className="p-2" /> : null}
                </tr></thead>
                <tbody>{detail.outputs.map((output) => {
                  const shareBps = output.saleValueCents !== null && detail.summary.totalSaleValueCents
                    ? Math.round((output.saleValueCents * 10_000) / detail.summary.totalSaleValueCents)
                    : null;
                  return <tr className="border-t" key={output.id}>
                    <td className="p-2 font-bold">{output.productName}</td>
                    <td className="p-2">{formatWeight(output.outputWeightGrams)}</td>
                    <td className="p-2">{output.salePricePerKgCents !== null ? formatCurrency(BigInt(output.salePricePerKgCents)) : <span className="font-bold text-amber-700">Sin precio</span>}</td>
                    <td className="p-2">{output.saleValueCents !== null ? formatCurrency(BigInt(output.saleValueCents)) : "—"}</td>
                    <td className="p-2">{shareBps !== null ? formatBps(shareBps) : "—"}</td>
                    <td className="p-2">{output.allocatedCostCents !== null ? formatCurrency(BigInt(output.allocatedCostCents)) : "—"}</td>
                    <td className="p-2">{output.allocatedCostPerKgCents !== null ? formatCurrency(BigInt(output.allocatedCostPerKgCents)) : "—"}</td>
                    {detail.batch.status === "DRAFT" ? <td className="p-2">
                      <form action={removeProductionBatchOutputAction}>
                        <input name="output_id" type="hidden" value={output.id} />
                        <button className="text-xs font-bold text-red-700 hover:underline" type="submit">Quitar</button>
                      </form>
                    </td> : null}
                  </tr>;
                })}</tbody>
              </table>
              {!detail.outputs.length ? <p className="p-6 text-center text-stone-500">Todavía no se agregaron productos obtenidos.</p> : null}
            </div>
            {detail.batch.status === "DRAFT" ? <AddProductionBatchOutputForm batchId={detail.batch.id} products={outputProducts} /> : null}
          </section>
        </div>

        <div className="space-y-5">
          <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h3 className="font-black">Resumen</h3>
            <dl className="mt-3 grid gap-2 text-sm">
              <div className="flex justify-between"><dt className="text-stone-500">Peso entrada</dt><dd className="font-bold">{formatWeight(detail.batch.inputWeightGrams)}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Peso producido</dt><dd className="font-bold">{formatWeight(detail.summary.producedWeightGrams)}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Merma</dt><dd className="font-bold text-amber-800">{formatWeight(detail.summary.wasteGrams)}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Merma %</dt><dd className="font-bold">{formatBps(detail.summary.wastePercentageBps)}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Rendimiento</dt><dd className="font-bold text-emerald-800">{formatBps(detail.summary.yieldBps)}</dd></div>
              <div className="mt-2 flex justify-between border-t pt-2"><dt className="text-stone-500">Costo del lote</dt><dd className="font-bold">{formatCurrency(BigInt(detail.batch.costTotalCents))}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Costo promedio/kg producido</dt><dd className="font-bold">{detail.summary.averageCostPerKgCents !== null ? formatCurrency(BigInt(detail.summary.averageCostPerKgCents)) : "—"}</dd></div>
              <div className="mt-2 flex justify-between border-t pt-2"><dt className="text-stone-500">Venta potencial</dt><dd className="font-bold">{detail.summary.totalSaleValueCents !== null ? formatCurrency(BigInt(detail.summary.totalSaleValueCents)) : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Margen bruto potencial</dt><dd className={`font-bold ${detail.summary.grossMarginCents !== null && detail.summary.grossMarginCents < 0 ? "text-red-700" : "text-emerald-800"}`}>{detail.summary.grossMarginCents !== null ? formatCurrency(BigInt(detail.summary.grossMarginCents)) : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Margen sobre ventas</dt><dd className="font-bold">{formatBps(detail.summary.marginOverSalesBps)}</dd></div>
              <div className="flex justify-between"><dt className="text-stone-500">Rentabilidad sobre costo</dt><dd className="font-bold">{formatBps(detail.summary.profitabilityOverCostBps)}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-stone-500">El costo por producto es una asignación por valor relativo de venta, no el costo de compra individual de cada corte.</p>
          </section>

          {yieldSummary && yieldSummary.sampleSize > 0 ? <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <h3 className="font-black">Rendimiento histórico</h3>
            <p className="mt-1 text-sm text-stone-500">Últimos {yieldSummary.sampleSize} despostes de {detail.batch.sourceProductName}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-stone-500">Rendimiento promedio</dt><dd className="text-lg font-black text-emerald-800">{formatBps(yieldSummary.averageYieldBps)}</dd></div>
              <div><dt className="text-stone-500">Merma promedio</dt><dd className="text-lg font-black text-amber-800">{formatBps(yieldSummary.averageWastePercentageBps)}</dd></div>
            </div>
          </section> : null}

          {detail.batch.status === "DRAFT" ? <section className="rounded-2xl border bg-white p-5 shadow-sm">
            <FinalizeProductionBatchButton batchId={detail.batch.id} disabled={!detail.summary.canFinalize} />
            <div className="mt-3"><CancelProductionBatchButton batchId={detail.batch.id} /></div>
          </section> : null}
          {detail.batch.status === "COMPLETED" ? <p className="rounded-2xl border bg-white p-5 text-sm text-stone-500 shadow-sm">Finalizado el {dateTime(detail.batch.completedAt ?? detail.batch.createdAt, context.timezone)} por {detail.batch.completedByName ?? "—"}.</p> : null}
          {detail.batch.status === "CANCELLED" ? <p className="rounded-2xl border bg-white p-5 text-sm text-stone-500 shadow-sm">Cancelado el {dateTime(detail.batch.cancelledAt ?? detail.batch.createdAt, context.timezone)} por {detail.batch.cancelledByName ?? "—"}.</p> : null}
        </div>
      </div>
    </section> : null}
  </main>;
}
