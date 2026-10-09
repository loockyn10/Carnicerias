import { formatStockQuantity } from "@carnicerias/business-logic";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuditMovementsTable, AuditSalesCheckCard, AuditSummaryCard } from "../../../../components/stock-audit-panels";
import { ProductPicker } from "../../../../components/product-picker";
import { SectionTabs } from "../../../../components/section-tabs";
import { StockPhysicalCount } from "../../../../components/stock-physical-count";
import { requireAdminContext } from "../../../../lib/admin";
import { formatIsoDate } from "../../../../lib/date-range";
import { createPerfLogger } from "../../../../lib/perf";
import { auditPeriodDateRange, parseAuditMovementsPage, parseStockAuditSummary, periodRpcArgs, productSalesHref, resolveAuditPeriod, stockAuditHref } from "../../../../lib/stock-audit";
import { createClient } from "../../../../lib/supabase/server";

const STOCK_TABS = [
  { label: "Operaciones", href: "/admin/stock" },
  { label: "Por sucursal", href: "/admin/branch-stock" },
  { label: "Reposición", href: "/admin/replenishment" }
];
const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

/**
 * Auditoría de UN producto en UNA sucursal: reconstruye el stock teórico desde el ledger (`stock_movements`) con un
 * resumen por tipo, un detalle cronológico paginado, el control contra las ventas COMPLETED y el conteo físico.
 * Todo se agrega en el servidor (RPC `get_stock_audit_summary` / `list_stock_audit_movements`); el navegador nunca
 * recibe miles de movimientos. Sólo lectura: el único camino que escribe es el ajuste confirmado del conteo físico.
 */
