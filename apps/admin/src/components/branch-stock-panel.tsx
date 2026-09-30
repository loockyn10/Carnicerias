import { formatStockQuantity } from "@carnicerias/business-logic";
import Link from "next/link";

import { StatusBadge } from "./admin-ui";

export interface BranchStockRow { productId: string; productName: string; sku: string | null; unitType: "WEIGHT" | "UNIT"; current: number; minimum: number; target: number; suggested: number; configured: boolean; rank: number; label: string; daily: number }
export type BranchStockFilter = "all" | "critical" | "low" | "available";
export const BRANCH_STOCK_PAGE_SIZE = 50;

const FILTERS: [BranchStockFilter, string][] = [["all", "Todos"], ["critical", "Críticos"], ["low", "Bajo mínimo"], ["available", "Disponibles"]];

/**
 * Stock tab of a branch. Search, status filter and paging happen in SQL (get_branch_stock_status):
 * a Central with thousands of products is never loaded whole. Quantities are shown in each product
 * own unit (kg for weighed products, units for counted ones).
 */
export function BranchStockPanel({ branchId, rows, search, filter, page, totalRows }: {
  branchId: string; rows: BranchStockRow[]; search: string; filter: BranchStockFilter; page: number; totalRows: number;
}) {
  const totalPages = Math.max(1, Math.ceil(totalRows / BRANCH_STOCK_PAGE_SIZE));
  const href = (next: { filter?: BranchStockFilter; page?: number }) => {
    const query = new URLSearchParams({ tab: "stock" });
    if (search) query.set("q", search);
    const targetFilter = next.filter ?? filter;
    if (targetFilter !== "all") query.set("filter", targetFilter);
    if ((next.page ?? 1) > 1) query.set("page", String(next.page));
    return `/admin/branches/${branchId}?${query.toString()}`;
  };
  return <section className="mt-6">
    <div className="flex flex-wrap items-center gap-3">
      <form className="min-w-64 flex-1" method="get">
        <input name="tab" type="hidden" value="stock" />
        {filter !== "all" ? <input name="filter" type="hidden" value={filter} /> : null}
        <input aria-label="Buscar producto" className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2" defaultValue={search} name="q" placeholder="Buscar producto, SKU…" />
      </form>
      <div className="flex flex-wrap gap-1">{FILTERS.map(([key, label]) => <Link className={`rounded-full px-3 py-1.5 text-sm font-bold ${filter === key ? "bg-stone-900 text-white" : "bg-white text-stone-600 hover:bg-stone-100"}`} href={href({ filter: key })} key={key}>{label}</Link>)}</div>
    </div>
    <p className="mt-3 text-sm text-stone-500">Sólo los productos habilitados en esta sucursal · {totalRows} resultado{totalRows === 1 ? "" : "s"}</p>
    <div className="mt-2 overflow-x-auto rounded-xl bg-white shadow-sm"><table className="w-full min-w-[800px] text-left text-sm"><thead className="border-b border-stone-100 bg-stone-50 text-stone-500"><tr><th className="p-3">Producto</th><th className="p-3">Actual</th><th className="p-3">Mínimo</th><th className="p-3">Objetivo</th><th className="p-3">Cobertura</th><th className="p-3">Reponer</th><th className="p-3">Estado</th></tr></thead><tbody>{rows.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.productId}><td className="p-3 font-bold">{row.productName}{row.sku ? <span className="ml-2 text-xs font-normal text-stone-500">{row.sku}</span> : null}</td><td className={`p-3 ${row.current <= 0 ? "font-bold text-red-700" : ""}`}>{row.current <= 0 ? "Sin stock" : formatStockQuantity(row.current, row.unitType)}{row.current < 0 ? <span className="block text-xs">Faltante {formatStockQuantity(Math.abs(row.current), row.unitType)}</span> : null}</td><td className="p-3">{row.configured ? formatStockQuantity(row.minimum, row.unitType) : "Sin configurar"}</td><td className="p-3">{row.configured ? formatStockQuantity(row.target, row.unitType) : "Sin configurar"}</td><td className="p-3">{row.current <= 0 ? "Sin stock" : row.daily > 0 ? `≈ ${(row.current / row.daily).toFixed(1)} días` : "Sin ventas recientes"}</td><td className="p-3 font-bold text-teal-700">{row.configured && row.target > 0 ? formatStockQuantity(row.suggested, row.unitType) : "Configurar objetivo"}</td><td className="p-3"><StatusBadge tone={row.rank === 0 ? "critical" : row.rank === 1 ? "warning" : row.rank === 2 ? "success" : "neutral"}>{row.label}</StatusBadge></td></tr>)}</tbody></table>{!rows.length ? <p className="p-6 text-center text-stone-500">No hay productos para estos filtros.</p> : null}</div>
    {totalPages > 1 ? <nav aria-label="Paginación" className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: page - 1 })}>← Anterior</Link> : <span />}
      <span className="text-stone-500">Página {page} de {totalPages}</span>
      {page < totalPages ? <Link className="font-bold text-rose-800 hover:underline" href={href({ page: page + 1 })}>Siguiente →</Link> : <span />}
    </nav> : null}
  </section>;
}
