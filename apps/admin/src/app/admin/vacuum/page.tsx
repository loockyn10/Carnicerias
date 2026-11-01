import Link from "next/link";

import { SectionTabs } from "../../../components/section-tabs";
import { VacuumReprintButtons } from "../../../components/vacuum-reprint-buttons";
import { VacuumWorkspace } from "../../../components/vacuum-workspace";
import { requireAdminContext } from "../../../lib/admin";
import { localDateString } from "../../../lib/date-range";
import { createPerfLogger } from "../../../lib/perf";
import { moneyText, parseVacuumPackagesPage, weightText, formatIsoDate } from "../../../lib/vacuum";
import { VACUUM_TABS } from "../../../lib/vacuum-tabs";
import { createClient } from "../../../lib/supabase/server";
import { isUuid } from "../../../lib/uuid";

/**
 * Envasados → Nuevo paquete: la pantalla de trabajo. Carga en paralelo sucursales, cortes habilitados (con precio/kg de la sucursal), configuración y
 * los últimos paquetes; el resto (peso, importe, EAN, vista previa) se calcula en el navegador a cada tecla.
 */
export default async function VacuumPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const perf = createPerfLogger("/admin/vacuum");
  const context = await requireAdminContext();
  const params = await searchParams;
  const requestedBranch = typeof params.branch === "string" && isUuid(params.branch) ? params.branch : "";

  const supabase = await createClient();
  const [branchesResult, orgResult, settingsResult, recentResult] = await Promise.all([
    perf.measure("branches", supabase.from("branches").select("id, name").eq("organization_id", context.organizationId).eq("active", true).order("name")),
    perf.measure("productionBranch", supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single()),
    perf.measure("settings", supabase.rpc("get_vacuum_settings")),
    perf.measure("recent", supabase.rpc("list_vacuum_packages_page", { p_limit: 5 }))
  ]);
  const branches = branchesResult.data ?? [];
  const branchId = branches.find((branch) => branch.id === requestedBranch)?.id ?? branches.find((branch) => branch.id === orgResult.data?.production_branch_id)?.id ?? branches[0]?.id ?? "";
  const productsResult = branchId ? await perf.measure("products", supabase.rpc("search_vacuum_products", { p_branch_id: branchId, p_limit: 30 })) : { data: [], error: null };
  perf.flush();
  const error = branchesResult.error ?? settingsResult.error ?? productsResult.error ?? recentResult.error;
  const recent = parseVacuumPackagesPage(recentResult.data);

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <p className="max-w-3xl text-stone-600">Preparar paquetes de cortes envasados al vacío e imprimir sus dos etiquetas térmicas: la informativa y la de precio.</p>
    <SectionTabs tabs={VACUUM_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {branches.length === 0 ? <p className="mt-6 rounded-lg bg-amber-50 p-4 text-amber-900">No hay sucursales activas.</p> : <div className="mt-6">
      <VacuumWorkspace branches={branches} defaultBranchId={branchId} initialProducts={productsResult.data ?? []} key={branchId} settings={settingsResult.data ?? {}} today={localDateString(context.timezone)} />
    </div>}

    <section className="mt-8 rounded-xl bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-black">Últimos envasados</h2><Link className="text-sm font-bold text-rose-800 hover:underline" href="/admin/vacuum/recent">Ver todos →</Link></div>
      {recent.rows.length === 0 ? <p className="mt-3 text-sm text-stone-500">Todavía no se envasó ningún paquete.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><tbody>{recent.rows.map((row) => (
        <tr className="border-t border-stone-100" key={row.id}>
          <td className="py-2 pr-3"><strong>{row.productName}</strong><span className="block text-xs text-stone-500">{row.lot}</span></td>
          <td className="py-2 pr-3">{weightText(row.weightGrams)}</td><td className="py-2 pr-3 font-bold">{moneyText(row.totalCents)}</td>
          <td className="py-2 pr-3 text-xs text-stone-500">Elab. {formatIsoDate(row.packedOn)} · Venc. {formatIsoDate(row.expiresOn)}</td>
          <td className="py-2"><VacuumReprintButtons compact packageId={row.id} /></td>
        </tr>
      ))}</tbody></table></div>}
    </section>
  </main>;
}
