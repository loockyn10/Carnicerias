import { formatWeight } from "@carnicerias/business-logic";

import { TransferForm } from "../../../components/transfer-form";
import { requireAdminContext } from "../../../lib/admin";
import { createPerfLogger } from "../../../lib/perf";
import { createClient } from "../../../lib/supabase/server";
import type { StockTransfer } from "../../../lib/transfers";

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function dateTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("es-AR", { timeZone, dateStyle: "short", timeStyle: "short" });
}

export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/transfers");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const fromBatchId = value("fromBatch");

  const supabase = await createClient();
  const [branchesResult, productsResult, transfersResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("products", supabase.from("products").select("id, name").eq("organization_id", context.organizationId).eq("active", true).eq("unit_type", "WEIGHT").order("name")),
    perf.measure("transfers", supabase.rpc("list_stock_transfers", { p_limit: 50 }))
  ]);

  const detailResult = fromBatchId
    ? await perf.measure("batchDetail", supabase.rpc("get_production_batch_detail", { p_batch_id: fromBatchId }))
    : { data: null, error: null };
  perf.flush();

  const branches = branchesResult.data ?? [];
  const products = productsResult.data ?? [];
  const transfers = jsonArray<StockTransfer>(transfersResult.data);
  const error = branchesResult.error ?? productsResult.error ?? transfersResult.error ?? detailResult.error;

  const batch = detailResult.data as { batch: { branchId: string; status: string }; outputs: { productId: string; outputWeightGrams: number }[] } | null;
  const prefill = batch?.batch.status === "COMPLETED"
    ? { sourceBranchId: batch.batch.branchId, items: batch.outputs.map((output) => ({ productId: output.productId, weightGrams: output.outputWeightGrams })) }
    : undefined;

  return <main className="mx-auto max-w-5xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Stock</p>
    <h1 className="mt-1 text-3xl font-black">Distribución entre sucursales</h1>
    <p className="mt-2 text-stone-600">Mové stock ya producido (por ejemplo, después de un desposte) de una sucursal a otra. Se descuenta del origen y se suma al destino en una única operación.</p>
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-800">No se pudo cargar Distribución: {error.message}</p> : null}

    <TransferForm branches={branches} initialItems={prefill?.items} initialSourceBranchId={prefill?.sourceBranchId} products={products} />

    <section className="mt-8">
      <h2 className="text-xl font-black">Historial</h2>
      <div className="mt-3 space-y-3">
        {transfers.map((transfer) => <article className="rounded-xl border bg-white p-4 shadow-sm" key={transfer.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-bold">{transfer.sourceBranchName} → {transfer.destinationBranchName}</p>
            <p className="text-sm text-stone-500">{dateTime(transfer.createdAt, context.timezone)}</p>
          </div>
          <p className="mt-1 text-sm text-stone-600">{formatWeight(transfer.totalWeightGrams)} · {transfer.itemCount} producto{transfer.itemCount === 1 ? "" : "s"} · realizada por {transfer.createdByName}</p>
          <p className="mt-2 text-sm text-stone-500">{transfer.items.map((item) => `${item.productName} ${formatWeight(item.quantityGrams)}`).join(", ")}</p>
          {transfer.notes ? <p className="mt-1 text-xs italic text-stone-400">{transfer.notes}</p> : null}
        </article>)}
        {!transfers.length && !error ? <p className="rounded-xl border bg-white p-8 text-center text-stone-500 shadow-sm">Todavía no se registraron transferencias.</p> : null}
      </div>
    </section>
  </main>;
}
