import { formatCurrency, formatWeight } from "@carnicerias/business-logic";
import Link from "next/link";

import { SettlementConfirmationForm } from "../../../components/settlement-confirmation-form";
import { VoidSettlementForm } from "../../../components/void-settlement-form";
import { requireAdminContext } from "../../../lib/admin";
import { createPerfLogger } from "../../../lib/perf";
import {
  organizationLocalDate,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  toOrganizationLocalInput,
  type SettlementHistoryItem,
  type SettlementOverview,
  type SettlementPreview
} from "../../../lib/settlements";
import { createClient } from "../../../lib/supabase/server";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";
const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function dateTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("es-AR", { timeZone, dateStyle: "short", timeStyle: "short" });
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function differenceTone(value: number) {
  return value === 0 ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900";
}

export default async function SettlementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/settlements");
  const contextStartedAt = performance.now();
  const context = await requireAdminContext();
  perf.mark("adminContext", contextStartedAt);
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const detailId = value("settlement");
  const historyBranch = value("historyBranch");
  const historyFrom = datePattern.test(value("from")) ? value("from") : "";
  const historyTo = datePattern.test(value("to")) ? value("to") : "";
  const differenceFilter = value("difference") === "yes" ? true : null;
  const supabase = await createClient();
  const [overviewResult, historyResult] = await Promise.all([
    perf.measure("overview", supabase.rpc("get_settlement_overview")),
    perf.measure("history", supabase.rpc("get_settlement_history", {
      p_branch_id: detailId ? null : historyBranch || null,
      p_from: detailId ? null : historyFrom || null,
      p_to: detailId ? null : historyTo || null,
      p_has_difference: detailId ? null : differenceFilter,
      p_settlement_id: detailId || null
    }))
  ]);
  const overview = jsonArray<SettlementOverview>(overviewResult.data);
  const history = jsonArray<SettlementHistoryItem>(historyResult.data);
  const selectedHistory = detailId ? history.find((item) => item.id === detailId) ?? null : null;
  const selectedBranchId = value("branch");
  const selectedOverview = overview.find((item) => item.branchId === selectedBranchId);
  const defaultStart = selectedOverview ? toOrganizationLocalInput(selectedOverview.periodStart, context.timezone) : "";
  const defaultEnd = selectedOverview ? toOrganizationLocalInput(selectedOverview.periodEnd, context.timezone) : "";
  const periodStart = localDateTimePattern.test(value("start")) ? value("start") : defaultStart;
  const periodEnd = localDateTimePattern.test(value("end")) ? value("end") : defaultEnd;
  const previewResult = selectedOverview && periodStart && periodEnd
    ? await perf.measure("preview", supabase.rpc("get_settlement_preview", {
      p_branch_id: selectedOverview.branchId,
      p_period_start_local: periodStart,
      p_period_end_local: periodEnd
    }))
    : { data: null, error: null };
  const preview = previewResult.data as unknown as SettlementPreview | null;
  const error = overviewResult.error ?? historyResult.error ?? previewResult.error;
  perf.flush();

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Control de caja</p><h1 className="mt-1 text-3xl font-black">Rendiciones</h1><p className="mt-2 text-stone-600">Cierres explícitos por sucursal con snapshot histórico.</p>
    {error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-800">No se pudieron cargar las rendiciones: {error.message}</p> : null}
    {detailId && !selectedHistory && !error ? <p className="mt-5 rounded-xl bg-amber-50 p-4 text-amber-900">La rendición solicitada no existe o no pertenece a tu organización. <Link className="font-bold underline" href="/admin/settlements">Volver al historial</Link></p> : null}

    {!detailId ? <section className="mt-6"><div className="flex items-end justify-between gap-3"><div><h2 className="text-xl font-black">Pendiente desde la última rendición</h2><p className="text-sm text-stone-500">La primera propone siete días; las siguientes comienzan exactamente donde terminó la anterior.</p></div><a className="text-sm font-bold text-rose-800 hover:underline" href="#history">Ver historial ↓</a></div><div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{overview.map((item) => <article className="rounded-2xl border bg-white p-5 shadow-sm" key={item.branchId}><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black">Sucursal {item.branchName}</h3><p className="text-sm text-stone-500">Última rendición: {item.lastSettlementAt ? dateTime(item.lastSettlementAt, context.timezone) : "Sin rendiciones"}</p></div></div><dl className="mt-5 grid grid-cols-2 gap-3"><div><dt className="text-sm text-stone-500">Ventas registradas</dt><dd className="font-black">{formatCurrency(BigInt(item.totalSalesCents))}</dd></div><div><dt className="text-sm text-stone-500">Efectivo esperado</dt><dd className="font-black text-rose-900">{formatCurrency(BigInt(item.expectedCashCents))}</dd></div></dl><Link className="mt-5 block rounded-lg bg-rose-800 px-4 py-2 text-center font-bold text-white hover:bg-rose-700" href={`/admin/settlements?branch=${item.branchId}`}>Hacer rendición</Link></article>)}{!overview.length && !error ? <p className="rounded-2xl border bg-white p-8 text-stone-500">No hay sucursales activas.</p> : null}</div></section> : null}

    {selectedOverview && preview ? <section className="mt-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/settlements">← Volver a rendiciones</Link><h2 className="mt-2 text-2xl font-black">Rendición — {preview.branchName}</h2></div></div><form className="mt-4 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm sm:grid-cols-[1fr_1fr_auto]"><input name="branch" type="hidden" value={preview.branchId} /><label className="grid gap-1 text-sm font-bold">Desde<input className={input} defaultValue={periodStart} name="start" required type="datetime-local" /></label><label className="grid gap-1 text-sm font-bold">Hasta<input className={input} defaultValue={periodEnd} name="end" required type="datetime-local" /></label><button className="self-end rounded-lg border px-4 py-2 font-bold">Actualizar período</button></form><div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]"><div className="space-y-5"><section className="rounded-2xl border bg-white p-5 shadow-sm"><h3 className="font-black">Ventas registradas</h3><div className="mt-4 divide-y">{PAYMENT_METHODS.map((method) => <div className="flex justify-between py-2" key={method}><span>{PAYMENT_LABELS[method]}</span><strong>{formatCurrency(BigInt(preview.paymentTotals[method] ?? 0))}</strong></div>)}<div className="flex justify-between border-t-2 py-3 text-lg"><strong>Total</strong><strong>{formatCurrency(BigInt(preview.totalSalesCents))}</strong></div></div><div className="mt-3 flex flex-wrap gap-4 text-sm text-stone-600"><span>{preview.ticketCount} tickets</span><span>{formatWeight(preview.soldWeightGrams)} vendidos</span></div></section><section className="rounded-2xl border bg-white p-5 shadow-sm"><h3 className="font-black">Ventas por empleado</h3><div className="mt-3 divide-y">{preview.employeeTotals.map((employee) => <div className="flex justify-between gap-3 py-3" key={employee.profileId}><div><strong>{employee.displayName}</strong><p className="text-sm text-stone-500">{employee.ticketCount} tickets</p></div><strong>{formatCurrency(BigInt(employee.salesCents))}</strong></div>)}{!preview.employeeTotals.length ? <p className="py-4 text-stone-500">Sin ventas en el período.</p> : null}</div></section></div><div className="space-y-5"><SettlementConfirmationForm branchId={preview.branchId} branchName={preview.branchName} expectedCashCents={preview.paymentTotals.CASH ?? 0} periodEnd={periodEnd} periodStart={periodStart} /><section className="rounded-2xl border bg-white p-5 shadow-sm"><h3 className="font-black">Estado de sincronización</h3><p className="mt-1 text-sm text-stone-500">El servidor no puede conocer ventas que siguen únicamente en un POS offline.</p><div className="mt-3 space-y-2">{preview.devices.map((device) => { const stale = Date.now() - new Date(device.lastSeenAt).getTime() > 6 * 60 * 60 * 1_000; return <div className={`rounded-lg p-3 text-sm ${stale ? "bg-amber-50 text-amber-900" : "bg-stone-50"}`} key={device.deviceId}><strong>{stale ? "⚠ " : ""}{device.label}</strong><p>Última sincronización conocida: {dateTime(device.lastSeenAt, context.timezone)}</p>{stale ? <p className="mt-1">Puede haber ventas pendientes que todavía no aparecen.</p> : null}</div>; })}{!preview.devices.length ? <p className="text-sm text-stone-500">No hay dispositivos activos registrados.</p> : null}</div></section></div></div></section> : null}

    {selectedHistory ? <section className="mt-6"><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/settlements#history">← Volver al historial</Link><article className="mt-4 rounded-2xl border bg-white p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wide text-rose-800">Rendición histórica</p><h2 className="mt-1 text-2xl font-black">{selectedHistory.branchName}</h2><p className="text-sm text-stone-500">{dateTime(selectedHistory.periodStart, context.timezone)} → {dateTime(selectedHistory.periodEnd, context.timezone)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-black ${selectedHistory.status === "VOIDED" ? "bg-stone-200 text-stone-700" : differenceTone(selectedHistory.differenceCents)}`}>{selectedHistory.status === "VOIDED" ? "ANULADA" : selectedHistory.differenceCents === 0 ? "SIN DIFERENCIA" : "CON DIFERENCIA"}</span></div>{selectedHistory.hasLaterMovements ? <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">⚠ Hay movimientos posteriores correspondientes a este período. El snapshot confirmado no fue modificado.</p> : null}<div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-stone-950 p-4 text-white"><p className="text-sm text-stone-300">Efectivo esperado</p><strong className="text-2xl">{formatCurrency(BigInt(selectedHistory.expectedCashCents))}</strong></div><div className="rounded-xl bg-stone-100 p-4"><p className="text-sm text-stone-500">Efectivo recibido</p><strong className="text-2xl">{formatCurrency(BigInt(selectedHistory.receivedCashCents))}</strong></div><div className={`rounded-xl p-4 ${differenceTone(selectedHistory.differenceCents)}`}><p className="text-sm">Diferencia</p><strong className="text-2xl">{formatCurrency(BigInt(selectedHistory.differenceCents))}</strong></div></div><div className="mt-6 grid gap-6 lg:grid-cols-2"><section><h3 className="font-black">Ventas por método</h3><div className="mt-2 divide-y">{PAYMENT_METHODS.map((method) => <div className="flex justify-between py-2" key={method}><span>{PAYMENT_LABELS[method]}</span><strong>{formatCurrency(BigInt(selectedHistory.paymentTotals[method] ?? 0))}</strong></div>)}</div></section><section><h3 className="font-black">Ventas por empleado</h3><div className="mt-2 divide-y">{selectedHistory.employeeTotals.map((employee) => <div className="flex justify-between py-2" key={employee.profileId}><span>{employee.displayName} · {employee.ticketCount} tickets</span><strong>{formatCurrency(BigInt(employee.salesCents))}</strong></div>)}</div></section></div><dl className="mt-6 grid gap-3 border-t pt-4 text-sm sm:grid-cols-2"><div><dt className="text-stone-500">Confirmada por</dt><dd className="font-bold">{selectedHistory.createdByName}</dd></div><div><dt className="text-stone-500">Fecha de confirmación</dt><dd className="font-bold">{dateTime(selectedHistory.createdAt, context.timezone)}</dd></div><div><dt className="text-stone-500">Ventas / tickets / peso</dt><dd className="font-bold">{formatCurrency(BigInt(selectedHistory.totalSalesCents))} · {selectedHistory.ticketCount} · {formatWeight(selectedHistory.soldWeightGrams)}</dd></div><div><dt className="text-stone-500">Observación</dt><dd className="font-bold">{selectedHistory.notes ?? "Sin observación"}</dd></div></dl>{selectedHistory.status === "VOIDED" ? <p className="mt-4 rounded-lg bg-stone-100 p-3 text-sm">Anulada {selectedHistory.voidedAt ? dateTime(selectedHistory.voidedAt, context.timezone) : ""}: {selectedHistory.voidReason}</p> : <VoidSettlementForm settlementId={selectedHistory.id} />}<Link className="mt-5 inline-block rounded-lg border px-4 py-2 font-bold text-rose-800" href={`/admin/sales?preset=custom&from=${organizationLocalDate(selectedHistory.periodStart, context.timezone)}&to=${organizationLocalDate(selectedHistory.periodEnd, context.timezone)}&branch=${selectedHistory.branchId}&status=COMPLETED`}>Ver ventas del período →</Link></article></section> : null}

    {!detailId ? <section className="mt-10" id="history"><h2 className="text-xl font-black">Historial</h2><form className="mt-4 grid gap-3 rounded-2xl border bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5"><select className={input} defaultValue={historyBranch} name="historyBranch"><option value="">Todas las sucursales</option>{overview.map((item) => <option key={item.branchId} value={item.branchId}>{item.branchName}</option>)}</select><input className={input} defaultValue={historyFrom} name="from" type="date" /><input className={input} defaultValue={historyTo} name="to" type="date" /><select className={input} defaultValue={value("difference")} name="difference"><option value="">Todas</option><option value="yes">Con diferencia</option></select><button className="rounded-lg bg-stone-900 px-4 py-2 font-bold text-white">Filtrar historial</button></form><div className="mt-4 grid gap-3 md:grid-cols-2">{history.map((item) => <Link className="rounded-2xl border bg-white p-4 shadow-sm hover:border-rose-300" href={`/admin/settlements?settlement=${item.id}`} key={item.id}><div className="flex items-start justify-between gap-3"><div><strong>{item.branchName}</strong><p className="text-sm text-stone-500">{dateTime(item.periodStart, context.timezone)} → {dateTime(item.periodEnd, context.timezone)}</p></div><span className={`rounded-full px-2 py-1 text-xs font-black ${item.status === "VOIDED" ? "bg-stone-200 text-stone-600" : differenceTone(item.differenceCents)}`}>{item.status === "VOIDED" ? "ANULADA" : item.differenceCents === 0 ? "✓ Sin diferencia" : "⚠ Con diferencia"}</span></div><dl className="mt-4 grid grid-cols-3 gap-2 text-sm"><div><dt className="text-stone-500">Ventas</dt><dd className="font-bold">{formatCurrency(BigInt(item.totalSalesCents))}</dd></div><div><dt className="text-stone-500">Efectivo</dt><dd className="font-bold">{formatCurrency(BigInt(item.expectedCashCents))}</dd></div><div><dt className="text-stone-500">Diferencia</dt><dd className="font-bold">{formatCurrency(BigInt(item.differenceCents))}</dd></div></dl>{item.hasLaterMovements ? <p className="mt-3 text-xs font-bold text-amber-800">⚠ Movimientos posteriores en el período</p> : null}</Link>)}{!history.length ? <p className="rounded-2xl border bg-white p-8 text-stone-500">No hay rendiciones para los filtros elegidos.</p> : null}</div></section> : null}
  </main>;
}
