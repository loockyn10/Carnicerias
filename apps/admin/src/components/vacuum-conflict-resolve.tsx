"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { resolveVacuumConflictAction } from "../app/admin/vacuum/actions";

/** Da por resuelto un conflicto de venta de un paquete. Pide una nota (queda en el historial del paquete). */
export function VacuumConflictResolve({ conflictId }: { conflictId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    setBusy(true); setError(null);
    const result = await resolveVacuumConflictAction(conflictId, note);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    router.refresh();
  }

  return <div className="grid gap-1">
    <input aria-label="Cómo se resolvió" className="rounded border border-stone-300 bg-white px-2 py-1 text-xs" maxLength={500} onChange={(event) => { setNote(event.target.value); }} placeholder="Cómo se resolvió…" value={note} />
    <button className="w-fit rounded border border-stone-300 px-2 py-1 text-xs font-bold hover:bg-stone-50 disabled:opacity-60" disabled={busy || note.trim().length < 3} onClick={() => { void resolve(); }} type="button">Marcar resuelto</button>
    {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
  </div>;
}
