"use client";

import { formatCurrency } from "@carnicerias/business-logic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type SyntheticEvent, type ReactNode } from "react";

import { endRecurringCostAction, loadOperatingCostsAction, recordExpenseAction, saveRecurringCostAction, voidExpenseAction } from "../app/admin/actions";
import { centsToField } from "../lib/bulk-costs";
import { formatIsoDate } from "../lib/date-range";
import {
  describeVersion, firstDayOfMonth, formatShortDate, LABOR_DUPLICATE_NOTE, looksLikePersonnelCost, monthlyLabel, parseEndForm, parseExpenseForm, parseMonthlyForm, visibleHistory,
  type BranchExpense, type OperatingCostsReport, type RecurringCost
} from "../lib/operating-costs";
import { LaborSection } from "./operating-labor-section";
import { OverlayDialog } from "./overlay-dialog";

const money = (cents: number) => formatCurrency(BigInt(cents));
const field = "rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm";
const primary = "rounded-lg bg-rose-800 px-4 py-2 text-sm font-bold text-white hover:bg-rose-900 disabled:opacity-50";
const link = "text-sm font-bold text-rose-800 hover:underline disabled:opacity-50";

/** Qué formulario está abierto (uno solo a la vez): el modal nunca muestra un formulario permanente. */
type Panel =
  | { kind: "add-cost" }
  | { kind: "change-cost"; costId: string }
  | { kind: "end-cost"; costId: string }
  | { kind: "add-expense" }
  | { kind: "void-expense"; expenseId: string };

/**
 * «Costos operativos — SUCURSAL»: un modal sencillo dentro del detalle de sucursal (sin pantalla nueva). Costos mensuales (sueldo, alquiler,
 * internet...) que se configuran una vez y rigen DESDE una fecha (cambiar el importe no reescribe los meses anteriores) y gastos puntuales
 * (una reparación, una factura de luz...) con fecha, concepto e importe. Todo lo calcula el servidor; acá sólo se cargan y se muestran.
 */
