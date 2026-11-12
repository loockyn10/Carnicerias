"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { decideReturnAction, receiveReturnsAction, startReturnInspectionAction, type ActionResult } from "../../app/admin/vacuum/distribution/actions";
import { returnGate } from "../../lib/distribution/logic";
import { PACKAGING_STATE_LABELS, PACKAGING_STATES, RETURN_REASON_LABELS, type PackagingState, type ReturnRow } from "../../lib/distribution/model";
import { formatIsoDate, moneyText, weightText } from "../../lib/vacuum";
import { Notice, ReturnStatusBadge, inputClass, primaryButton, secondaryButton } from "./ui";

/**
 * Devoluciones: recepción en cuarentena, inspección y decisión. Un paquete devuelto NUNCA vuelve solo a estar disponible: sólo lo reingresa una aprobación
 * explícita (con motivo; queda usuario y fecha) y sólo si está vigente, con el envase intacto y las condiciones de conservación verificadas. Estas mismas
 * reglas las vuelve a validar la base, que además las garantiza con un check de la tabla.
 */
export function ReturnsBoard({ rows, today }: { rows: ReturnRow[]; today: string }) {
  return <div className="grid gap-3" data-testid="returns-board">{rows.map((row) => <ReturnCard key={row.id} row={row} today={today} />)}</div>;
}

