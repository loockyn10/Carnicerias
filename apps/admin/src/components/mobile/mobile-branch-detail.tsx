"use client";

import { formatBasisPointsPercent, formatCurrency, formatStockQuantity, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import type { BranchBoardData } from "../../lib/branch-board";
import { rangeQuery, type ResolvedSalesRange } from "../../lib/date-range";
import { OverlayDialog } from "../overlay-dialog";
import { MobilePeriod } from "./mobile-period";

/** Cuántos productos muestra cada bloque en el celular; el resto queda detrás de «Ver todos» (pantalla completa). */
const PREVIEW = 4;

interface Metrics { grossCents: number; kilograms: number; units: number; salesCount: number }
interface Profit { grossProfitCents: number; grossMarginBps: number | null; missingCostItems: number }

type ListKind = "sellers" | "attention" | "rotation";

function Block({ title, tag, rows, total, empty, onAll, footnote }: { title: string; tag: string; rows: ReactNode[]; total: number; empty: string; onAll?: () => void; footnote?: string | undefined }) {
  return <section aria-label={title} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
    <div className="flex items-baseline justify-between gap-2"><h3 className="text-lg font-black">{title}</h3><span className="text-xs font-bold text-stone-500">{tag}</span></div>
    {rows.length ? <ul className="mt-2 divide-y divide-stone-100">{rows}</ul> : <p className="mt-2 text-base text-stone-500">{empty}</p>}
    {onAll && total > PREVIEW ? <button className="mt-3 min-h-12 w-full rounded-xl border border-stone-300 text-base font-bold text-stone-700 active:bg-stone-100" onClick={onAll} type="button">Ver todos ({total})</button> : null}
    {footnote ? <p className="mt-2 text-sm text-stone-500">{footnote}</p> : null}
  </section>;
}

function Line({ title, detail, aside }: { title: string; detail?: string; aside: ReactNode }) {
  return <li className="flex items-start justify-between gap-3 py-3"><span className="min-w-0"><strong className="block text-base leading-snug">{title}</strong>{detail ? <span className="block text-sm text-stone-600">{detail}</span> : null}</span><span className="shrink-0 text-right text-base font-black">{aside}</span></li>;
}

/**
 * Detalle de una sucursal en el celular: de arriba hacia abajo, sin tablas. Mismas cifras que el Resumen del escritorio (`BranchPage`): ventas, ganancia
 * y margen del período, y los bloques de «Qué está pasando» (más vendido, qué llevar, alertas, baja rotación) con 4 productos cada uno; el resto, en
 * una pantalla completa. «Ver qué llevar» es el botón principal y abre la carga de ESTA sucursal (la misma fórmula: `get_branch_carry_plan`).
 */
export function MobileBranchDetail({ branchId, branchName, active, isProduction, metrics, profit, range, board, boardUnavailable }: {
  branchId: string;
  branchName: string;
  active: boolean;
  isProduction: boolean;
  metrics: Metrics;
  profit: Profit | null;
  range: ResolvedSalesRange;
  board: BranchBoardData | null;
  boardUnavailable: string | null;
}) {
  const [list, setList] = useState<ListKind | null>(null);
  const row = (label: string, value: string, strong = false) => <div className="flex items-baseline justify-between gap-3"><dt className="text-base text-stone-600">{label}</dt><dd className={`font-black text-stone-900 ${strong ? "text-2xl" : "text-lg"}`}>{value}</dd></div>;

  const sellerRows = (limit: number) => (board?.topSellers ?? []).slice(0, limit).map((seller) => <Line aside={formatStockQuantity(seller.quantity, seller.unitType)} detail={formatCurrency(BigInt(seller.revenueCents))} key={seller.productId} title={seller.productName} />);
  const carry = board?.carry ?? null;
  const carryRows = (limit: number) => carry && !("error" in carry) ? carry.preview.slice(0, limit).map((item) => <Line aside={<span className="text-teal-700">{formatStockQuantity(item.suggestedQuantity, item.unitType)}</span>} detail={`Hoy hay ${item.currentQuantity <= 0 ? "0" : formatStockQuantity(item.currentQuantity, item.unitType)}`} key={item.productId} title={item.productName} />) : [];
  const attentionRows = (limit: number) => (board?.attention.all ?? []).slice(0, limit).map((item) => <Line aside={<span className={`rounded-full px-2 py-1 text-xs ${item.severity === "critical" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>{item.headline}</span>} detail={item.detail} key={item.productId} title={item.productName} />);
  const rotationRows = (limit: number) => (board?.lowRotation?.all ?? []).slice(0, limit).map((item) => <Line aside={formatStockQuantity(item.current, item.unitType)} detail={item.lastSaleText} key={item.productId} title={item.productName} />);

  const sheet: Record<ListKind, { title: string; rows: ReactNode[] }> = {
    sellers: { title: "Qué más se vende", rows: sellerRows(Number.MAX_SAFE_INTEGER) },
    attention: { title: "Alertas", rows: attentionRows(Number.MAX_SAFE_INTEGER) },
    rotation: { title: "Baja rotación", rows: rotationRows(Number.MAX_SAFE_INTEGER) }
  };

  return <div className="mobile-screen mx-auto w-full max-w-md px-4 pb-6 pt-4 lg:hidden" data-testid="mobile-branch-detail">
    <h2 className="text-center text-2xl font-black uppercase tracking-wide">{branchName}</h2>
    {!active ? <p className="mt-1 text-center text-sm font-bold text-stone-500">Sucursal inactiva</p> : null}
    <MobilePeriod basePath={`/admin/branches/${branchId}`} error={range.error} range={range} />

    <section aria-label="Resumen" className="mt-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <dl className="grid gap-2">
        {row("Ventas", formatCurrency(BigInt(metrics.grossCents)), true)}
        {row("Ganancia", profit ? formatCurrency(BigInt(profit.grossProfitCents)) : "—")}
        {row("Margen", profit?.grossMarginBps == null ? "—" : `${formatBasisPointsPercent(profit.grossMarginBps)} %`)}
        {row("Kg vendidos", formatWeight(Math.round(metrics.kilograms * 1000)))}
        {metrics.units > 0 ? row("Unidades vendidas", new Intl.NumberFormat("es-AR").format(metrics.units)) : null}
        {row("Tickets", String(metrics.salesCount))}
      </dl>
      {profit && profit.missingCostItems > 0 ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">⚠ Hay productos vendidos sin costo cargado: la ganancia puede estar incompleta.</p> : null}
    </section>

    {isProduction
      ? <p className="mt-4 rounded-2xl bg-white p-4 text-base text-stone-600 shadow-sm">Esta es la sucursal productiva: de acá sale la mercadería que se lleva a las demás.</p>
      : <Link className="mt-4 grid min-h-14 place-items-center rounded-2xl bg-emerald-700 px-4 text-lg font-black text-white active:bg-emerald-800" href={`/admin/branches?view=carry&branch=${branchId}&${rangeQuery(range)}`} prefetch={false}>🚚 Ver qué llevar</Link>}

    {board ? <div className="mt-4 grid gap-4">
      <Block empty="Sin ventas en este período." onAll={() => { setList("sellers"); }} rows={sellerRows(PREVIEW)} tag={board.periodTag} title="Qué más se vende" total={board.topSellers.length} />
      {carry === null ? null : "error" in carry
        ? <section className="rounded-2xl bg-white p-4 text-base text-stone-600 shadow-sm"><h3 className="text-lg font-black">Qué llevar</h3><p className="mt-2">{carry.error}</p></section>
        : <Block empty="No hace falta llevar nada: lo vendido en 7 días está cubierto." footnote={carry.needing > PREVIEW ? `Y ${String(carry.needing - PREVIEW)} productos más: tocá «Ver qué llevar».` : undefined} rows={carryRows(PREVIEW)} tag="Últimos 7 días" title="Qué llevar" total={carry.needing} />}
      <Block empty="Sin alertas por ahora." onAll={() => { setList("attention"); }} rows={attentionRows(PREVIEW)} tag="Revisar" title="Alertas" total={board.attention.all.length} />
      {board.lowRotation ? <Block empty="Nada con baja rotación." onAll={() => { setList("rotation"); }} rows={rotationRows(PREVIEW)} tag="Últimos 14 días" title="Baja rotación" total={board.lowRotation.all.length} /> : null}
    </div> : <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-base text-amber-900" role="status">No se pudo calcular el detalle{boardUnavailable ? `: ${boardUnavailable}` : "."} Las cifras de arriba siguen siendo válidas.</p>}

    {list ? <OverlayDialog onClose={() => { setList(null); }} subtitle={branchName} tall title={sheet[list].title}><ul className="mobile-screen divide-y divide-stone-200 pb-6">{sheet[list].rows}</ul></OverlayDialog> : null}
  </div>;
}
