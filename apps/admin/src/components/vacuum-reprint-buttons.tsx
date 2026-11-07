"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { VACUUM_PRINT_KIND_LABELS, type VacuumPrintKind } from "../lib/vacuum";
import { openPdfBlob, printPackageLabels, printPdfBlob, requestVacuumPdf } from "../lib/vacuum-print-client";

/**
 * Botones para imprimir / reimprimir las etiquetas de un paquete ya registrado: «Ambas», sólo la informativa o sólo la de precio (sirve cuando una
 * etiqueta salió mal). Siempre imprimen desde el SNAPSHOT del paquete, nunca con precios actuales. Cada impresión queda registrada.
 */
export function VacuumReprintButtons({ packageId, compact = false }: { packageId: string; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<VacuumPrintKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<Blob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function print(kind: VacuumPrintKind) {
    setBusy(kind); setError(null); setFallback(null); setNotice(null);
    // Primero la impresión con el tamaño exacto del papel (la que usa la estación); si falla, el PDF de siempre.
    const exact = await printPackageLabels(packageId, kind);
    if (exact.ok) {
      setNotice(`Etiqueta ${VACUUM_PRINT_KIND_LABELS[kind].toLowerCase()} enviada a imprimir.`);
      setBusy(null);
      router.refresh();
      return;
    }
    const result = await requestVacuumPdf(packageId, kind);
    if (!result.ok) { setError(result.error); setBusy(null); return; }
    const printed = await printPdfBlob(result.blob);
    if (!printed) setFallback(result.blob);
    setNotice(`Etiqueta ${VACUUM_PRINT_KIND_LABELS[kind].toLowerCase()} enviada a imprimir (${String(result.pages)} ${result.pages === 1 ? "etiqueta" : "etiquetas"}).`);
    setBusy(null);
    router.refresh();
  }

  const size = compact ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm";
  const button = (kind: VacuumPrintKind, primary: boolean) => (
    <button className={`rounded-lg font-bold disabled:opacity-60 ${size} ${primary ? "bg-rose-800 text-white hover:bg-rose-900" : "border border-stone-300 bg-white hover:bg-stone-50"}`} disabled={busy !== null} key={kind} onClick={() => { void print(kind); }} type="button">
      {busy === kind ? "Generando…" : kind === "BOTH" ? "Imprimir ambas" : `Imprimir ${VACUUM_PRINT_KIND_LABELS[kind].toLowerCase()}`}
    </button>
  );
  return <div className="grid gap-1">
    <div className="flex flex-wrap gap-2">{button("BOTH", !compact)}{button("INFO", false)}{button("PRICE", false)}</div>
    {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
    {fallback ? <button className="w-fit text-xs font-bold text-rose-800 underline" onClick={() => { openPdfBlob(fallback); }} type="button">El navegador no abrió la impresión: abrir el PDF</button> : null}
    {notice && !compact ? <p className="text-xs text-emerald-700" role="status">{notice}</p> : null}
  </div>;
}
