import { formatCurrency, formatStockQuantity } from "@carnicerias/business-logic";
import Link from "next/link";

import { StatusBadge } from "./admin-ui";
import { auditPeriodDateRange, describeMovementReference, formatSignedQuantity, groupAuditMovements, movementTypeLabel, quickSummary, salesCheckHasDiscrepancy, type AuditMovementsPage, type StockAuditSummary } from "../lib/stock-audit";
import { formatIsoDate, formatLocalDateTime } from "../lib/date-range";

const card = "mt-6 rounded-xl bg-white p-4 shadow-sm";
const SALE_STATUS_LABELS: Record<string, string> = { COMPLETED: "Completada", CANCELLED: "Anulada", PENDING_PAYMENT: "Pago pendiente" };

function periodDescription(summary: StockAuditSummary, timeZone: string): string {
  if (summary.mode === "ALL_HISTORY") return "Este producto no tiene ingresos registrados en la sucursal: se muestra todo el historial del ledger.";
  if (summary.mode === "SINCE_LAST_INBOUND" && summary.anchor) {
    return `Desde el último ingreso: ${formatLocalDateTime(summary.anchor.occurredAt, timeZone)} · ${movementTypeLabel(summary.anchor.type)} ${formatSignedQuantity(summary.anchor.quantity, summary.product.unitType)} (hasta ahora).`;
  }
  const range = auditPeriodDateRange(summary, timeZone);
  return `Del ${formatIsoDate(range.from)} al ${formatIsoDate(range.to)}, días completos en la zona horaria de la organización.`;
}

