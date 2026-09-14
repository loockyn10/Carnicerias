import { formatCurrency } from "@carnicerias/business-logic";

import { requireAdminContext } from "../../../lib/admin";
import { toOrganizationLocalInput } from "../../../lib/settlements";
import { createClient } from "../../../lib/supabase/server";
import {
  createPosEmployeeAction,
  manageMemberAction,
  setEmployeePinAction,
  setHourlyRateAction,
  updatePosEmployeeAction
} from "../actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export default async function EmployeesPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [{ data: members, error }, { data: branches, error: branchesError }, { data: security, error: securityError }] = await Promise.all([
    supabase.rpc("list_organization_members", {}),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name"),
    supabase.rpc("get_employee_security_status", {})
  ]);
  const pageError = error ?? branchesError ?? securityError;
  const securityByProfile = new Map((security ?? []).map((row) => [row.profile_id, row]));
  const employees = (members ?? []).filter((member) => member.role_key === "employee");
  const administrators = (members ?? []).filter((member) => member.role_key === "admin");
  const rateValidFrom = toOrganizationLocalInput(new Date().toISOString(), context.timezone);

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Personal</p>
    <h1 className="mt-1 text-3xl font-black">Empleados</h1>
    <p className="mt-2 max-w-3xl text-stone-600">Los operadores del POS son empleados internos: no necesitan email, contraseña ni una cuenta individual de Supabase Auth. La sucursal de trabajo la determina cada dispositivo.</p>
    {pageError ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{pageError.message}</p> : null}

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">Crear empleado POS</h2>
      <p className="mt-1 text-sm text-stone-500">El alta guarda nombre, acceso, tarifa inicial y sucursales en una sola operación.</p>
      <form action={createPosEmployeeAction} className="mt-4 grid gap-4 lg:grid-cols-2">
        <label className="grid gap-1 text-sm font-bold">Nombre<input className={input} maxLength={120} name="display_name" required /></label>
        <label className="grid gap-1 text-sm font-bold">PIN POS<input className={input} inputMode="numeric" maxLength={6} minLength={4} name="pin" pattern="[0-9]{4,6}" required type="password" /></label>
        <label className="grid gap-1 text-sm font-bold">Tarifa por hora<input className={input} inputMode="decimal" name="rate" placeholder="$ 5.000" required /></label>
        <label className="grid gap-1 text-sm font-bold">Tarifa vigente desde<input className={input} defaultValue={rateValidFrom} name="rate_valid_from" required type="datetime-local" /></label>
        <fieldset className="rounded-xl border border-stone-200 p-3 lg:col-span-2">
          <legend className="px-1 text-sm font-bold">Sucursales autorizadas</legend>
          <div className="mt-1 flex flex-wrap gap-2">{(branches ?? []).map((branch) => <label className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-sm" key={branch.id}><input name="branch_ids" type="checkbox" value={branch.id} />{branch.name}</label>)}</div>
        </fieldset>
        <label className="grid gap-1 text-sm font-bold">Estado<select className={input} defaultValue="ACTIVE" name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option></select></label>
        <div className="flex items-end"><button className="w-full rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Crear empleado</button></div>
      </form>
    </section>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">Empleados de {context.organizationName}</h2>
      <div className="mt-4 space-y-4">{employees.map((member) => {
        const employeeSecurity = securityByProfile.get(member.profile_id);
        return <article className="rounded-xl bg-stone-50 p-4" key={member.profile_id}>
          <div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{member.display_name}</strong><p className="text-sm text-stone-500">{member.auth_linked ? `${member.email ?? "Cuenta Auth"} · identidad histórica vinculada` : "Empleado interno · sin cuenta Auth"}</p></div><span className={`rounded-full px-2 py-1 text-xs font-black ${member.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-700"}`}>{member.status === "ACTIVE" ? "ACTIVO" : member.status === "INVITED" ? "INVITADO" : "DESHABILITADO"}</span></div>
          <form action={updatePosEmployeeAction} className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr_auto]">
            <input name="employee_id" type="hidden" value={member.profile_id} />
            <label className="grid gap-1 text-sm font-bold">Nombre<input className={input} defaultValue={member.display_name} maxLength={120} name="display_name" required /></label>
            <label className="grid gap-1 text-sm font-bold">Estado<select className={input} defaultValue={member.status} name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option>{member.status === "INVITED" ? <option value="INVITED">Invitado (histórico)</option> : null}</select></label>
            <div className="flex items-end"><button className="rounded-lg border px-4 py-2 font-bold">Guardar datos</button></div>
            <fieldset className="rounded-xl border border-stone-200 bg-white p-3 lg:col-span-3">
              <legend className="px-1 text-sm font-bold">Sucursales autorizadas</legend>
              <div className="mt-1 flex flex-wrap gap-2">{(branches ?? []).map((branch) => <label className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-sm" key={branch.id}><input defaultChecked={member.branch_ids.includes(branch.id)} name="branch_ids" type="checkbox" value={branch.id} />{branch.name}</label>)}</div>
            </fieldset>
          </form>
          <div className="mt-3 grid gap-3 border-t border-stone-200 pt-3 lg:grid-cols-2">
            <form action={setEmployeePinAction} className="flex flex-wrap items-end gap-2"><input name="profile_id" type="hidden" value={member.profile_id} /><label className="grid flex-1 gap-1 text-sm font-bold">PIN POS <span className="font-normal text-stone-500">{employeeSecurity?.has_pin ? "Configurado" : "Sin configurar"}</span><input className={input} inputMode="numeric" maxLength={6} minLength={4} name="pin" pattern="[0-9]{4,6}" placeholder="Nuevo PIN" required type="password" /></label><button className="rounded-lg border px-3 py-2 text-sm font-bold">Cambiar PIN</button></form>
            <form action={setHourlyRateAction} className="flex flex-wrap items-end gap-2"><input name="employee_id" type="hidden" value={member.profile_id} /><label className="grid min-w-36 flex-1 gap-1 text-sm font-bold">Tarifa por hora <span className="font-normal text-stone-500">{employeeSecurity?.current_rate_cents_per_hour == null ? "Sin tarifa vigente" : formatCurrency(BigInt(employeeSecurity.current_rate_cents_per_hour))}</span><input className={input} inputMode="decimal" name="rate" placeholder="$ 5.000" required /></label><label className="grid gap-1 text-sm font-bold">Vigente desde<input className={input} defaultValue={rateValidFrom} name="valid_from" required type="datetime-local" /></label><button className="rounded-lg border px-3 py-2 text-sm font-bold">Nueva tarifa</button></form>
          </div>
        </article>;
      })}{!employees.length ? <p className="text-stone-500">Todavía no hay empleados.</p> : null}</div>
    </section>

    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm">
      <h2 className="text-xl font-black">Acceso administrativo</h2>
      <p className="mt-1 text-sm text-stone-500">Sólo los administradores necesitan una cuenta Auth creada y confirmada previamente.</p>
      <form action={manageMemberAction} className="mt-4 grid gap-3 lg:grid-cols-[2fr_1.5fr_1fr_auto]">
        <input name="role_key" type="hidden" value="admin" /><input className={input} name="email" placeholder="Email exacto de Auth" required type="email" /><input className={input} name="display_name" placeholder="Nombre" required /><select className={input} defaultValue="ACTIVE" name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option><option value="INVITED">Invitado</option></select><button className="rounded-lg border px-4 py-2 font-bold">Asociar administrador</button>
      </form>
      <div className="mt-4 space-y-2">{administrators.map((member) => member.email ? <form action={manageMemberAction} className="grid gap-3 rounded-xl bg-stone-50 p-3 lg:grid-cols-[2fr_1.5fr_1fr_auto]" key={member.profile_id}><input name="email" type="hidden" value={member.email} /><input name="role_key" type="hidden" value="admin" /><div><strong>{member.display_name}</strong><p className="text-sm text-stone-500">{member.email}</p></div><input className={input} defaultValue={member.display_name} name="display_name" required /><select className={input} defaultValue={member.status} name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option><option value="INVITED">Invitado</option></select><button className="rounded-lg border px-3 py-2 font-bold">Actualizar</button></form> : <article className="rounded-xl bg-stone-50 p-3" key={member.profile_id}><strong>{member.display_name}</strong><p className="text-sm text-stone-500">Cuenta Auth desvinculada · identidad histórica conservada</p></article>)}</div>
    </section>
  </main>;
}