function ReturnCard({ row, today }: { row: ReturnRow; today: string }) {
  const router = useRouter();
  const gate = returnGate(row, today);
  const [packaging, setPackaging] = useState<PackagingState | "">(row.packagingState ?? "");
  const [verified, setVerified] = useState(row.conservationVerified === true);
  const [note, setNote] = useState(row.conservationNote ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<ActionResult>, success: string) {
    setBusy(label); setError(null); setMessage(null);
    try {
      const result = await action();
      if (!result.ok) { setError(result.error); return; }
      setMessage(success);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo completar la operación");
    } finally {
      setBusy(null);
    }
  }

  // La decisión usa lo que se observó al inspeccionar (puede corregir lo anotado al recibir).
  const effective = { ...row, packagingState: packaging === "" ? null : packaging, conservationVerified: verified };
  const decisionGate = returnGate(effective, today);

  return <article className="rounded-xl bg-white p-4 shadow-sm" data-return-status={row.status} data-testid="return-card">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-black">{row.productName} <span className="font-normal text-stone-600">· {weightText(row.weightGrams)} · {moneyText(row.unitCents)}</span></p>
        <p className="text-xs text-stone-500"><span className="font-mono">{row.logisticCode ?? "sin código"}</span> · lote {row.lot} · elaborado {formatIsoDate(row.packedOn)} · vence {formatIsoDate(row.expiresOn)}{row.expired ? <strong className="text-red-700"> · VENCIDO</strong> : null}</p>
        <p className="text-xs text-stone-500">{row.clientName} · {row.siteName} · {row.deliveryLabel} · devolución del {formatIsoDate(row.returnedOn)} · {RETURN_REASON_LABELS[row.reason]}{row.reasonNote ? ` (${row.reasonNote})` : ""}</p>
      </div>
      <div className="text-right"><ReturnStatusBadge status={row.status} />{row.creditRequired ? <p className="mt-1 text-xs font-bold text-amber-800">Pendiente de nota de crédito (venta firme)</p> : null}</div>
    </div>

    {row.receivedAt ? <p className="mt-2 text-xs text-stone-600">Envase: <strong>{row.packagingState ? PACKAGING_STATE_LABELS[row.packagingState] : "sin informar"}</strong> · conservación {row.conservationVerified === true ? "verificada" : row.conservationVerified === false ? "NO verificada" : "sin informar"}{row.conservationNote ? ` (${row.conservationNote})` : ""}</p> : null}
    {row.decidedAt ? <p className="mt-1 text-xs text-stone-600">Decisión de {row.decidedBy ?? "—"} el {formatIsoDate(row.decidedAt.slice(0, 10))}: {row.decisionReason}</p> : null}

    {gate.canReceive ? <div className="mt-3 grid gap-2 rounded-lg border border-stone-200 p-3" data-testid="receive-form">
      <p className="text-sm font-bold">Recibir en Central (entra en cuarentena)</p>
      <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <select aria-label="Estado del envase" className={inputClass} onChange={(event) => { setPackaging(event.target.value as PackagingState | ""); }} value={packaging}><option value="">Estado del envase…</option>{PACKAGING_STATES.map((entry) => <option key={entry} value={entry}>{PACKAGING_STATE_LABELS[entry]}</option>)}</select>
        <input aria-label="Nota de conservación" className={inputClass} maxLength={300} onChange={(event) => { setNote(event.target.value); }} placeholder="Cómo llegó: temperatura, conservadora… (opcional)" value={note} />
      </div>
      <label className="flex items-center gap-2 text-sm"><input checked={verified} onChange={(event) => { setVerified(event.target.checked); }} type="checkbox" /> Se verificaron las condiciones de conservación (cadena de frío)</label>
      <div><button className={primaryButton} disabled={busy !== null || packaging === ""} onClick={() => { void run("receive", () => receiveReturnsAction([{ returnId: row.id, packagingState: packaging, conservationVerified: verified, conservationNote: note }]), "Recibido: el paquete quedó en cuarentena."); }} type="button">Recibir en cuarentena</button></div>
    </div> : null}

    {gate.canDecide ? <div className="mt-3 grid gap-2 rounded-lg border border-stone-200 p-3" data-testid="decision-form">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold">Inspección y decisión</p>
        {gate.canStartInspection ? <button className={secondaryButton} disabled={busy !== null} onClick={() => { void run("inspect", () => startReturnInspectionAction(row.id), "Inspección iniciada."); }} type="button">Iniciar inspección</button> : null}</div>
      {row.status !== "REJECTED" ? <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <select aria-label="Estado del envase al inspeccionar" className={inputClass} onChange={(event) => { setPackaging(event.target.value as PackagingState | ""); }} value={packaging}><option value="">Estado del envase…</option>{PACKAGING_STATES.map((entry) => <option key={entry} value={entry}>{PACKAGING_STATE_LABELS[entry]}</option>)}</select>
        <label className="flex items-center gap-2 text-sm"><input checked={verified} onChange={(event) => { setVerified(event.target.checked); }} type="checkbox" /> Conservación verificada</label>
      </div> : null}
      <input aria-label="Motivo de la decisión" className={inputClass} maxLength={300} onChange={(event) => { setReason(event.target.value); }} placeholder="Motivo de la decisión (obligatorio: queda registrado con tu usuario y la fecha)" value={reason} />
      {row.status !== "REJECTED" && decisionGate.approveBlockers.length > 0 ? <Notice tone="warn">No se puede reingresar: {decisionGate.approveBlockers.join(" · ")}.</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {row.status !== "REJECTED" ? <button className={primaryButton} data-testid="approve" disabled={busy !== null || reason.trim().length < 3 || decisionGate.approveBlockers.length > 0} onClick={() => { void run("approve", () => decideReturnAction({ returnId: row.id, decision: "APPROVE", reason, ...(packaging === "" ? {} : { packagingState: packaging }), conservationVerified: verified, conservationNote: note }), "Reingreso aprobado: el paquete volvió a estar disponible y se sumó al stock."); }} type="button">Aprobar reingreso</button> : null}
        {row.status !== "REJECTED" ? <button className={secondaryButton} disabled={busy !== null || reason.trim().length < 3} onClick={() => { void run("reject", () => decideReturnAction({ returnId: row.id, decision: "REJECT", reason, ...(packaging === "" ? {} : { packagingState: packaging }), conservationVerified: verified }), "Rechazado: sigue en cuarentena hasta descartarlo."); }} type="button">Rechazar</button> : null}
        <button className="rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-50 disabled:opacity-50" disabled={busy !== null || reason.trim().length < 3} onClick={() => { void run("discard", () => decideReturnAction({ returnId: row.id, decision: "DISCARD", reason }), "Descartado."); }} type="button">Descartar</button>
      </div>
    </div> : null}
    {error ? <div className="mt-2"><Notice tone="error">{error}</Notice></div> : null}
    {message ? <div className="mt-2"><Notice tone="ok">{message}</Notice></div> : null}
  </article>;
}