/** Cómo se llegó al stock teórico: stock inicial + movimientos agrupados por tipo = stock del período; + lo posterior = stock actual. */
export function AuditSummaryCard({ summary, timeZone }: { summary: StockAuditSummary; timeZone: string }) {
  const unit = summary.product.unitType;
  const quick = quickSummary(summary.byType);
  const groups = groupAuditMovements(summary.byType);
  const tone = (quantity: number) => (quantity > 0 ? "text-emerald-700" : quantity < 0 ? "text-red-700" : "text-stone-500");
  const openingLabel = summary.mode === "SINCE_LAST_INBOUND" ? "Stock antes del ingreso" : summary.mode === "ALL_HISTORY" ? "Stock inicial" : "Stock al inicio del período";
  return <section aria-labelledby="audit-summary-title" className={card}>
    <h2 className="text-lg font-black" id="audit-summary-title">Cómo se llegó a este stock</h2>
    <p className="mt-1 text-sm text-stone-600" data-testid="audit-period">{periodDescription(summary, timeZone)}</p>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="audit-quick-summary">
      {[
        { label: "Entró", value: formatStockQuantity(quick.entered, unit) },
        { label: "Vendido (neto de anulaciones)", value: formatStockQuantity(quick.sold, unit) },
        { label: "Merma", value: formatStockQuantity(quick.waste, unit) },
        { label: "Ajustes", value: formatSignedQuantity(quick.adjustments, unit) },
        { label: "Otras salidas", value: formatStockQuantity(quick.otherOutflows, unit) },
        { label: "Resultado del período", value: formatStockQuantity(summary.closingQuantity, unit) }
      ].map((item) => <div className="rounded-lg bg-stone-50 p-3" key={item.label}><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">{item.label}</dt><dd className="mt-1 text-lg font-black">{item.value}</dd></div>)}
    </dl>
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm" data-testid="audit-formula">
      <tbody>
        <tr className="border-b border-stone-100"><td className="p-2 font-bold">{openingLabel}</td><td className="p-2" /><td className="p-2 text-right font-bold">{formatStockQuantity(summary.openingQuantity, unit)}</td></tr>
        {groups.map((group) => <tr className="border-b border-stone-100" key={group.key}>
          <td className="p-2"><span className="mr-2 inline-block w-4 text-center font-black text-stone-500">{group.sign}</span>{group.label}</td>
          <td className="p-2 text-xs text-stone-500">{group.count} mov.</td>
          <td className={`p-2 text-right font-bold ${tone(group.quantity)}`}>{formatSignedQuantity(group.quantity, unit)}</td>
        </tr>)}
        <tr className="border-b border-stone-200 bg-stone-50"><td className="p-2 font-black">= Stock al cierre del período</td><td className="p-2 text-xs text-stone-500">{summary.movementCount} movimientos</td><td className="p-2 text-right font-black">{formatStockQuantity(summary.closingQuantity, unit)}</td></tr>
        {summary.afterPeriodQuantity !== 0 ? <tr className="border-b border-stone-100"><td className="p-2"><span className="mr-2 inline-block w-4 text-center font-black text-stone-500">±</span>Movimientos posteriores al período</td><td className="p-2" /><td className={`p-2 text-right font-bold ${tone(summary.afterPeriodQuantity)}`}>{formatSignedQuantity(summary.afterPeriodQuantity, unit)}</td></tr> : null}
        <tr className="bg-rose-50"><td className="p-2 font-black text-rose-900">= Stock teórico actual</td><td className="p-2" /><td className="p-2 text-right text-lg font-black text-rose-900" data-testid="audit-current">{formatStockQuantity(summary.currentQuantity, unit)}</td></tr>
      </tbody>
    </table></div>
    <p className="mt-2 text-xs text-stone-500">Fuente: el ledger de movimientos de stock (única fuente de verdad). Una venta anulada aparece como Venta (−) y Devolución (+); una venta con pago pendiente ya descontó su stock.</p>
  </section>;
}

/** Control ventas COMPLETED vs. movimientos del ledger. Sólo informa; no corrige nada. */
export function AuditSalesCheckCard({ summary, timeZone }: { summary: StockAuditSummary; timeZone: string }) {
  const check = summary.sales;
  if (!check) return null;
  const unit = summary.product.unitType;
  const problem = salesCheckHasDiscrepancy(check);
  return <section aria-labelledby="audit-sales-title" className={card} data-testid="audit-sales-check">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-black" id="audit-sales-title">Control: ventas vs. movimientos de stock</h2>
      <StatusBadge tone={problem ? "critical" : "success"}>{problem ? "Hay diferencias" : "Coincide"}</StatusBadge>
    </div>
    <dl className="mt-3 grid gap-3 sm:grid-cols-4">
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Ventas completadas</dt><dd className="mt-1 text-lg font-black">{formatStockQuantity(check.completedQuantity, unit)}</dd><dd className="text-xs text-stone-500">{check.completedTickets} ticket{check.completedTickets === 1 ? "" : "s"} · {formatCurrency(BigInt(check.completedRevenueCents))}</dd></div>
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Descontado en el ledger</dt><dd className="mt-1 text-lg font-black">{formatStockQuantity(check.ledgerQuantityForCompleted, unit)}</dd><dd className="text-xs text-stone-500">por esas mismas ventas</dd></div>
      <div className={`rounded-lg p-3 ${check.difference === 0 ? "bg-emerald-50" : "bg-red-50"}`}><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Diferencia</dt><dd className={`mt-1 text-lg font-black ${check.difference === 0 ? "text-emerald-700" : "text-red-700"}`}>{check.difference === 0 ? "0" : formatSignedQuantity(check.difference, unit)}</dd></div>
      <div className="rounded-lg bg-stone-50 p-3"><dt className="text-xs font-bold uppercase tracking-wide text-stone-500">Pago pendiente</dt><dd className="mt-1 text-lg font-black">{formatStockQuantity(check.pendingPaymentQuantity, unit)}</dd><dd className="text-xs text-stone-500">{check.pendingPaymentTickets} ticket{check.pendingPaymentTickets === 1 ? "" : "s"} · ya descontado del stock</dd></div>
    </dl>
    {problem ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
      <p className="font-bold">Las ventas y los movimientos de stock no coinciden.</p>
      <p className="mt-1">Las ventas completadas dicen {formatStockQuantity(check.completedQuantity, unit)} y el ledger descontó {formatStockQuantity(check.ledgerQuantityForCompleted, unit)} por ellas. Esto es sólo un aviso: no se corrigió nada. Revisá los tickets de abajo antes de ajustar el stock.</p>
      {check.orphanSaleMovements.count > 0 ? <p className="mt-1">Además hay {check.orphanSaleMovements.count} movimiento{check.orphanSaleMovements.count === 1 ? "" : "s"} de venta ({formatStockQuantity(check.orphanSaleMovements.quantity, unit)}) cuya venta no tiene este producto.</p> : null}
    </div> : <p className="mt-3 text-sm text-emerald-800">Las ventas completadas del período descontaron exactamente lo vendido.</p>}
    {check.mismatches.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm">
      <thead className="border-b border-stone-100 text-stone-500"><tr><th className="p-2">Ticket</th><th className="p-2">Fecha</th><th className="p-2">Estado</th><th className="p-2 text-right">Debió descontar</th><th className="p-2 text-right">El ledger descontó</th></tr></thead>
      <tbody>{check.mismatches.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.saleId}>
        <td className="p-2 font-mono text-xs">{row.saleId.slice(0, 8)}</td>
        <td className="p-2">{formatLocalDateTime(row.completedAt, timeZone)}</td>
        <td className="p-2">{SALE_STATUS_LABELS[row.status] ?? row.status}</td>
        <td className="p-2 text-right">{formatStockQuantity(row.expectedQuantity, unit)}</td>
        <td className="p-2 text-right font-bold text-red-700">{formatStockQuantity(row.ledgerQuantity, unit)}</td>
      </tr>)}</tbody>
    </table>{check.mismatchedSales > check.mismatches.length ? <p className="mt-1 text-xs text-stone-500">Se muestran los {check.mismatches.length} tickets con mayor diferencia de {check.mismatchedSales}.</p> : null}</div> : null}
  </section>;
}

