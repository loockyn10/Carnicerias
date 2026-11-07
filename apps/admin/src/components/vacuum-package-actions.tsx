"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { moveVacuumPackagesAction, voidVacuumPackageAction } from "../app/admin/vacuum/actions";

/**
 * Acciones de un paquete DISPONIBLE: enviarlo a otra sucursal (sólo cambia dónde lo ofrece el POS; el stock del corte se mueve con las transferencias de
 * siempre) o anularlo (se descartó). No mueven stock: envasar nunca lo descontó, el descuento ocurre al vender.
 */
export function VacuumPackageActions({ packageId, currentBranchId, branches }: { packageId: string; currentBranchId: string | null; branches: { id: string; name: string }[] }) {
  const router = useRouter();
  const destinations = branches.filter((branch) => branch.id !== currentBranchId);
  const [target, setTarget] = useState(destinations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!target) return;
    setBusy(true); setError(null);
    const result = await moveVacuumPackagesAction([packageId], target);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    router.refresh();
  }

  async function discard() {
    const reason = window.prompt("¿Por qué se anula este paquete? (por ejemplo: se rompió el vacío)");
    if (!reason) return;
    setBusy(true); setError(null);
    const result = await voidVacuumPackageAction(packageId, reason);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    router.refresh();
  }

  return <div className="mt-2 grid gap-1">
    {destinations.length > 0 ? <div className="flex flex-wrap items-center gap-1">
      <select aria-label="Sucursal de destino" className="rounded border border-stone-300 bg-white px-1.5 py-1 text-xs" onChange={(event) => { setTarget(event.target.value); }} value={target}>
        {destinations.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select>
      <button className="rounded border border-stone-300 px-2 py-1 text-xs font-bold hover:bg-stone-50 disabled:opacity-60" disabled={busy || !target} onClick={() => { void send(); }} type="button">Enviar</button>
    </div> : null}
    <button className="w-fit text-xs font-bold text-red-700 underline disabled:opacity-60" disabled={busy} onClick={() => { void discard(); }} type="button">Anular paquete</button>
    {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
  </div>;
}
