"use client";

import { formatStockQuantity } from "@carnicerias/business-logic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { loadProductModalAction } from "../app/admin/actions";
import { coverageDays as coverageOf, formatCoverageDays, formatDailyAverage, formatRelativeTime } from "../lib/branch-insights";
import { formatLocalDateTime } from "../lib/date-range";
import { buildProductInsight, type ProductInsight, type ProductModalData } from "../lib/product-insight";
import { formatSignedQuantity, movementTypeLabel, stockAuditHref } from "../lib/stock-audit";
import { OverlayDialog } from "./overlay-dialog";
import { AuditSalesCheckCard } from "./stock-audit-panels";
import { StockPhysicalCount } from "./stock-physical-count";

const tile = "rounded-lg bg-white p-3 shadow-sm";
const tileLabel = "text-xs font-bold uppercase tracking-wide text-stone-500";

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string | undefined; tone?: string | undefined }) {
  return <div className={tile}><p className={tileLabel}>{label}</p><p className={`mt-1 text-lg font-black ${tone ?? "text-stone-900"}`}>{value}</p>{note ? <p className="text-xs text-stone-500">{note}</p> : null}</div>;
}

/**
 * Vista pura del modal (sin estado ni red): todo lo que hay que saber de UN producto en UNA sucursal. Reúne lo que ya
 * existe —auditoría del ledger desde el último ingreso, control ventas-vs-ledger, conteo físico con confirmación y
 * estado en las demás sucursales— sin recalcular nada.
 */
