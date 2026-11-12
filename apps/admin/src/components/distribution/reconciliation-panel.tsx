"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  closeReconciliationAction, registerReturnsAction, reportDeliverySalesAction, reportDeliverySalesByCodesAction, reportQuantitySalesAction, type ActionResult
} from "../../app/admin/vacuum/distribution/actions";
import { reconciliationDifferences } from "../../lib/distribution/logic";
import { RETURN_REASON_LABELS, RETURN_REASONS, type Reconciliation, type ReplenishmentRow, type ReturnReason } from "../../lib/distribution/model";
import { printPackageLabels } from "../../lib/vacuum-print-client";
import { formatIsoDate, moneyText, weightText } from "../../lib/vacuum";
import { Notice, OutcomeBadge, ReturnStatusBadge, inputClass, primaryButton, secondaryButton } from "./ui";

/**
 * Conciliación de UNA entrega: lo informado como vendido (paquetes identificados vs. cantidades), las devoluciones y lo que queda sin explicar. Registrar es
 * siempre una acción del usuario; nada se concilia solo ni se inventan identificaciones cuando el supermercado sólo informa cantidades.
 */
export function ReconciliationPanel({ reconciliation, today, history }: { reconciliation: Reconciliation; today: string; history: ReplenishmentRow[] }) {
  const router = useRouter();
  const { delivery, totals } = reconciliation;
  const closed = reconciliation.closure.closedAt !== null;
  const consignment = delivery.commercialMode === "CONSIGNMENT";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [quantityNote, setQuantityNote] = useState("");
  const [reason, setReason] = useState<ReturnReason>("UNSOLD");
  const [reasonNote, setReasonNote] = useState("");
  const [returnedOn, setReturnedOn] = useState(today);
  const [closeNote, setCloseNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useRef({ quantity: crypto.randomUUID(), returns: crypto.randomUUID() });
  const differences = reconciliationDifferences(reconciliation);
  const selectable = reconciliation.packages.filter((pkg) => (pkg.outcome === "PENDING" || pkg.outcome === "SOLD_FIRM") && pkg.returnStatus === null);

  async function run(label: string, action: () => Promise<ActionResult>, success: (data: unknown) => string) {
    setBusy(label); setError(null); setNotice(null);
    try {
      const result = await action();
      if (!result.ok) { setError(result.error); return; }
      setNotice(success(result.data));
      setSelected(new Set()); setCodes(""); setQuantities({}); setQuantityNote(""); setReasonNote("");
      keys.current = { quantity: crypto.randomUUID(), returns: crypto.randomUUID() };
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo completar la operación");
    } finally {
      setBusy(null);
    }
  }

  const num = (data: unknown, key: string) => (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)[key] === "number" ? (data as Record<string, number>)[key] ?? 0 : 0);
  const quantityItems = Object.entries(quantities).map(([productId, value]) => ({ productId, quantity: Number.parseInt(value, 10) })).filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
  const codeList = codes.split(/[\s,;]+/).filter((entry) => entry !== "");

  return <div className="grid gap-5" data-testid="reconciliation-panel">
    <section className="grid gap-3 rounded-xl bg-white p-5 shadow-sm">
      <h2 className="text-lg font-black">Conciliación</h2>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7" data-testid="reconciliation-totals">
        {[["Entregados", totals.delivered, ""], ["Vendidos firmes", totals.soldFirm, ""], ["Vendidos identificados", totals.soldIdentified, ""], ["Vendidos por cantidad", totals.soldInferred, "est"], ["Devueltos", totals.returned, ""], ["Devolución por recibir", totals.returnPending, ""], ["Pendientes", totals.pending, "warn"]].map(([label, value, tone]) =>
          <div className={`rounded-lg border p-3 ${tone === "est" ? "border-dashed border-amber-400 bg-amber-50" : tone === "warn" && Number(value) !== 0 ? "border-amber-300 bg-amber-50" : "border-stone-200"}`} key={String(label)}>
            <p className="text-xs text-stone-500">{label}{tone === "est" ? " (estimado)" : ""}</p><p className="text-2xl font-black tabular-nums">{value}</p></div>)}
      </div>
      {differences.length > 0 ? <div data-testid="differences"><Notice tone="warn"><strong>Diferencias detectadas:</strong> {differences.map((entry) => entry.message).join(" · ")}</Notice></div> : <Notice tone="ok">Sin diferencias: todo lo entregado está explicado.</Notice>}
      {closed ? <Notice tone="info">Conciliación cerrada el {formatIsoDate((reconciliation.closure.closedAt ?? "").slice(0, 10))}{reconciliation.closure.closedBy ? ` por ${reconciliation.closure.closedBy}` : ""}{reconciliation.closure.pendingAtClose ? ` con ${String(reconciliation.closure.pendingAtClose)} sin explicar` : ""}{reconciliation.closure.note ? `: ${reconciliation.closure.note}` : "."}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
    </section>

    <section className="overflow-hidden rounded-xl bg-white shadow-sm"><h2 className="p-5 pb-0 text-lg font-black">Por producto</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[720px] text-left text-sm" data-testid="reconciliation-products">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">Producto</th><th className="p-3">Entregados</th><th className="p-3">Vendidos</th><th className="p-3">Por cantidad (estimado)</th><th className="p-3">Devueltos</th><th className="p-3">Pendientes</th></tr></thead>
        <tbody>{reconciliation.products.map((product) => <tr className="border-b border-stone-100 last:border-0" key={product.productId}>
          <td className="p-3 font-bold">{product.productName}</td><td className="p-3 tabular-nums">{product.delivered}</td><td className="p-3 tabular-nums">{product.soldFirm + product.soldIdentified}</td>
          <td className="p-3 tabular-nums text-amber-800">{product.soldInferred}{product.soldInferred > 0 ? <span className="block text-xs">≈ {moneyText(product.estimatedInferredCents)}</span> : null}</td>
          <td className="p-3 tabular-nums">{product.returned}{product.returnPending > 0 ? <span className="block text-xs text-stone-500">+{product.returnPending} por recibir</span> : null}</td>
          <td className={`p-3 tabular-nums ${product.pending !== 0 ? "font-bold text-amber-800" : ""}`}>{product.pending}</td></tr>)}</tbody>
      </table></div>
    </section>

    {delivery.status === "CONFIRMED" ? <section className="grid gap-5 rounded-xl bg-white p-5 shadow-sm lg:grid-cols-2" data-testid="reconciliation-actions">
      {consignment && !closed ? <div className="grid content-start gap-3">
        <h3 className="font-black">Informar paquetes vendidos (identificados)</h3>
        <p className="text-xs text-stone-500">Escaneá los identificadores logísticos de los paquetes que el supermercado informó vendidos (uno por línea), o elegí paquetes en la tabla.</p>
        <textarea aria-label="Códigos vendidos" className={`${inputClass} font-mono`} onChange={(event) => { setCodes(event.target.value); }} placeholder={"7K3M-9QX4-S\nAB12-CD34-E"} rows={3} value={codes} />
        <div className="flex flex-wrap gap-2">
          <button className={primaryButton} disabled={busy !== null || codeList.length === 0} onClick={() => { void run("sold-codes", () => reportDeliverySalesByCodesAction(delivery.id, codeList), (data) => `${String(num(data, "reported"))} informados como vendidos${num(data, "alreadyReported") > 0 ? ` (${String(num(data, "alreadyReported"))} ya estaban)` : ""}.`); }} type="button">Informar los códigos escaneados</button>
          <button className={secondaryButton} disabled={busy !== null || selected.size === 0} onClick={() => { void run("sold-ids", () => reportDeliverySalesAction(delivery.id, [...selected]), (data) => `${String(num(data, "reported"))} informados como vendidos.`); }} type="button">Marcar los {selected.size} elegidos como vendidos</button>
        </div>
      </div> : null}

      {consignment && !closed ? <div className="grid content-start gap-3">
        <h3 className="font-black">Informar ventas sólo por cantidad</h3>
        <p className="text-xs text-stone-500">Cuando el supermercado informa cuántos vendió pero no cuáles: se guarda como estimación y NO se marca ningún paquete como vendido.</p>
        <div className="grid gap-2">{reconciliation.products.filter((product) => product.pending > 0).map((product) => <label className="flex items-center justify-between gap-3 text-sm" key={product.productId}>
          <span>{product.productName} <span className="text-xs text-stone-500">(sin conciliar: {product.pending})</span></span>
          <input aria-label={`Vendidos de ${product.productName}`} className={`${inputClass} w-20 text-right`} inputMode="numeric" max={product.pending} min={0} onChange={(event) => { setQuantities((current) => ({ ...current, [product.productId]: event.target.value })); }} type="number" value={quantities[product.productId] ?? ""} /></label>)}
          {reconciliation.products.every((product) => product.pending <= 0) ? <p className="text-sm text-stone-500">No quedan paquetes sin conciliar.</p> : null}</div>
        <input aria-label="Nota del informe" className={inputClass} maxLength={300} onChange={(event) => { setQuantityNote(event.target.value); }} placeholder="Nota (opcional): quién informó, cuándo…" value={quantityNote} />
        <div><button className={secondaryButton} disabled={busy !== null || quantityItems.length === 0} onClick={() => { void run("quantity", () => reportQuantitySalesAction({ deliveryId: delivery.id, items: quantityItems, note: quantityNote, requestKey: keys.current.quantity }), (data) => `${String(num(data, "recorded"))} informe(s) registrado(s).`); }} type="button">Registrar las cantidades</button></div>
      </div> : null}

      <div className="grid content-start gap-3 lg:col-span-2" data-testid="register-returns">
        <h3 className="font-black">Registrar devolución (paquetes que se retiran del supermercado)</h3>
        <p className="text-xs text-stone-500">Elegí los paquetes en la tabla de abajo. Siguen siendo del supermercado hasta que se reciban en Central, donde entran en <strong>cuarentena</strong>: ningún paquete devuelto vuelve a estar disponible sin una inspección y una aprobación explícita.</p>
        <div className="grid gap-2 sm:grid-cols-[12rem_10rem_minmax(0,1fr)]">
          <select aria-label="Motivo" className={inputClass} onChange={(event) => { setReason(event.target.value as ReturnReason); }} value={reason}>{RETURN_REASONS.map((entry) => <option key={entry} value={entry}>{RETURN_REASON_LABELS[entry]}</option>)}</select>
          <input aria-label="Fecha de devolución" className={inputClass} max={today} min={delivery.deliveryDate} onChange={(event) => { setReturnedOn(event.target.value); }} type="date" value={returnedOn} />
          <input aria-label="Detalle del motivo" className={inputClass} maxLength={300} onChange={(event) => { setReasonNote(event.target.value); }} placeholder={reason === "OTHER" ? "Explicá el motivo (obligatorio)" : "Detalle (opcional)"} value={reasonNote} />
        </div>
        <div><button className={primaryButton} disabled={busy !== null || selected.size === 0 || (reason === "OTHER" && reasonNote.trim() === "")} onClick={() => { void run("returns", () => registerReturnsAction({ deliveryId: delivery.id, items: [...selected].map((packageId) => ({ packageId, reason, ...(reasonNote.trim() ? { reasonNote } : {}) })), returnedOn, requestKey: keys.current.returns }), (data) => `${String(num(data, "registered"))} devolución(es) registrada(s). Falta recibirlas en Central.`); }} type="button">Registrar la devolución de los {selected.size} elegidos</button></div>
      </div>

      {!closed ? <div className="grid content-start gap-2 border-t border-stone-200 pt-4 lg:col-span-2">
        <h3 className="font-black">Cerrar la conciliación</h3>
        <p className="text-xs text-stone-500">Cuando todo está informado, cerrala. Si quedan paquetes sin explicar hace falta una nota y la diferencia queda registrada.</p>
        <div className="flex flex-wrap gap-2"><input aria-label="Nota de cierre" className={`${inputClass} min-w-0 flex-1`} maxLength={500} onChange={(event) => { setCloseNote(event.target.value); }} placeholder={totals.pending > 0 ? `Quedan ${String(totals.pending)} sin explicar: nota obligatoria` : "Nota (opcional)"} value={closeNote} />
          <button className={secondaryButton} disabled={busy !== null || (totals.pending !== 0 && closeNote.trim().length < 3)} onClick={() => { void run("close", () => closeReconciliationAction(delivery.id, closeNote), () => "Conciliación cerrada."); }} type="button">Cerrar conciliación</button></div>
      </div> : null}
    </section> : null}

    <section className="overflow-hidden rounded-xl bg-white shadow-sm"><h2 className="p-5 pb-0 text-lg font-black">Paquetes de la entrega</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[900px] text-left text-sm" data-testid="reconciliation-packages">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">{selectable.length > 0 ? <input aria-label="Elegir todos" checked={selected.size === selectable.length} onChange={(event) => { setSelected(event.target.checked ? new Set(selectable.map((pkg) => pkg.packageId)) : new Set()); }} type="checkbox" /> : null}</th><th className="p-3">Código</th><th className="p-3">Producto</th><th className="p-3">Peso</th><th className="p-3">Lote</th><th className="p-3">Vence</th><th className="p-3">Valor</th><th className="p-3">Resultado</th><th className="p-3" /></tr></thead>
        <tbody>{reconciliation.packages.map((pkg) => <tr className="border-b border-stone-100 last:border-0" key={pkg.packageId}>
          <td className="p-3">{selectable.some((entry) => entry.packageId === pkg.packageId) ? <input aria-label={`Elegir ${pkg.lot}`} checked={selected.has(pkg.packageId)} onChange={(event) => { setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(pkg.packageId); else next.delete(pkg.packageId); return next; }); }} type="checkbox" /> : null}</td>
          <td className="p-3 font-mono text-xs">{pkg.logisticCode ?? "—"}</td><td className="p-3 font-bold">{pkg.productName}</td><td className="p-3 tabular-nums">{weightText(pkg.weightGrams)}</td><td className="p-3 text-xs">{pkg.lot}</td>
          <td className={`p-3 text-xs ${pkg.expired && pkg.outcome === "PENDING" ? "font-bold text-red-700" : ""}`}>{formatIsoDate(pkg.expiresOn)}{pkg.expired && pkg.outcome === "PENDING" ? " · vencido" : ""}</td>
          <td className="p-3 tabular-nums">{moneyText(pkg.unitCents)}</td>
          <td className="p-3"><OutcomeBadge outcome={pkg.outcome} />{pkg.returnStatus ? <span className="mt-1 block"><ReturnStatusBadge status={pkg.returnStatus} /></span> : null}{pkg.soldOn ? <span className="block text-xs text-stone-500">el {formatIsoDate(pkg.soldOn)}</span> : null}</td>
          <td className="p-3 text-right"><button className="text-xs font-bold text-rose-800 underline" onClick={() => { void printPackageLabels(pkg.packageId, "LOGISTIC").then((result) => { if (!result.ok) setError(result.error); }); }} type="button">Etiqueta logística</button></td></tr>)}</tbody>
      </table></div>
    </section>

    {history.length > 0 ? <section className="overflow-hidden rounded-xl bg-white shadow-sm" data-testid="replenishment-history"><h2 className="p-5 pb-0 text-lg font-black">Historial de reposiciones del establecimiento</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-stone-200 bg-stone-50 text-stone-500"><tr><th className="p-3">Entrega</th><th className="p-3">Fecha</th><th className="p-3">Entregados</th><th className="p-3">Vendidos</th><th className="p-3">Por cantidad</th><th className="p-3">Devueltos</th><th className="p-3">Pendientes</th><th className="p-3">Conciliación</th></tr></thead>
        <tbody>{history.map((row) => <tr className="border-b border-stone-100 last:border-0" key={row.id}>
          <td className="p-3 font-bold"><a className="text-rose-800 underline" href={`/admin/vacuum/distribution/deliveries/${row.id}`}>{row.numberLabel}</a></td><td className="p-3">{formatIsoDate(row.deliveryDate)}</td><td className="p-3 tabular-nums">{row.delivered}</td>
          <td className="p-3 tabular-nums">{row.soldConfirmed}</td><td className="p-3 tabular-nums text-amber-800">{row.soldInferred}</td><td className="p-3 tabular-nums">{row.returned}</td><td className="p-3 tabular-nums">{row.pending}</td>
          <td className="p-3 text-xs">{row.closedAt ? "Cerrada" : "Abierta"}</td></tr>)}</tbody>
      </table></div></section> : null}
  </div>;
}
