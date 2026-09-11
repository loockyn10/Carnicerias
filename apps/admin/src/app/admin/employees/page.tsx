import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { manageMemberAction } from "../actions";

const input = "rounded-lg border border-stone-300 bg-white px-3 py-2";

export default async function EmployeesPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [{ data: members, error }, { data: branches }] = await Promise.all([
    supabase.rpc("list_organization_members", {}),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")
  ]);

  return <main className="mx-auto max-w-7xl p-5 sm:p-10">
    <p className="text-sm font-bold uppercase tracking-wider text-rose-800">Accesos</p><h1 className="mt-1 text-3xl font-black">Empleados</h1>
    <p className="mt-2 max-w-3xl text-stone-600">Primero creá y confirmá el usuario en Supabase Auth. Después asocialo aquí por email exacto. El navegador nunca recibe una service role ni puede administrar credenciales de Auth.</p>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Asociar usuario existente</h2>
      <form action={manageMemberAction} className="mt-4 grid gap-3 lg:grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr_auto]">
        <input className={input} name="email" placeholder="email exacto de Auth" required type="email" /><input className={input} name="display_name" placeholder="Nombre" required /><select className={input} defaultValue="employee" name="role_key"><option value="employee">Empleado</option><option value="admin">Administrador</option></select><select className={input} name="branch_id"><option value="">Sin sucursal (sólo admin)</option>{(branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={input} defaultValue="ACTIVE" name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option><option value="INVITED">Invitado</option></select><button className="rounded-lg bg-rose-800 px-4 py-2 font-bold text-white">Guardar</button>
      </form>
    </section>
    <section className="mt-7 rounded-2xl border bg-white p-5 shadow-sm"><h2 className="text-xl font-black">Usuarios de {context.organizationName}</h2><div className="mt-4 space-y-3">{(members ?? []).map((member) => <form action={manageMemberAction} className="grid gap-3 rounded-xl bg-stone-50 p-4 lg:grid-cols-[2fr_1.4fr_1fr_1.4fr_1fr_auto]" key={`${member.profile_id}-${member.branch_id ?? "all"}`}>
      <input name="email" type="hidden" value={member.email} /><div><strong>{member.display_name}</strong><p className="text-sm text-stone-500">{member.email}</p></div><input className={input} defaultValue={member.display_name} name="display_name" required /><select className={input} defaultValue={member.role_key} name="role_key"><option value="employee">Empleado</option><option value="admin">Administrador</option></select><select className={input} defaultValue={member.branch_id ?? ""} name="branch_id"><option value="">Sin sucursal</option>{(branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={input} defaultValue={member.status} name="status"><option value="ACTIVE">Activo</option><option value="DISABLED">Deshabilitado</option><option value="INVITED">Invitado</option></select><button className="rounded-lg border px-3 py-2 font-bold">Actualizar</button>
    </form>)}{!members?.length ? <p className="text-stone-500">Sin miembros.</p> : null}</div></section>
  </main>;
}