export function ProductInsightView({ data, insight, branchId, timeZone, now, isProduction, onApplied }: {
  data: ProductModalData;
  insight: ProductInsight;
  branchId: string;
  timeZone: string;
  now: Date;
  isProduction: boolean;
  onApplied?: (() => void) | undefined;
}) {
  const { audit } = data;
  const unit = audit.product.unitType;
  const rec = insight.reconciliation;
  const lastSale = formatRelativeTime(insight.lastSaleAt, now);
  const coverage = coverageOf(insight.stock, insight.sold7d);
  const row = (label: string, value: string, strong = false) => <div className={`flex justify-between gap-3 py-1 ${strong ? "border-t border-stone-200 font-black" : ""}`}><dt className={strong ? "" : "text-stone-600"}>{label}</dt><dd className="text-right font-bold">{value}</dd></div>;
  return <div className="mt-4 space-y-5">
    <section aria-label="Resumen del producto" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Tile label="Stock sistema" tone={insight.stock <= 0 ? "text-red-700" : "text-rose-800"} value={formatStockQuantity(insight.stock, unit)} />
      <Tile label="Vendido 7 días" note="Últimos 7 días" value={formatStockQuantity(insight.sold7d, unit)} />
      <Tile label="Promedio diario" note="Últimos 7 días" value={insight.sold7d > 0 ? formatDailyAverage(insight.sold7d, unit) : "—"} />
      <Tile label="Última venta" value={lastSale ?? "Sin ventas en 90 días"} />
      <Tile label="Último ingreso" note={insight.lastInbound ? movementTypeLabel(insight.lastInbound.type) : undefined} value={insight.lastInbound ? `${formatStockQuantity(insight.lastInbound.quantity, unit)} · ${formatLocalDateTime(insight.lastInbound.at, timeZone)}` : "Sin ingresos registrados"} />
      {isProduction ? null : <Tile label="Cobertura estimada" note="Con la venta de 7 días" tone={coverage !== null && coverage < 2 ? "text-amber-700" : undefined} value={coverage === null ? "Sin ventas últimos 7 días" : insight.stock <= 0 ? "Sin stock" : formatCoverageDays(coverage)} />}
    </section>

    {rec ? <section aria-label="Cómo se llegó a este stock" className={`rounded-lg p-4 shadow-sm ${rec.hasDiscrepancy ? "border border-red-200 bg-red-50" : "bg-white"}`}>
      <h3 className="text-base font-black">{insight.ledgerMode === "ALL_HISTORY" ? "Todo el historial del ledger" : "Desde el último ingreso"}</h3>
      <dl className="mt-2 text-sm" data-testid="product-reconciliation">
        {rec.before !== 0 ? row("Stock antes del ingreso", formatStockQuantity(rec.before, unit)) : null}
        {row("Ingresó", formatSignedQuantity(rec.entered, unit))}
        {row("Vendido (según tickets)", rec.soldByTickets === 0 ? formatStockQuantity(0, unit) : `-${formatStockQuantity(rec.soldByTickets, unit)}`)}
        {row("Mermas", rec.waste === 0 ? formatStockQuantity(0, unit) : `-${formatStockQuantity(rec.waste, unit)}`)}
        {row("Ajustes", rec.adjustments === 0 ? formatStockQuantity(0, unit) : formatSignedQuantity(rec.adjustments, unit))}
        {rec.otherOutflows !== 0 ? row("Otras salidas", `-${formatStockQuantity(rec.otherOutflows, unit)}`) : null}
        {row("Debería quedar", formatStockQuantity(rec.expected, unit), true)}
        {row("Stock ledger", formatStockQuantity(rec.ledger, unit))}
      </dl>
      {rec.hasDiscrepancy ? <p className="mt-3 text-sm font-bold text-red-800" role="alert">
        ⚠ {rec.difference !== 0 ? `Diferencia detectada: ${formatStockQuantity(Math.abs(rec.difference), unit)} ${rec.difference > 0 ? "de más en el sistema" : "de menos en el sistema"}.` : `Hay ${String(rec.mismatchedTickets)} ${rec.mismatchedTickets === 1 ? "ticket" : "tickets"} con diferencias.`}
        <span className="block font-normal">Sólo es un aviso: no se corrigió nada. Revisá abajo los tickets y, si hace falta, contá el stock físico.</span>
      </p> : <p className="mt-2 text-sm text-emerald-800">Las ventas coinciden con lo que descontó el ledger.</p>}
    </section> : null}

    {rec?.hasDiscrepancy ? <AuditSalesCheckCard summary={audit} timeZone={timeZone} /> : null}

    <StockPhysicalCount branchId={branchId} onApplied={onApplied} productId={audit.product.id} systemQuantity={audit.currentQuantity} unitType={unit} />

    {insight.others.length ? <section aria-label="Este producto en otras sucursales" className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="text-base font-black">Este producto en otras sucursales</h3>
      <p className="text-xs text-stone-500">Últimos 7 días</p>
      <ul className="mt-2 divide-y divide-stone-100 text-sm">{insight.others.map((other) => <li className="flex items-baseline justify-between gap-3 py-2" key={other.branchId}><span className="font-bold">{other.branchName}</span><span className="text-right"><strong>{formatStockQuantity(other.sold7d, other.unitType)}</strong> / 7d<span className="block text-xs text-stone-500">stock {formatStockQuantity(other.current, other.unitType)}{coverageOf(other.current, other.sold7d) === null ? "" : ` · ${formatCoverageDays(coverageOf(other.current, other.sold7d) ?? 0)}`}</span></span></li>)}</ul>
    </section> : null}

    <p className="text-sm"><Link className="font-bold text-rose-800 hover:underline" href={stockAuditHref({ branchId, productId: audit.product.id })}>Ver todos los movimientos de este producto →</Link></p>
  </div>;
}

/** Modal de producto del Resumen: carga los datos al abrir (el producto y la sucursal salen de la lista que se tocó). */
export function ProductInsightModal({ branchId, branchName, productId, productName, timeZone, isProduction, onClose }: {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  timeZone: string;
  isProduction: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<ProductModalData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await loadProductModalAction(branchId, productId);
      if (result.ok) setData(result.data); else setError(result.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cargar el producto");
    }
  }, [branchId, productId]);

  useEffect(() => { void load(); }, [load]);

  return <OverlayDialog onClose={onClose} subtitle="Qué pasa con este producto en esta sucursal" title={`${productName} — ${branchName}`}>
    {error ? <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error} <button className="font-bold underline" onClick={() => void load()} type="button">Reintentar</button></div> : null}
    {!data && !error ? <p className="mt-6 text-center text-stone-500" role="status">Cargando…</p> : null}
    {data ? <ProductInsightView branchId={branchId} data={data} insight={buildProductInsight(data, branchId)} isProduction={isProduction} now={new Date()} onApplied={() => { router.refresh(); void load(); }} timeZone={timeZone} /> : null}
  </OverlayDialog>;
}