export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/branch-stock/movements");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => (typeof params[key] === "string" ? params[key] : "");
  const supabase = await createClient();

  const branchId = UUID.test(value("branch")) ? value("branch") : "";
  const productId = UUID.test(value("product")) ? value("product") : "";
  const branchesResult = await perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"));
  const branches = branchesResult.data ?? [];

  const shell = (children: ReactNode) => (
    <main className="mx-auto max-w-7xl p-5 sm:p-10">
      <p className="text-sm text-stone-500">Inicio / Stock / <Link className="hover:underline" href="/admin/branch-stock">Por sucursal</Link> / Movimientos</p>
      <h1 className="mt-1 text-3xl font-black tracking-tight">Movimientos de stock</h1>
      <SectionTabs active="/admin/branch-stock" tabs={STOCK_TABS} />
      {children}
    </main>
  );

  if (!branchId || !productId) {
    perf.flush();
    return shell(<form className="mt-6 grid max-w-2xl gap-3 rounded-xl bg-white p-5 shadow-sm" method="get">
      <p className="text-sm text-stone-600">Elegí un producto y una sucursal para reconstruir cómo se llegó a su stock teórico.</p>
      <label className="grid gap-1 text-xs font-bold text-stone-500">Sucursal
        <select className={input} defaultValue={branchId} name="branch" required>
          <option value="">Elegí una sucursal</option>
          {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-bold text-stone-500">Producto<ProductPicker includeInactive name="product" /></label>
      <button className="justify-self-start rounded-lg bg-rose-800 px-5 py-2 font-bold text-white">Ver movimientos</button>
    </form>);
  }

  const { period, error: periodError } = resolveAuditPeriod({ mode: value("mode"), from: value("from"), to: value("to") }, context.timezone);
  const parsedPage = Number(value("page") || 1);
  const pageNumber = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const newestFirst = value("order") === "newest";
  const rpcArgs = periodRpcArgs(period);

  const [summaryResult, movementsResult] = await Promise.all([
    perf.measure("auditSummary", supabase.rpc("get_stock_audit_summary", { p_branch_id: branchId, p_product_id: productId, ...rpcArgs })),
    perf.measure("auditMovements", supabase.rpc("list_stock_audit_movements", { p_branch_id: branchId, p_product_id: productId, ...rpcArgs, p_limit: PAGE_SIZE, p_offset: (pageNumber - 1) * PAGE_SIZE, p_newest_first: newestFirst }))
  ]);
  const rpcError = summaryResult.error ?? movementsResult.error;
  if (rpcError) {
    perf.flush();
    return shell(<p className="mt-6 rounded-lg bg-red-50 p-4 text-red-800" role="alert">No se pudo cargar la auditoría: {rpcError.message}</p>);
  }

  const summary = parseStockAuditSummary(summaryResult.data);
  const movements = parseAuditMovementsPage(movementsResult.data);
  perf.flush();

  const hrefFor = (target: { page: number; newestFirst: boolean }) => stockAuditHref({ branchId, productId, period, page: target.page, newestFirst: target.newestFirst });
  const salesRange = auditPeriodDateRange(summary, context.timezone);
  const chip = (active: boolean) => `rounded-full px-4 py-2 text-sm font-bold ${active ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`;
  const rangeFrom = period.mode === "range" ? period.from : salesRange.from;
  const rangeTo = period.mode === "range" ? period.to : salesRange.to;

  return shell(<>
    <section className="mt-6 flex flex-wrap items-start justify-between gap-4 rounded-xl bg-white p-4 shadow-sm" data-testid="audit-header">
      <div>
        <p className="text-sm text-stone-500">{summary.branch.name}</p>
        <h2 className="text-2xl font-black">{summary.product.name}{summary.product.active ? null : <span className="ml-2 text-sm font-bold text-amber-700">inactivo</span>}</h2>
        <p className="text-sm text-stone-500">{summary.product.sku ? `${summary.product.sku} · ` : ""}{summary.product.unitType === "WEIGHT" ? "se vende por kg" : "se vende por unidad"}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm font-bold">
          <Link className="rounded-lg border px-3 py-2 text-rose-800 hover:bg-rose-50" href={productSalesHref({ productId, branchId, range: salesRange })}>Ver ventas</Link>
          <Link className="rounded-lg border px-3 py-2 text-stone-700 hover:bg-stone-50" href="/admin/branch-stock/movements">Cambiar producto o sucursal</Link>
        </div>
      </div>
      <div className="text-right">
        <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Stock teórico actual</p>
        <p className={`text-4xl font-black ${summary.currentQuantity <= 0 ? "text-red-700" : "text-rose-800"}`}>{formatStockQuantity(summary.currentQuantity, summary.product.unitType)}</p>
        <p className="text-xs text-stone-500">Suma de todos los movimientos del ledger</p>
      </div>
    </section>

    <div className="mt-4 rounded-xl bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-2">
        <Link aria-current={period.mode === "since-inbound" ? "true" : undefined} className={chip(period.mode === "since-inbound")} href={stockAuditHref({ branchId, productId })}>Desde último ingreso</Link>
        <form className="flex flex-wrap items-end gap-2 sm:ml-3" method="get">
          <input name="branch" type="hidden" value={branchId} />
          <input name="product" type="hidden" value={productId} />
          <input name="mode" type="hidden" value="range" />
          <label className="grid gap-1 text-xs font-bold text-stone-500">Desde<input className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" defaultValue={rangeFrom} name="from" required type="date" /></label>
          <label className="grid gap-1 text-xs font-bold text-stone-500">Hasta<input className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal text-stone-900" defaultValue={rangeTo} name="to" required type="date" /></label>
          <button className={`rounded-lg border px-4 py-2 text-sm font-bold ${period.mode === "range" ? "border-rose-800 text-rose-800" : ""}`} type="submit">Ver rango</button>
        </form>
      </div>
      {period.mode === "range" ? <p className="mt-2 text-xs text-stone-500">Rango del {formatIsoDate(period.from)} al {formatIsoDate(period.to)}.</p> : null}
      {periodError ? <p className="mt-2 text-sm text-red-700" role="alert">{periodError} Se muestran los últimos 7 días.</p> : null}
    </div>

    <AuditSummaryCard summary={summary} timeZone={context.timezone} />
    <AuditSalesCheckCard summary={summary} timeZone={context.timezone} />
    <StockPhysicalCount branchId={branchId} productId={productId} systemQuantity={summary.currentQuantity} unitType={summary.product.unitType} />
    <AuditMovementsTable hrefFor={hrefFor} page={movements} summary={summary} timeZone={context.timezone} />
  </>);
}
