import { formatBasisPointsPercent, formatCurrency, formatWeight } from "@carnicerias/business-logic";

import type { BranchBoardData } from "../lib/branch-board";
import { BranchOperationsBoard } from "./branch-operations-board";
import { MissingCostsNotice } from "./missing-costs-notice";
import { OperatingResultCard } from "./operating-result-card";
import type { OperatingResult } from "../lib/operating-costs";

/** Rentabilidad comercial del período (antes de gastos). `null` = el usuario no puede verla o no se pudo calcular. */
export interface BranchProfitability { grossProfitCents: number; grossMarginBps: number | null; missingCostItems: number; missingCostSales: number; missingCostRevenueCents: number }

export function BranchSummary({ branchId, branchName, timeZone, isProduction, metrics, change, periodLabel, comparisonLabel, range, board, boardUnavailable, stockCounts, profit, operating }: { branchId: string; branchName: string; timeZone: string; isProduction: boolean; metrics: { grossCents: number; kilograms: number; units: number; salesCount: number; averageTicketCents: number }; change: number | null; periodLabel: string; comparisonLabel: string; range: { from: string; to: string }; board: BranchBoardData | null; boardUnavailable?: string | null; stockCounts: { out: number; low: number; normal: number }; profit: BranchProfitability | null; operating: OperatingResult | null }) {
  const metric = (label: string, value: string, detail?: string, note?: string) => <article className="rounded-xl bg-white px-4 py-3 shadow-sm"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p><p className="mt-1 text-2xl font-black text-stone-900">{value}</p>{detail ? <p className={`mt-1 text-sm font-bold ${change !== null && change < 0 ? "text-red-700" : "text-emerald-700"}`}>{detail}</p> : null}{note ? <p className="mt-1 text-xs text-stone-500">{note}</p> : null}</article>;
  return <>
    <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{metric(`Ventas ${periodLabel}`, formatCurrency(BigInt(metrics.grossCents)), change === null ? undefined : `${change < 0 ? "↓" : "↑"} ${Math.abs(change).toFixed(1)}% vs ${comparisonLabel}`)}{metric("Kg vendidos", formatWeight(Math.round(metrics.kilograms * 1000)))}{metric("Tickets", String(metrics.salesCount))}{metric("Ticket promedio", formatCurrency(BigInt(metrics.averageTicketCents)))}</section>
    {metrics.units > 0 || profit ? <section className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{metrics.units > 0 ? metric("Unidades vendidas", new Intl.NumberFormat("es-AR").format(metrics.units)) : null}{profit ? <>{metric("Ganancia bruta", formatCurrency(BigInt(profit.grossProfitCents)), undefined, "Antes de gastos operativos")}{metric("Margen bruto", profit.grossMarginBps === null ? "—" : `${formatBasisPointsPercent(profit.grossMarginBps)} %`, undefined, "Sobre ventas con costo conocido")}{operating ? <OperatingResultCard branchId={branchId} branchName={branchName} from={range.from} result={operating} to={range.to} /> : null}<MissingCostsNotice branchId={branchId} branchName={branchName} from={range.from} missingItems={profit.missingCostItems} missingRevenueCents={profit.missingCostRevenueCents} timeZone={timeZone} to={range.to} /></> : null}</section> : null}
    <BranchOperationsBoard board={board} branchId={branchId} branchName={branchName} isProduction={isProduction} stockCounts={stockCounts} timeZone={timeZone} unavailable={boardUnavailable ?? null} />
  </>;
}
