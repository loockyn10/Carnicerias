import { formatStockQuantity, formatWeight, stockQuantityToInput } from "@carnicerias/business-logic";

import { TransferForm } from "../../../components/transfer-form";
import { requireAdminContext } from "../../../lib/admin";
import { parseTransferPrefill } from "../../../lib/carry-transfer";
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
  const [branchesResult, transfersResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("transfers", supabase.rpc("list_stock_transfers", { p_limit: 50 }))
  ]);

  const detailResult = fromBatchId
    ? await perf.measure("batchDetail", supabase.rpc("get_production_batch_detail", { p_batch_id: fromBatchId }))
    : { data: null, error: null };
  // «Qué llevar» → «Registrar la carga» (celular): origen, destino y cantidades vienen en el link; los nombres y el tipo de cada producto se leen acá.
  const carry = parseTransferPrefill({ from: value("from"), to: value("to"), items: value("items") });
  const carryProductsResult = carry.items.length
    ? await perf.measure("carryProducts", supabase.from("products").select("id, name, sku, unit_type").eq("organization_id", context.organizationId).in("id", carry.items.map((item) => item.productId)))
    : { data: [], error: null };
  perf.flush();

  const branches = branchesResult.data ?? [];
  const transfers = jsonArray<StockTransfer>(transfersResult.data);
  const error = branchesResult.error ?? transfersResult.error ?? detailResult.error ?? carryProductsResult.error;

  const batch = detailResult.data as { batch: { branchId: string; status: string }; outputs: { productId: string; productName: string; outputWeightGrams: number; outputQuantityUnits: number | null }[] } | null;
  // A desposte output sold by unit moves in units (its ledger stock IS the unit count), a weighed one in kg.
  const prefill = batch?.batch.status === "COMPLETED"
    ? {
        sourceBranchId: batch.batch.branchId,
        lines: batch.outputs.map((output) => {
          const unitType = output.outputQuantityUnits != null ? "UNIT" as const : "WEIGHT" as const;
          return { productId: output.productId, productName: output.productName, sku: null, unitType, quantity: stockQuantityToInput(output.outputQuantityUnits ?? output.outputWeightGrams, unitType) };
        })
      }
    : undefined;

  const carryById = new Map((carryProductsResult.data ?? []).map((product) => [product.id, product]));
  const carryLines = carry.items.flatMap((item) => {
    const product = carryById.get(item.productId);
    return product ? [{ productId: product.id, productName: product.name, sku: product.sku, unitType: product.unit_type, quantity: stockQuantityToInput(item.quantity, product.unit_type) }] : [];
  });
  const branchIds = new Set(branches.map((branch) => branch.id));
  const carrySource = carry.sourceBranchId && branchIds.has(carry.sourceBranchId) ? carry.sourceBranchId : undefined;
  const carryDestination = carry.destinationBranchId && branchIds.has(carry.destinationBranchId) ? carry.destinationBranchId : undefined;

  return <main className="mx-auto max-w-5xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Stock</p>
    <h1 className="mt-1 text-3xl font-black">Distribución entre sucursales</h1>
    <p className="mt-2 text-stone-600">Mové stock de una sucursal a otra (por ejemplo, después de un desposte o mercadería de almacén). Productos por peso en kg, por unidad en unidades enteras. Se descuenta del origen y se suma al destino en una única operación; el destino debe tener el producto habilitado.</p>
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-800">No se pudo cargar Distribución: {error.message}</p> : null}

    <TransferForm branches={branches} initialDestinationBranchId={prefill ? undefined : carryDestination} initialLines={prefill?.lines ?? (carryLines.length ? carryLines : undefined)} initialSourceBranchId={prefill?.sourceBranchId ?? carrySource} />

    <section className="mt-8">
      <h2 className="text-xl font-black">Historial</h2>
      <div className="mt-3 space-y-3">
        {transfers.map((transfer) => <article className="rounded-xl border bg-white p-4 shadow-sm" key={transfer.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-bold">{transfer.sourceBranchName} → {transfer.destinationBranchName}</p>
            <p className="text-sm text-stone-500">{dateTime(transfer.createdAt, context.timezone)}</p>
          </div>
          <p className="mt-1 text-sm text-stone-600">{[transfer.totalWeightGrams > 0 ? formatWeight(transfer.totalWeightGrams) : "", transfer.totalUnits > 0 ? formatStockQuantity(transfer.totalUnits, "UNIT") : ""].filter(Boolean).join(" + ") || "—"} · {transfer.itemCount} producto{transfer.itemCount === 1 ? "" : "s"} · realizada por {transfer.createdByName}</p>
          <p className="mt-2 text-sm text-stone-500">{transfer.items.map((item) => `${item.productName} ${formatStockQuantity(item.quantityGrams, item.unitType)}`).join(", ")}</p>
          {transfer.notes ? <p className="mt-1 text-xs italic text-stone-400">{transfer.notes}</p> : null}
        </article>)}
        {!transfers.length && !error ? <p className="rounded-xl border bg-white p-8 text-center text-stone-500 shadow-sm">Todavía no se registraron transferencias.</p> : null}
      </div>
    </section>
  </main>;
}
