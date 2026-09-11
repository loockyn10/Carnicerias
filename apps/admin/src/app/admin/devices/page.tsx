import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";
import { setDeviceStatusAction } from "../actions";

export default async function DevicesPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [{ data: devices, error }, { data: branches }, { data: profiles }] = await Promise.all([
    supabase.from("pos_devices").select("id, branch_id, label, status, registered_by, registered_at, last_seen_at").eq("organization_id", context.organizationId).order("last_seen_at", { ascending: false }),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId),
    supabase.from("profiles").select("id, display_name")
  ]);
  const branchNames = new Map((branches ?? []).map((item) => [item.id, item.name]));
  const profileNames = new Map((profiles ?? []).map((item) => [item.id, item.display_name]));
  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Terminales</p><h1 className="mt-1 text-3xl font-black">Dispositivos POS</h1><p className="mt-2 text-stone-600">Desactivar corta próximos pulls y sincronizaciones; no borra ventas ni recibos idempotentes.</p>{error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <section className="mt-7 overflow-x-auto rounded-2xl border bg-white shadow-sm"><table className="w-full min-w-[850px] text-left text-sm"><thead className="bg-stone-50"><tr><th className="p-4">Equipo</th><th className="p-4">Sucursal</th><th className="p-4">Registrado por</th><th className="p-4">Alta</th><th className="p-4">Última actividad</th><th className="p-4">Estado</th><th className="p-4">Acción</th></tr></thead><tbody>{(devices ?? []).map((device) => <tr className="border-t" key={device.id}><td className="p-4"><strong>{device.label ?? "POS"}</strong><p className="font-mono text-xs text-stone-500">{device.id}</p></td><td className="p-4">{branchNames.get(device.branch_id)}</td><td className="p-4">{profileNames.get(device.registered_by)}</td><td className="p-4">{new Date(device.registered_at).toLocaleString("es-AR", { timeZone: context.timezone })}</td><td className="p-4">{new Date(device.last_seen_at).toLocaleString("es-AR", { timeZone: context.timezone })}</td><td className={`p-4 font-black ${device.status === "ACTIVE" ? "text-emerald-700" : "text-red-700"}`}>{device.status === "ACTIVE" ? "ACTIVO" : "DESHABILITADO"}</td><td className="p-4"><form action={setDeviceStatusAction}><input name="device_id" type="hidden" value={device.id} /><input name="status" type="hidden" value={device.status === "ACTIVE" ? "DISABLED" : "ACTIVE"} /><button className="rounded-lg border px-3 py-2 font-bold">{device.status === "ACTIVE" ? "Desactivar" : "Reactivar"}</button></form></td></tr>)}{!devices?.length ? <tr><td className="p-8 text-center text-stone-500" colSpan={7}>Todavía no hay dispositivos registrados.</td></tr> : null}</tbody></table></section>
  </main>;
}
