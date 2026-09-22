"use client";

import { formatWeight } from "@carnicerias/business-logic";
import { useActionState, useEffect, useMemo, useState } from "react";

import {
  recordReplenishmentFormAction,
  setReplenishmentTargetDaysFormAction,
  type ReplenishmentFormState
} from "../app/admin/actions";
import { compareReplenishmentUrgency, type ReplenishmentRow, type ReplenishmentUnit } from "../lib/replenishment";

type Filter = "needed" | "critical" | "all";
const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

function formatQuantity(value: number, unitType: ReplenishmentUnit) {
  return unitType === "WEIGHT"
    ? formatWeight(value)
    : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(value)} ${value === 1 ? "unidad" : "unidades"}`;
}

function formatDaily(value: number, unitType: ReplenishmentUnit) {
  if (value <= 0) return "Sin ventas recientes";
  return unitType === "WEIGHT"
    ? `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(value / 1_000)} kg/día`
    : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format(value)} unidades/día`;
}

function quantityInputValue(value: number, unitType: ReplenishmentUnit) {
  return unitType === "WEIGHT" ? (value / 1_000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(Math.ceil(value));
}

function groupedTotals(rows: ReplenishmentRow[]) {
  const weight = rows.filter((row) => row.unitType === "WEIGHT").reduce((sum, row) => sum + row.suggestedQuantity, 0);
  const units = rows.filter((row) => row.unitType === "UNIT").reduce((sum, row) => sum + row.suggestedQuantity, 0);
  return [weight > 0 ? formatWeight(weight) : "", units > 0 ? formatQuantity(units, "UNIT") : ""].filter(Boolean).join(" · ") || "Sin carga";
}

function TargetCoverageForm({ targetDays }: { targetDays: number }) {
  const [state, action, pending] = useActionState(setReplenishmentTargetDaysFormAction, {} as ReplenishmentFormState);
  return <form action={action} className="flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4 shadow-sm">
    <label className="grid gap-1 text-sm font-bold">Objetivo de cobertura
      <span className="flex items-center gap-2"><input className={`${input} w-24`} defaultValue={targetDays} max="30" min="0.01" name="target_days" required step="0.01" type="number" /> días</span>
    </label>
    <button className="rounded-lg border border-stone-300 px-4 py-2 font-bold hover:border-rose-300 disabled:opacity-60" disabled={pending}>{pending ? "Guardando…" : "Guardar"}</button>
    {state.error ? <p className="w-full text-sm text-red-700">{state.error}</p> : null}
    {state.successToken ? <p className="w-full text-sm text-emerald-700">Objetivo actualizado.</p> : null}
  </form>;
}

function RestockDialog({ row, onClose }: { row: ReplenishmentRow; onClose: () => void }) {
  const [state, action, pending] = useActionState(recordReplenishmentFormAction, {} as ReplenishmentFormState);
  useEffect(() => {
    if (!state.successToken) return;
    onClose();
  }, [onClose, state.successToken]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div aria-labelledby="restock-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-stone-950/55 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="dialog">
    <form action={action} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-wide text-rose-800">Registrar ingreso</p><h2 className="mt-1 text-xl font-black" id="restock-title">{row.productName}</h2><p className="text-sm text-stone-500">{row.branchName}</p></div><button aria-label="Cerrar" className="rounded-lg px-2 py-1 text-xl hover:bg-stone-100" onClick={onClose} type="button">×</button></div>
      <input name="branch_id" type="hidden" value={row.branchId} /><input name="product_id" type="hidden" value={row.productId} />
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-stone-50 p-3 text-sm"><div><dt className="text-stone-500">Stock actual</dt><dd className="font-bold">{row.currentQuantity <= 0 ? "Sin stock" : formatQuantity(row.currentQuantity, row.unitType)}</dd></div><div><dt className="text-stone-500">Sugerido</dt><dd className="font-bold">{formatQuantity(row.suggestedQuantity, row.unitType)}</dd></div></dl>
      <label className="mt-4 grid gap-1 text-sm font-bold">Cantidad recibida
        <span className="flex items-center gap-2"><input autoFocus className={`${input} w-full`} defaultValue={quantityInputValue(row.suggestedQuantity, row.unitType)} min={row.unitType === "WEIGHT" ? "0.001" : "1"} name="quantity" required step={row.unitType === "WEIGHT" ? "0.001" : "1"} type="number" />{row.unitType === "WEIGHT" ? "kg" : "unidades"}</span>
      </label>
      <label className="mt-3 grid gap-1 text-sm font-bold">Nota opcional<input className={input} name="note" placeholder="Ingreso desde reposición" /></label>
      {state.error ? <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</p> : null}
      <div className="mt-5 grid grid-cols-2 gap-3"><button className="rounded-lg border px-4 py-2 font-bold" onClick={onClose} type="button">Cancelar</button><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "Registrando…" : "Registrar ingreso"}</button></div>
    </form>
  </div>;
}

export function ReplenishmentDashboard({ rows, branches, targetDays }: { rows: ReplenishmentRow[]; branches: { id: string; name: string }[]; targetDays: number }) {
  const [filter, setFilter] = useState<Filter>("needed");
  const [branchId, setBranchId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReplenishmentRow | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const branchRows = useMemo(() => rows.filter((row) => !branchId || row.branchId === branchId), [branchId, rows]);
  const visibleRows = useMemo(() => branchRows
    .filter((row) => !search || row.productName.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")))
    .filter((row) => filter === "all" || (filter === "critical" ? row.priority === "CRITICAL" : row.needsReplenishment))
    .sort(compareReplenishmentUrgency), [branchRows, filter, search]);
  const actionRows = branchRows.filter((row) => row.needsReplenishment).sort(compareReplenishmentUrgency);
  const criticalCount = branchRows.filter((row) => row.priority === "CRITICAL").length;
  const lowCoverageCount = branchRows.filter((row) => row.coverageDays !== null && row.coverageDays < 1).length;
  const grouped = branches.map((branch) => ({ branch, rows: visibleRows.filter((row) => row.branchId === branch.id) })).filter((group) => group.rows.length);
  const todayGroups = branches.map((branch) => ({ branch, rows: actionRows.filter((row) => row.branchId === branch.id) })).filter((group) => group.rows.length);

  const toggleChecked = (key: string) => setChecked((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  return <>
    <div className="mt-6 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-red-200 bg-red-50 p-4"><p className="text-sm text-red-700">Productos críticos</p><strong className="text-3xl text-red-900">{criticalCount}</strong></div><div className="rounded-2xl border bg-white p-4"><p className="text-sm text-stone-500">Necesitan reposición</p><strong className="text-3xl">{actionRows.length}</strong></div><div className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-700">Stock para &lt;1 día</p><strong className="text-3xl text-amber-900">{lowCoverageCount}</strong></div></div>

    <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]"><div className="flex flex-wrap gap-2">{[{ id: "", name: "Todas" }, ...branches].map((branch) => <button className={`rounded-full px-4 py-2 text-sm font-bold ${branchId === branch.id ? "bg-rose-800 text-white" : "border bg-white hover:border-rose-300"}`} key={branch.id || "all"} onClick={() => setBranchId(branch.id)}>{branch.name}</button>)}</div><TargetCoverageForm targetDays={targetDays} /></div>

    <div className="mt-5 flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm sm:flex-row"><input className={`${input} min-w-0 flex-1`} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto…" value={search} /><div className="flex flex-wrap gap-2">{(["needed", "critical", "all"] as Filter[]).map((value) => <button className={`rounded-lg px-3 py-2 text-sm font-bold ${filter === value ? "bg-stone-900 text-white" : "bg-stone-100"}`} key={value} onClick={() => setFilter(value)}>{value === "needed" ? "Necesitan reposición" : value === "critical" ? "Críticos" : "Todos"}</button>)}</div></div>

    <section className="mt-6 space-y-7">{grouped.map(({ branch, rows: groupRows }) => <div key={branch.id}><div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-xl font-black">Sucursal {branch.name}</h2><p className="text-sm text-stone-500">{groupRows.filter((row) => row.needsReplenishment).length} productos para reponer</p></div><strong className="text-sm text-rose-800">{groupedTotals(groupRows.filter((row) => row.needsReplenishment))} sugeridos</strong></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{groupRows.map((row) => <article className={`rounded-2xl border p-4 shadow-sm ${row.priority === "CRITICAL" ? "border-red-200 bg-red-50" : row.priority === "HIGH" ? "border-amber-200 bg-amber-50" : "bg-white"}`} key={`${row.branchId}:${row.productId}`}><div className="flex items-start justify-between gap-3"><div><span className={`text-xs font-black ${row.priority === "CRITICAL" ? "text-red-700" : row.priority === "HIGH" ? "text-amber-700" : "text-emerald-700"}`}>{row.priority === "CRITICAL" ? "CRÍTICO" : row.priority === "HIGH" ? "ALTO" : "NORMAL"}</span><h3 className="mt-1 text-lg font-black">{row.productName}</h3></div><strong className="text-right text-rose-900">Llevar<br />{formatQuantity(row.suggestedQuantity, row.unitType)}</strong></div><dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm"><div><dt className="text-stone-500">Stock actual</dt><dd className="font-bold">{row.currentQuantity <= 0 ? "Sin stock" : formatQuantity(row.currentQuantity, row.unitType)}</dd>{row.currentQuantity < 0 ? <dd className="text-xs text-red-700">Faltante: {formatQuantity(Math.abs(row.currentQuantity), row.unitType)}</dd> : null}</div><div><dt className="text-stone-500">Venta promedio</dt><dd className="font-bold">{formatDaily(row.averageDailyQuantity, row.unitType)}</dd></div><div><dt className="text-stone-500">Cobertura</dt><dd className="font-bold">{row.coverageDays === null ? "—" : `≈ ${row.coverageDays.toLocaleString("es-AR", { maximumFractionDigits: 1 })} días`}</dd></div><div><dt className="text-stone-500">Mínimo / objetivo</dt><dd className="font-bold">{formatQuantity(row.minimumQuantity, row.unitType)} / {formatQuantity(row.desiredStockQuantity, row.unitType)}</dd></div></dl>{row.needsReplenishment ? <button className="mt-4 w-full rounded-lg bg-rose-800 px-4 py-2 font-bold text-white hover:bg-rose-700" onClick={() => setSelected(row)}>Registrar ingreso</button> : null}</article>)}</div></div>)}{!grouped.length ? <p className="rounded-2xl border bg-white p-8 text-center text-stone-500">No hay productos para los filtros elegidos.</p> : null}</section>

    <section className="mt-8 rounded-2xl border bg-white p-5 shadow-sm"><div><p className="text-xs font-black uppercase tracking-wide text-rose-800">Lista práctica</p><h2 className="mt-1 text-xl font-black">Carga de hoy</h2></div><div className="mt-4 grid gap-5 md:grid-cols-2">{todayGroups.map(({ branch, rows: groupRows }) => <div key={branch.id}><div className="flex items-baseline justify-between gap-3"><h3 className="font-black">{branch.name}</h3><span className="text-xs text-stone-500">{groupedTotals(groupRows)}</span></div><ul className="mt-2 divide-y rounded-xl border">{groupRows.map((row) => { const key = `${row.branchId}:${row.productId}`; return <li key={key}><label className="flex cursor-pointer items-center gap-3 px-3 py-3"><input checked={checked.has(key)} onChange={() => toggleChecked(key)} type="checkbox" /><span className={`min-w-0 flex-1 font-medium ${checked.has(key) ? "text-stone-400 line-through" : ""}`}>{row.productName}</span><strong>{formatQuantity(row.suggestedQuantity, row.unitType)}</strong></label></li>; })}</ul></div>)}{!todayGroups.length ? <p className="text-stone-500">No hay mercadería sugerida para cargar.</p> : null}</div></section>

    {selected ? <RestockDialog key={`${selected.branchId}:${selected.productId}`} onClose={() => setSelected(null)} row={selected} /> : null}
  </>;
}
