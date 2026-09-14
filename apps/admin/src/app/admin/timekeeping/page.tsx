import { formatCurrency } from "@carnicerias/business-logic";

import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { correctShiftAction, setHourlyRateAction, setMaxShiftHoursAction } from "../actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";
interface Shift { id: string; employeeId: string; employeeName: string; branchId: string; branchName: string; clockInAt: string; clockOutAt: string | null; clockInSource: string; clockOutSource: string | null; status: string; durationSeconds: number; estimatedCents: number; rateComplete: boolean }
interface EmployeeTotal { employee_id: string; display_name: string; duration_seconds: number; estimated_cents: number; rate_complete: boolean }
interface Report { from: string; to: string; maxShiftHours: number; employees: EmployeeTotal[]; shifts: Shift[]; review: Shift[] }

function isoDate(date: Date) { return date.toISOString().slice(0, 10); }
function duration(seconds: number) { const minutes = Math.floor(seconds / 60); return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, "0")} min`; }
function employeeDays(shifts: Shift[], employeeId: string, timezone: string) {
  const days = new Map<string, number>();
  for (const shift of shifts) if (shift.employeeId === employeeId && shift.status === "CLOSED") {
    const day = new Date(shift.clockInAt).toLocaleDateString("es-AR", { timeZone: timezone, weekday: "short", day: "2-digit", month: "2-digit" });
    days.set(day, (days.get(day) ?? 0) + shift.durationSeconds);
  }
  return [...days.entries()];
}

export default async function TimekeepingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const today = new Date(); const monday = new Date(today); monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const from = value("from") || isoDate(monday); const to = value("to") || isoDate(today);
  const employee = value("employee") || null; const branch = value("branch") || null;
  const supabase = await createClient();
  const [{ data, error }, { data: members }, { data: branches }] = await Promise.all([
    supabase.rpc("get_timekeeping_report", { p_from: from, p_to: to, p_employee_id: employee, p_branch_id: branch }),
    supabase.rpc("list_organization_members", {}),
    supabase.from("branches").select("id,name").eq("organization_id", context.organizationId).eq("active", true).order("name")
  ]);
  const report = (data ?? { from, to, maxShiftHours: 12, employees: [], shifts: [], review: [] }) as unknown as Report;
  const employeeMembers = (members ?? []).filter((member) => member.role_key === "employee");
  const dateTime = (date: string) => new Date(date).toLocaleString("es-AR", { timeZone: context.timezone, dateStyle: "short", timeStyle: "short" });

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    {error ? <p className="rounded-xl bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <form className="grid gap-3 rounded-2xl border bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
      <input className={input} defaultValue={from} name="from" type="date" /><input className={input} defaultValue={to} name="to" type="date" />
      <select className={input} defaultValue={employee ?? ""} name="employee"><option value="">Todos los empleados</option>{employeeMembers.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.display_name}</option>)}</select>
      <select className={input} defaultValue={branch ?? ""} name="branch"><option value="">Todas las sucursales</option>{(branches ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button className="rounded-lg bg-stone-900 px-4 py-2 font-bold text-white">Filtrar</button>
    </form>
    <form action={setHourlyRateAction} className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border bg-white p-3 text-sm shadow-sm"><label className="grid gap-1 font-bold">Empleado<select className={input} name="employee_id" required><option value="">Seleccionar</option>{employeeMembers.map((member) => <option key={member.profile_id} value={member.profile_id}>{member.display_name}</option>)}</select></label><label className="grid gap-1 font-bold">Tarifa por hora<input className={input} name="rate" placeholder="$ 5.000" required /></label><label className="grid gap-1 font-bold">Vigente desde<input className={input} defaultValue={`${to}T00:00`} name="valid_from" required type="datetime-local" /></label><button className="rounded-lg border px-4 py-2 font-bold">Guardar tarifa</button><p className="basis-full text-xs text-stone-500">Importe estimado interno: horas exactas × tarifa histórica. No es una liquidación laboral.</p></form>

    <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-black text-amber-950">⚠ Turnos pendientes de revisión</h2><p className="text-sm text-amber-800">No se contabilizan como horas pagables hasta corregirlos.</p></div><form action={setMaxShiftHoursAction} className="flex items-center gap-2 text-sm"><label>Máximo normal <input className={`${input} w-20`} defaultValue={report.maxShiftHours} max={24} min={1} name="hours" type="number" /></label><button className="rounded-lg border border-amber-300 px-3 py-2 font-bold">Guardar</button></form></div>
      <div className="mt-4 grid gap-3">{report.review.map((shift) => <article className="rounded-xl bg-white p-4" key={shift.id}><strong>{shift.employeeName} · {shift.branchName}</strong><p className="text-sm text-stone-600">Entrada {dateTime(shift.clockInAt)}{shift.clockInSource === "OFFLINE" ? " · registrado offline" : ""}</p><form action={correctShiftAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]"><input name="shift_id" type="hidden" value={shift.id} /><input className={input} name="clock_out_at" required type="datetime-local" /><input className={input} minLength={3} name="reason" placeholder="Motivo obligatorio" required /><button className="rounded-lg bg-amber-800 px-4 py-2 font-bold text-white">Corregir salida</button></form></article>)}{!report.review.length ? <p className="text-sm text-amber-800">No hay turnos pendientes.</p> : null}</div>
    </section>

    <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{report.employees.map((item) => <article className="rounded-2xl border bg-white p-5 shadow-sm" key={item.employee_id}><h2 className="font-black">{item.display_name}</h2><div className="mt-3 divide-y text-sm">{employeeDays(report.shifts,item.employee_id,context.timezone).map(([day,seconds]) => <div className="flex justify-between py-1.5" key={day}><span className="capitalize text-stone-500">{day}</span><strong>{duration(seconds)}</strong></div>)}</div><p className="mt-3 text-2xl font-black">{duration(item.duration_seconds)}</p><p className="text-sm text-stone-500">Pago estimado por horas</p><p className="text-xl font-black text-rose-800">{formatCurrency(BigInt(item.estimated_cents))}</p>{!item.rate_complete ? <p className="mt-2 text-xs font-bold text-amber-700">Período parcialmente sin tarifa configurada</p> : null}
        <form action={setHourlyRateAction} className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-2"><input name="employee_id" type="hidden" value={item.employee_id} /><input className={input} name="rate" placeholder="Tarifa por hora" required /><input className={input} defaultValue={`${to}T00:00`} name="valid_from" required type="datetime-local" /><button className="rounded-lg border px-3 py-2 text-sm font-bold sm:col-span-2">Guardar nueva tarifa</button></form></article>)}{!report.employees.length ? <p className="rounded-2xl border bg-white p-8 text-stone-500">No hay horas cerradas en el período.</p> : null}</section>

    <section className="mt-6 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b bg-stone-50 text-stone-500"><tr><th className="p-3">Empleado</th><th className="p-3">Sucursal</th><th className="p-3">Entrada</th><th className="p-3">Salida</th><th className="p-3">Duración</th><th className="p-3">Origen</th><th className="p-3">Importe estimado</th></tr></thead><tbody>{report.shifts.filter((shift) => shift.status === "CLOSED").map((shift) => <tr className="border-b" key={shift.id}><td className="p-3 font-bold">{shift.employeeName}</td><td className="p-3">{shift.branchName}</td><td className="p-3">{dateTime(shift.clockInAt)}</td><td className="p-3">{shift.clockOutAt ? dateTime(shift.clockOutAt) : "—"}</td><td className="p-3">{duration(shift.durationSeconds)}</td><td className="p-3">{shift.clockInSource === "OFFLINE" || shift.clockOutSource === "OFFLINE" ? "Offline" : "Online"}</td><td className="p-3 font-bold">{formatCurrency(BigInt(shift.estimatedCents))}</td></tr>)}</tbody></table></section>
  </main>;
}