export function OperatingCostsModal({ branchId, branchName, from, to, onClose }: { branchId: string; branchName: string; from: string; to: string; onClose: () => void }) {
  const router = useRouter();
  const [report, setReport] = useState<OperatingCostsReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    const result = await loadOperatingCostsAction(branchId, from, to);
    if (!result.ok) { setLoadError(result.error); return; }
    setLoadError(null);
    setReport(result.report);
  }, [branchId, from, to]);

  useEffect(() => { startTransition(async () => { await reload(); }); }, [reload]);

  /** Ejecuta una acción de escritura: si sale bien cierra el formulario, recarga el modal y refresca el Resumen. */
  const run = (action: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) => {
    setFormError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) { setFormError(result.error); return; }
      setPanel(null);
      setNotice(success);
      await reload();
      router.refresh();
    });
  };

  const toggleHistory = (costId: string) => setHistory((current) => {
    const next = new Set(current);
    if (!next.delete(costId)) next.add(costId);
    return next;
  });
  const open = (next: Panel | null) => { setPanel(next); setFormError(null); setNotice(null); };

  return <OverlayDialog onClose={onClose} subtitle="Lo que cuesta sostener la sucursal, además de la mercadería" title={`Costos operativos — ${branchName.toUpperCase()}`}>
    {loadError ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{loadError}</p> : null}
    {!report && !loadError ? <p className="mt-4 text-sm text-stone-500" role="status">Cargando…</p> : null}
    {report ? <div className="mt-4 space-y-6">
      {notice ? <p className="rounded-lg bg-emerald-50 p-3 text-sm font-bold text-emerald-800" role="status">✓ {notice}</p> : null}
      {!report.canWrite ? <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700" role="status">Podés ver los costos, pero cargarlos o cambiarlos requiere el permiso de costos operativos.</p> : null}

      {report.labor ? <LaborSection labor={report.labor} period={report.period} today={report.today} /> : null}

      <section aria-labelledby="costs-monthly">
        <h3 className="text-base font-black" id="costs-monthly">Costos mensuales</h3>
        <p className="mt-0.5 text-sm text-stone-600">Se cargan una sola vez. Cada mes se reparte por día: un día del período cuenta 1/días del mes.{report.labor ? " Para alquiler, internet, luz… (el personal ya se calcula arriba)." : ""}</p>
        <ul className="mt-2 divide-y divide-stone-100 rounded-xl bg-white shadow-sm">
          {report.recurring.map((cost) => <MonthlyRow canWrite={report.canWrite} cost={cost} laborOverlap={report.labor !== null && report.labor.workedSeconds > 0 && cost.status === "ACTIVE" && looksLikePersonnelCost(cost.name)} historyOpen={history.has(cost.id)} key={cost.id} onToggleHistory={() => toggleHistory(cost.id)} onOpen={open} panel={panel} today={report.today}>
            {panel?.kind === "change-cost" && panel.costId === cost.id ? <ChangeCostForm cost={cost} error={formError} onCancel={() => open(null)} onSave={(input) => run(() => saveRecurringCostAction({ branchId, costId: cost.id, name: cost.name, amountCents: input.amountCents, from: input.from, requestKey: null }), `Importe de ${cost.name} actualizado desde el ${formatIsoDate(input.from)}.`)} pending={pending} today={report.today} /> : null}
            {panel?.kind === "end-cost" && panel.costId === cost.id ? <EndCostForm cost={cost} error={formError} onCancel={() => open(null)} onConfirm={(date) => run(() => endRecurringCostAction({ costId: cost.id, to: date }), `${cost.name} deja de aplicarse desde el ${formatIsoDate(date)}.`)} pending={pending} today={report.today} /> : null}
          </MonthlyRow>)}
          {!report.recurring.length ? <li className="px-4 py-4 text-sm text-stone-500">Todavía no hay costos mensuales. Agregá el sueldo, el alquiler, internet…</li> : null}
        </ul>
        {report.canWrite ? (panel?.kind === "add-cost"
          ? <AddCostForm error={formError} onCancel={() => open(null)} onSave={(input, requestKey) => run(() => saveRecurringCostAction({ branchId, costId: null, name: input.name, amountCents: input.amountCents, from: input.from, requestKey }), `${input.name} agregado: ${monthlyLabel(input.amountCents)}.`)} pending={pending} today={report.today} />
          : <button className={`${link} mt-2`} disabled={pending} onClick={() => open({ kind: "add-cost" })} type="button">+ Agregar costo mensual</button>) : null}
      </section>

      <section aria-labelledby="costs-expenses">
        <h3 className="text-base font-black" id="costs-expenses">Otros gastos</h3>
        <p className="mt-0.5 text-sm text-stone-600">Gastos de una sola vez: se descuentan completos del resultado del período que incluye su fecha.</p>
        <ul className="mt-2 divide-y divide-stone-100 rounded-xl bg-white shadow-sm">
          {report.expenses.map((expense) => <ExpenseRow canWrite={report.canWrite} expense={expense} key={expense.id} onOpen={open} panel={panel} today={report.today}>
            {panel?.kind === "void-expense" && panel.expenseId === expense.id ? <VoidExpenseForm error={formError} onCancel={() => open(null)} onConfirm={(reason) => run(() => voidExpenseAction({ expenseId: expense.id, reason }), `Gasto «${expense.concept}» anulado.`)} pending={pending} /> : null}
          </ExpenseRow>)}
          {!report.expenses.length ? <li className="px-4 py-4 text-sm text-stone-500">Todavía no hay gastos registrados.</li> : null}
        </ul>
        {report.canWrite ? (panel?.kind === "add-expense"
          ? <AddExpenseForm error={formError} onCancel={() => open(null)} onSave={(input, requestKey) => run(() => recordExpenseAction({ branchId, date: input.date, concept: input.concept, amountCents: input.amountCents, requestKey }), `Gasto «${input.concept}» registrado: ${money(input.amountCents)}.`)} pending={pending} today={report.today} />
          : <button className={`${link} mt-2`} disabled={pending} onClick={() => open({ kind: "add-expense" })} type="button">+ Registrar gasto</button>) : null}
      </section>

      <p className="rounded-xl bg-white p-4 text-sm shadow-sm" data-testid="operating-costs-total">
        Costos imputados al período <strong>{formatIsoDate(report.period.from)}{report.period.from === report.period.to ? "" : ` – ${formatIsoDate(report.period.to)}`}</strong>:{" "}
        <strong>{money(report.operatingCostCents)}</strong> <span className="text-stone-500">({money(report.recurringCents)} de costos mensuales + {money(report.expenseCents)} de gastos{report.labor ? ` + ${money(report.labor.costCents)} de personal` : ""})</span>
      </p>
    </div> : null}
  </OverlayDialog>;
}

const STATUS_LABEL = { ACTIVE: null, SCHEDULED: "Programado", ENDED: "Dado de baja" } as const;

