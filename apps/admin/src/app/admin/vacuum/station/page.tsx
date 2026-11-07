import { SectionTabs } from "../../../../components/section-tabs";
import { VacuumStation } from "../../../../components/vacuum-station";
import { requireAdminContext } from "../../../../lib/admin";
import { createPerfLogger } from "../../../../lib/perf";
import { createClient } from "../../../../lib/supabase/server";
import { isUuid } from "../../../../lib/uuid";
import { parseVacuumSettings } from "../../../../lib/vacuum";
import { VACUUM_TABS } from "../../../../lib/vacuum-tabs";
import { isSimulatorAllowed } from "../../../../lib/vacuum-station/simulator";

/**
 * Envasados → Estación de producción: pantalla de trabajo para envasar durante horas con la balanza conectada por Web Serial. Carga en el servidor las
 * sucursales, la configuración comercial de Envasados, los cortes habilitados (con precio, categoría y frecuencia) y el resumen del día; la balanza, la
 * impresora y la configuración del equipo viven en el navegador (ver `components/vacuum-station.tsx`).
 */
export default async function VacuumStationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum/station");
  const context = await requireAdminContext();
  const params = await searchParams;
  const requestedBranch = typeof params.branch === "string" && isUuid(params.branch) ? params.branch : "";

  const supabase = await createClient();
  const [branchesResult, orgResult, settingsResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("productionBranch", supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single()),
    perf.measure("settings", supabase.rpc("get_vacuum_settings"))
  ]);
  const branches = branchesResult.data ?? [];
  const branchId = branches.find((branch) => branch.id === requestedBranch)?.id ?? branches.find((branch) => branch.id === orgResult.data?.production_branch_id)?.id ?? branches[0]?.id ?? "";
  const [productsResult, summaryResult] = branchId
    ? await Promise.all([
      perf.measure("products", supabase.rpc("list_vacuum_station_products", { p_branch_id: branchId })),
      perf.measure("summary", supabase.rpc("get_vacuum_station_summary", { p_branch_id: branchId }))
    ])
    : [{ data: [], error: null }, { data: {}, error: null }];
  perf.flush();
  const error = branchesResult.error ?? settingsResult.error ?? productsResult.error ?? summaryResult.error;

  return <main className="mx-auto max-w-[96rem] p-4 sm:p-6">
    <p className="max-w-3xl text-stone-600">Elegí el corte, apoyá el paquete en la balanza y la estación registra e imprime sola. Para cambiar de corte, elegí otro.</p>
    <SectionTabs tabs={VACUUM_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {branches.length === 0 ? <p className="mt-6 rounded-lg bg-amber-50 p-4 text-amber-900">No hay sucursales activas.</p> : <div className="mt-6">
      <VacuumStation
        branches={branches} defaultBranchId={branchId} initialProducts={productsResult.data ?? []} initialSummary={summaryResult.data ?? {}}
        settings={parseVacuumSettings(settingsResult.data ?? {})} simulatorAllowed={isSimulatorAllowed()} timezone={context.timezone} />
    </div>}
  </main>;
}
