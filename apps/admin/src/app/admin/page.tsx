import { redirect } from "next/navigation";

import { createClient } from "../../lib/supabase/server";
import { logout } from "./actions";

interface DiagnosticItemProps {
  label: string;
  value: string;
}

function DiagnosticItem({ label, value }: DiagnosticItemProps) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-stone-900">{value}</dd>
    </div>
  );
}

export default async function AdminValidationPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login");
  }

  const user = authData.user;
  const [profileResult, membershipResult] = await Promise.all([
    supabase.from("profiles").select("id, display_name, active, created_at").eq("id", user.id).maybeSingle(),
    supabase
      .from("organization_members")
      .select("id, organization_id, profile_id, role_id, status")
      .eq("profile_id", user.id)
      .eq("status", "ACTIVE")
      .limit(1)
      .maybeSingle()
  ]);

  const membership = membershipResult.data;

  if (!membership) {
    return (
      <main className="grid min-h-screen place-items-center bg-stone-100 p-6">
        <section className="w-full max-w-2xl rounded-xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wider text-amber-700">Auth correcto · acceso pendiente</p>
          <h1 className="mt-2 text-2xl font-semibold">El usuario existe, pero todavía no tiene membresía activa</h1>
          <p className="mt-4 text-stone-600">
            Esto es el resultado esperado antes del bootstrap: RLS permite leer el perfil propio, pero no una organización.
          </p>
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            <DiagnosticItem label="Auth user ID" value={user.id} />
            <DiagnosticItem label="Perfil" value={profileResult.data?.display_name ?? profileResult.error?.message ?? "No creado"} />
            <DiagnosticItem label="Membresía" value={membershipResult.error?.message ?? "Sin filas visibles"} />
            <DiagnosticItem label="Email" value={user.email ?? "Sin email"} />
          </dl>
          <form action={logout} className="mt-6">
            <button className="rounded-lg border border-stone-300 px-4 py-2 font-medium hover:bg-stone-50" type="submit">
              Cerrar sesión
            </button>
          </form>
        </section>
      </main>
    );
  }

  const [organizationResult, roleResult, branchesResult, productsResult, pricesResult] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, slug, currency, timezone")
      .eq("id", membership.organization_id)
      .maybeSingle(),
    supabase.from("roles").select("id, key, name").eq("id", membership.role_id).maybeSingle(),
    supabase.from("branches").select("id, name, code").eq("organization_id", membership.organization_id),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", membership.organization_id),
    supabase.from("product_prices").select("id", { count: "exact", head: true }).eq("organization_id", membership.organization_id)
  ]);

  const diagnosticError = [
    profileResult.error,
    membershipResult.error,
    organizationResult.error,
    roleResult.error,
    branchesResult.error,
    productsResult.error,
    pricesResult.error
  ].find((error) => error !== null);

  return (
    <main className="min-h-screen bg-stone-100 p-6 sm:p-10">
      <section className="mx-auto max-w-4xl rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-emerald-700">Fase 1A · validación remota</p>
            <h1 className="mt-2 text-3xl font-semibold text-stone-900">Auth y RLS funcionando</h1>
            <p className="mt-2 text-stone-600">Todas las consultas de esta página usan la sesión del usuario y la publishable key.</p>
          </div>
          <form action={logout}>
            <button className="rounded-lg border border-stone-300 px-4 py-2 font-medium hover:bg-stone-50" type="submit">
              Cerrar sesión
            </button>
          </form>
        </div>

        {diagnosticError ? (
          <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
            Error de consulta RLS: {diagnosticError.message}
          </p>
        ) : null}

        <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DiagnosticItem label="Usuario Auth" value={user.email ?? user.id} />
          <DiagnosticItem label="Perfil" value={profileResult.data?.display_name ?? "No visible"} />
          <DiagnosticItem label="Organización" value={organizationResult.data?.name ?? "No visible"} />
          <DiagnosticItem label="Membresía" value={membership.status} />
          <DiagnosticItem label="Rol" value={roleResult.data ? `${roleResult.data.name} (${roleResult.data.key})` : "No visible"} />
          <DiagnosticItem
            label="Sucursales visibles"
            value={branchesResult.data?.length ? branchesResult.data.map((branch) => branch.name).join(", ") : "Ninguna"}
          />
          <DiagnosticItem label="Productos visibles" value={String(productsResult.count ?? 0)} />
          <DiagnosticItem label="Precios visibles" value={String(pricesResult.count ?? 0)} />
          <DiagnosticItem label="Moneda / zona" value={`${organizationResult.data?.currency ?? "—"} · ${organizationResult.data?.timezone ?? "—"}`} />
        </dl>
      </section>
    </main>
  );
}