function MonthlyRow({ cost, today, canWrite, laborOverlap, historyOpen, onToggleHistory, onOpen, panel, children }: {
  cost: RecurringCost; today: string; canWrite: boolean; laborOverlap: boolean; historyOpen: boolean; onToggleHistory: () => void; onOpen: (panel: Panel) => void; panel: Panel | null; children: ReactNode;
}) {
  const label = STATUS_LABEL[cost.status];
  const versions = visibleHistory(cost);
  const busy = panel !== null;
  return <li className="px-4 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0"><strong>{cost.name}</strong>{label ? <span className="ml-2 rounded-full bg-stone-200 px-2 py-0.5 text-xs font-bold text-stone-700">{label}</span> : null}</div>
      <strong className="whitespace-nowrap">{monthlyLabel(cost.amountCents)}</strong>
    </div>
    <p className="mt-0.5 text-xs text-stone-500">
      {cost.status === "ENDED" && cost.lastDay ? `Rigió hasta el ${formatIsoDate(cost.lastDay)}` : `Rige desde el ${formatIsoDate(cost.amountFrom)}`}
      {cost.lastDay && cost.status !== "ENDED" ? ` · hasta el ${formatIsoDate(cost.lastDay)}` : ""} · En el período: {money(cost.imputedCents)}
    </p>
    {laborOverlap ? <p className="mt-1 text-xs font-bold text-amber-800" data-testid="labor-duplicate-warning">⚠ {LABOR_DUPLICATE_NOTE} Si este costo es el sueldo de una empleada, darlo de baja evita contarlo dos veces.</p> : null}
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      {versions.length > 1 ? <button aria-expanded={historyOpen} className={link} onClick={onToggleHistory} type="button">{historyOpen ? "Ocultar historial" : "Ver historial"}</button> : null}
      {canWrite ? <>
        <button className={link} disabled={busy && panel.kind !== "change-cost"} onClick={() => onOpen({ kind: "change-cost", costId: cost.id })} type="button">{cost.status === "ENDED" ? "Reactivar" : "Cambiar importe"}</button>
        {cost.status !== "ENDED" ? <button className={link} disabled={busy && panel.kind !== "end-cost"} onClick={() => onOpen({ kind: "end-cost", costId: cost.id })} type="button">Dar de baja</button> : null}
      </> : null}
    </div>
    {historyOpen ? <ul className="mt-2 space-y-0.5 rounded-lg bg-stone-50 p-2 text-xs text-stone-600" data-testid="cost-history">{versions.map((version) => <li key={version.id}>{describeVersion(version, today)}</li>)}</ul> : null}
    {children}
  </li>;
}

function ExpenseRow({ expense, today, canWrite, onOpen, panel, children }: { expense: BranchExpense; today: string; canWrite: boolean; onOpen: (panel: Panel) => void; panel: Panel | null; children: ReactNode }) {
  return <li className="px-4 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0"><span className="mr-2 font-mono text-sm text-stone-500">{formatShortDate(expense.date, today)}</span><strong>{expense.concept}</strong></div>
      <strong className="whitespace-nowrap">{money(expense.amountCents)}</strong>
    </div>
    <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className={`text-xs ${expense.inPeriod ? "font-bold text-emerald-700" : "text-stone-500"}`}>{expense.inPeriod ? "Cuenta en este período" : "Fuera del período"}</span>
      {canWrite ? <button className={link} disabled={panel !== null && panel.kind !== "void-expense"} onClick={() => onOpen({ kind: "void-expense", expenseId: expense.id })} type="button">Anular</button> : null}
    </div>
    {children}
  </li>;
}

function FormShell({ title, error, children }: { title: string; error: string | null; children: ReactNode }) {
  return <div className="mt-3 space-y-3 rounded-xl border border-stone-200 bg-stone-50 p-3">
    <p className="text-sm font-black">{title}</p>
    {children}
    {error ? <p className="rounded-lg bg-red-50 p-2 text-sm text-red-800" role="alert">{error}</p> : null}
  </div>;
}

function Actions({ pending, label, disabled, onCancel }: { pending: boolean; label: string; disabled?: boolean; onCancel: () => void }) {
  return <div className="flex flex-wrap items-center gap-3">
    <button className={primary} disabled={pending || disabled === true} type="submit">{pending ? "Guardando…" : label}</button>
    <button className={link} disabled={pending} onClick={onCancel} type="button">Cancelar</button>
  </div>;
}

function AddCostForm({ today, pending, error, onSave, onCancel }: {
  today: string; pending: boolean; error: string | null; onCancel: () => void; onSave: (input: { name: string; amountCents: number; from: string }, requestKey: string) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(firstDayOfMonth(today));
  const [localError, setLocalError] = useState<string | null>(null);
  // Una clave por formulario abierto: un doble clic o un reintento no crean dos conceptos iguales.
  const [requestKey] = useState(() => crypto.randomUUID());
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseMonthlyForm({ name, amount, from });
    if (!parsed.ok) { setLocalError(parsed.error); return; }
    setLocalError(null);
    onSave(parsed.value, requestKey);
  };
  return <form onSubmit={submit}><FormShell error={localError ?? error} title="Nuevo costo mensual">
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1 text-xs font-bold text-stone-600">Nombre<input className={`${field} font-normal text-stone-900`} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Alquiler" value={name} /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-600">Importe por mes ($)<input className={`${field} text-right font-normal text-stone-900`} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="450000" value={amount} /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-600">Rige desde<input className={`${field} font-normal text-stone-900`} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label>
    </div>
    <Actions label="Guardar costo" onCancel={onCancel} pending={pending} />
  </FormShell></form>;
}

