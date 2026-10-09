import { formatCurrency, formatStockQuantity, type StockUnit } from "@carnicerias/business-logic";
import Link from "next/link";

import { formatIsoDate } from "../lib/date-range";
import { stockAuditHref } from "../lib/stock-audit";

export interface ProductSalesRow {
  branchId: string;
  branchName: string;
  quantity: number;
  revenueCents: number;
  tickets: number;
}

/**
 * Métricas de UN producto en el rango elegido, sólo con ventas COMPLETED (cantidad en kg o unidades según el producto,
 * importe y tickets). Los números llegan agregados del servidor (`get_product_sales_summary`); acá sólo se muestran.
 * «Ver stock y movimientos» conserva sucursal, producto y el mismo rango de fechas.
 */
export function ProductSalesSummary({ product, rows, range, singleBranch }: {
  product: { id: string; name: string; unitType: StockUnit; active: boolean };
  rows: ProductSalesRow[];
  range: { from: string; to: string };
  /** true cuando se filtró una sucursal: se muestran las tres métricas grandes; si no, una fila por sucursal. */
  singleBranch: boolean;
}) {
  const total = rows.reduce((sum, row) => ({ quantity: sum.quantity + row.quantity, revenueCents: sum.revenueCents + row.revenueCents, tickets: sum.tickets + row.tickets }), { quantity: 0, revenueCents: 0, tickets: 0 });
  const auditHref = (branchId: string) => stockAuditHref({ branchId, productId: product.id, period: { mode: "range", from: range.from, to: range.to } });
  const period = range.from === range.to ? formatIsoDate(range.from) : `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
  const only = singleBranch ? rows[0] : undefined;
  return <section aria-labelledby="product-sales-title" className="mt-6 rounded-xl border border-rose-200 bg-white p-4 shadow-sm" data-testid="product-sales-summary">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-black" id="product-sales-title">{product.name}{product.active ? null : <span className="ml-2 text-sm font-bold text-amber-700">inactivo</span>}</h2>
        <p className="text-sm text-stone-500">{only ? `${only.branchName} · ` : "Todas las sucursales · "}{period} · sólo ventas completadas</p>
      </div>
      {only ? <Link className="rounded-lg border border-rose-800 px-3 py-2 text-sm font-bold text-rose-800 hover:bg-rose-50" href={auditHref(only.branchId)}>Ver stock y movimientos</Link> : null}
    </div>
    {only ? <dl className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Vendido</dt><dd className="mt-1 text-2xl font-black">{formatStockQuantity(only.quantity, product.unitType)}</dd></div>
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Importe</dt><dd className="mt-1 text-2xl font-black text-rose-800">{formatCurrency(BigInt(only.revenueCents))}</dd></div>
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Tickets</dt><dd className="mt-1 text-2xl font-black">{only.tickets}</dd></div>
    </dl> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm">
      <thead className="border-b border-stone-100 text-stone-500"><tr><th className="p-2">Sucursal</th><th className="p-2 text-right">Vendido</th><th className="p-2 text-right">Importe</th><th className="p-2 text-right">Tickets</th><th className="p-2" /></tr></thead>
      <tbody>
        {rows.map((row) => <tr className="border-b border-stone-100" key={row.branchId}>
          <td className="p-2 font-bold">{row.branchName}</td>
          <td className="p-2 text-right">{formatStockQuantity(row.quantity, product.unitType)}</td>
          <td className="p-2 text-right">{formatCurrency(BigInt(row.revenueCents))}</td>
          <td className="p-2 text-right">{row.tickets}</td>
          <td className="p-2 text-right"><Link className="font-bold text-rose-800 hover:underline" href={auditHref(row.branchId)}>Ver stock y movimientos</Link></td>
        </tr>)}
        <tr className="bg-stone-50 font-black"><td className="p-2">Total</td><td className="p-2 text-right">{formatStockQuantity(total.quantity, product.unitType)}</td><td className="p-2 text-right">{formatCurrency(BigInt(total.revenueCents))}</td><td className="p-2 text-right">{total.tickets}</td><td className="p-2" /></tr>
      </tbody>
    </table></div>}
  </section>;
}