/** Detalle cronológico paginado (la paginación y el saldo corrido los resuelve el servidor). */
export function AuditMovementsTable({ page, summary, timeZone, hrefFor }: {
  page: AuditMovementsPage;
  summary: StockAuditSummary;
  timeZone: string;
  /** Link a una página del detalle (número de página y orden). */
  hrefFor: (target: { page: number; newestFirst: boolean }) => string;
}) {
  const unit = summary.product.unitType;
  const pageNumber = Math.floor(page.offset / page.limit) + 1;
  const pageCount = Math.max(1, Math.ceil(page.total / page.limit));
  const start = page.total ? page.offset + 1 : 0;
  const end = Math.min(page.offset + page.limit, page.total);
  return <section aria-labelledby="audit-detail-title" className={card}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-black" id="audit-detail-title">Detalle de movimientos</h2>
      <Link className="text-sm font-bold text-rose-800 hover:underline" href={hrefFor({ page: 1, newestFirst: !page.newestFirst })}>{page.newestFirst ? "Más antiguos primero" : "Más recientes primero"}</Link>
    </div>
    <p className="mt-1 text-sm text-stone-500">{start}–{end} de {page.total} movimientos · el saldo es el stock teórico justo después de cada movimiento.</p>
    <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm" data-testid="audit-movements">
      <thead className="border-b border-stone-100 bg-stone-50 text-stone-500"><tr><th className="p-2">Fecha / hora</th><th className="p-2">Tipo</th><th className="p-2 text-right">Cantidad</th><th className="p-2 text-right">Stock resultante</th><th className="p-2">Origen / referencia</th><th className="p-2">Operador</th></tr></thead>
      <tbody>{page.rows.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.id}>
        <td className="whitespace-nowrap p-2">{formatLocalDateTime(row.occurredAt, timeZone)}</td>
        <td className="p-2 font-medium">{movementTypeLabel(row.type)}</td>
        <td className={`whitespace-nowrap p-2 text-right font-bold ${row.quantity > 0 ? "text-emerald-700" : "text-red-700"}`}>{formatSignedQuantity(row.quantity, unit)}</td>
        <td className="whitespace-nowrap p-2 text-right">{formatStockQuantity(row.balanceAfter, unit)}</td>
        <td className="p-2 text-stone-600">{describeMovementReference(row)}</td>
        <td className="p-2 text-stone-600">{row.operatorName ?? "—"}</td>
      </tr>)}</tbody>
    </table>{!page.rows.length ? <p className="p-6 text-center text-stone-500">No hay movimientos en este período.</p> : null}</div>
    {pageCount > 1 ? <nav aria-label="Paginación del detalle" className="mt-3 flex items-center justify-between text-sm">
      <span className="text-stone-500">Página {pageNumber} de {pageCount}</span>
      <span className="flex gap-2">
        {pageNumber > 1 ? <Link className="rounded-lg border px-3 py-2 font-bold text-stone-700" href={hrefFor({ page: pageNumber - 1, newestFirst: page.newestFirst })}>Anterior</Link> : null}
        {pageNumber < pageCount ? <Link className="rounded-lg border px-3 py-2 font-bold text-stone-700" href={hrefFor({ page: pageNumber + 1, newestFirst: page.newestFirst })}>Siguiente</Link> : null}
      </span>
    </nav> : null}
  </section>;
}
