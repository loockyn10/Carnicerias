import Link from "next/link";

import { ImportHistory } from "../../../components/import-history";
import { ImportWizard } from "../../../components/import-wizard";
import { requireAdminContext } from "../../../lib/admin";
import { groupImportRuns } from "../../../lib/imports/history";
import { resolveImportDestination } from "../../../lib/imports/destination";
import { createClient } from "../../../lib/supabase/server";

// Preview/apply of a 1,000-row batch are single database calls; leave room for them on slow links.
export const maxDuration = 60;

export default async function ImportsPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [branchesResult, organizationResult, categoriesResult, batchesResult] = await Promise.all([
    supabase.from("branches").select("id, name, code, active").eq("organization_id", context.organizationId),
    supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single(),
    supabase.from("categories").select("name").eq("organization_id", context.organizationId).limit(2000),
    supabase.from("import_batches")
      .select("id, source_system, entity_type, file_name, status, options, preview_summary, applied_summary, created_at, applied_at")
      .eq("organization_id", context.organizationId).order("created_at", { ascending: false }).limit(500)
  ]);

  const destination = resolveImportDestination(branchesResult.data ?? [], organizationResult.data?.production_branch_id ?? null);
  // A preview the operator cancelled (or replaced) is not an import: it stays in the database as an
  // audit trail but is not listed.
  const runs = groupImportRuns(batchesResult.data ?? []).filter((run) => run.status !== "CANCELLED");
  const loadError = branchesResult.error?.message ?? batchesResult.error?.message ?? null;

  return <main className="mx-auto max-w-6xl p-5 sm:p-8">
    <nav aria-label="Ruta" className="text-sm text-stone-500">
      <Link className="hover:text-rose-800" href="/admin">Inicio</Link> / <Link className="hover:text-rose-800" href="/admin/settings">Configuración</Link> / <span className="text-stone-700">Importación de productos</span>
    </nav>
    <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Importación de productos</h1>
        <p className="mt-2 text-stone-600">Importá productos, precios, costos y proveedores desde SimplyGest u otros archivos. El stock no se importa.</p>
      </div>
      <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-50" href="/admin/settings">← Volver a Configuración</Link>
    </div>

    {loadError ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{loadError}</p> : null}

    <div className="mt-6">
      <ImportWizard
        destination={destination.kind === "ok" ? { name: destination.branch.name, code: destination.branch.code } : null}
        destinationProblem={destination.kind === "missing" ? destination.reason : null}
        existingCategoryNames={(categoriesResult.data ?? []).map((category) => category.name)}
      />
    </div>

    <ImportHistory runs={runs} timezone={context.timezone} />
  </main>;
}