function ChangeCostForm({ cost, today, pending, error, onSave, onCancel }: {
  cost: RecurringCost; today: string; pending: boolean; error: string | null; onCancel: () => void; onSave: (input: { amountCents: number; from: string }) => void;
}) {
  const [amount, setAmount] = useState(centsToField(cost.amountCents));
  const [from, setFrom] = useState(today);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseMonthlyForm({ name: cost.name, amount, from });
    if (!parsed.ok) { setLocalError(parsed.error); return; }
    setLocalError(null);
    onSave({ amountCents: parsed.value.amountCents, from: parsed.value.from });
  };
  return <form onSubmit={submit}><FormShell error={localError ?? error} title={cost.status === "ENDED" ? `Reactivar ${cost.name}` : `Cambiar el importe de ${cost.name}`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-xs font-bold text-stone-600">Importe nuevo por mes ($)<input className={`${field} text-right font-normal text-stone-900`} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} value={amount} /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-600">Rige desde<input className={`${field} font-normal text-stone-900`} onChange={(event) => setFrom(event.target.value)} type="date" value={from} /></label>
    </div>
    <p className="text-xs text-stone-500">Los días anteriores a esa fecha conservan el importe que tenían.</p>
    <Actions label="Guardar cambio" onCancel={onCancel} pending={pending} />
  </FormShell></form>;
}

function EndCostForm({ cost, today, pending, error, onConfirm, onCancel }: { cost: RecurringCost; today: string; pending: boolean; error: string | null; onCancel: () => void; onConfirm: (date: string) => void }) {
  const [date, setDate] = useState(today);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseEndForm({ date });
    if (!parsed.ok) { setLocalError(parsed.error); return; }
    setLocalError(null);
    onConfirm(parsed.value);
  };
  return <form onSubmit={submit}><FormShell error={localError ?? error} title={`Dar de baja ${cost.name}`}>
    <label className="grid max-w-56 gap-1 text-xs font-bold text-stone-600">Deja de aplicarse desde<input className={`${field} font-normal text-stone-900`} onChange={(event) => setDate(event.target.value)} type="date" value={date} /></label>
    <p className="text-xs text-stone-500">El historial queda: los períodos anteriores siguen mostrando este costo.</p>
    <Actions label="Dar de baja" onCancel={onCancel} pending={pending} />
  </FormShell></form>;
}

function AddExpenseForm({ today, pending, error, onSave, onCancel }: {
  today: string; pending: boolean; error: string | null; onCancel: () => void; onSave: (input: { date: string; concept: string; amountCents: number }, requestKey: string) => void;
}) {
  const [date, setDate] = useState(today);
  const [concept, setConcept] = useState("");
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseExpenseForm({ date, concept, amount }, today);
    if (!parsed.ok) { setLocalError(parsed.error); return; }
    setLocalError(null);
    onSave(parsed.value, requestKey);
  };
  return <form onSubmit={submit}><FormShell error={localError ?? error} title="Nuevo gasto">
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1 text-xs font-bold text-stone-600">Fecha<input className={`${field} font-normal text-stone-900`} max={today} onChange={(event) => setDate(event.target.value)} type="date" value={date} /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-600">Concepto<input className={`${field} font-normal text-stone-900`} maxLength={120} onChange={(event) => setConcept(event.target.value)} placeholder="Reparación heladera" value={concept} /></label>
      <label className="grid gap-1 text-xs font-bold text-stone-600">Importe ($)<input className={`${field} text-right font-normal text-stone-900`} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="70000" value={amount} /></label>
    </div>
    <Actions label="Registrar gasto" onCancel={onCancel} pending={pending} />
  </FormShell></form>;
}

function VoidExpenseForm({ pending, error, onConfirm, onCancel }: { pending: boolean; error: string | null; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("Cargado por error");
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (reason.trim().length < 1) { setLocalError("Escribí el motivo de la anulación."); return; }
    setLocalError(null);
    onConfirm(reason.trim());
  };
  return <form onSubmit={submit}><FormShell error={localError ?? error} title="Anular gasto">
    <label className="grid gap-1 text-xs font-bold text-stone-600">Motivo<input className={`${field} font-normal text-stone-900`} maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
    <p className="text-xs text-stone-500">El gasto deja de descontarse del resultado. Queda registrado quién lo anuló y por qué.</p>
    <Actions label="Anular gasto" onCancel={onCancel} pending={pending} />
  </FormShell></form>;
}
