import { requireAdminContext } from "../../../lib/admin";
import { createClient } from "../../../lib/supabase/server";

export default async function AuditPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [{ data: logs, error }, { data: branches }, { data: profiles }] = await Promise.all([
    supabase.from("audit_logs").select("id, branch_id, actor_profile_id, event_type, entity_type, entity_id, before_data, after_data, created_at").eq("organization_id", context.organizationId).order("created_at", { ascending: false }).limit(200),
    supabase.from("branches").select("id, name").eq("organization_id", context.organizationId),
    supabase.from("profiles").select("id, display_name")
  ]);
  const branchNames = new Map((branches ?? []).map((item) => [item.id, item.name]));
  const profileNames = new Map((profiles ?? []).map((item) => [item.id, item.display_name]));
  return <main className="mx-auto max-w-7xl p-5 sm:p-10"><p className="text-sm font-bold uppercase tracking-wider text-rose-800">Trazabilidad</p><h1 className="mt-1 text-3xl font-black">Auditoría</h1><p className="mt-2 text-stone-600">Últimos 200 eventos. El navegador sólo tiene permiso de lectura.</p>{error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}<section className="mt-7 space-y-3">{(logs ?? []).map((log) => <article className="rounded-xl border bg-white p-4 shadow-sm" key={log.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><strong>{log.event_type}</strong><p className="text-sm text-stone-500">{log.entity_type} · {log.entity_id?.slice(0, 8) ?? "—"} · {log.branch_id ? branchNames.get(log.branch_id) : "Organización"}</p></div><div className="text-right text-sm"><p>{log.actor_profile_id ? profileNames.get(log.actor_profile_id) ?? log.actor_profile_id.slice(0, 8) : "Sistema"}</p><time className="text-stone-500">{new Date(log.created_at).toLocaleString("es-AR", { timeZone: context.timezone })}</time></div></div><details className="mt-3"><summary className="cursor-pointer text-sm font-bold text-rose-800">Datos</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-stone-950 p-3 text-xs text-stone-100">{JSON.stringify({ before: log.before_data, after: log.after_data }, null, 2)}</pre></details></article>)}{!logs?.length ? <p className="text-stone-500">No hay eventos todavía.</p> : null}</section></main>;
}
