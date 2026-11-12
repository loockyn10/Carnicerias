import { NewDeliveryWorkspace, type SiteOption } from "../../../../../components/distribution/new-delivery-workspace";
import { SectionTabs } from "../../../../../components/section-tabs";
import { requireAdminContext } from "../../../../../lib/admin";
import { localDateString } from "../../../../../lib/date-range";
import { parseDelivery, parseDistributionClients } from "../../../../../lib/distribution/model";
import { DISTRIBUTION_TABS } from "../../../../../lib/distribution/tabs";
import { createClient } from "../../../../../lib/supabase/server";
import { isUuid } from "../../../../../lib/uuid";
import { VACUUM_TABS } from "../../../../../lib/vacuum-tabs";

/** Envasados → Distribución → Nueva entrega (también continúa un borrador con `?draft=`). */
export default async function NewDeliveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const draftId = typeof params.draft === "string" && isUuid(params.draft) ? params.draft : "";
  const siteParam = typeof params.site === "string" && isUuid(params.site) ? params.site : "";

  const supabase = await createClient();
  const [clientsResult, orgResult, draftResult] = await Promise.all([
    supabase.rpc("list_distribution_clients"),
    supabase.from("organizations").select("production_branch_id").eq("id", context.organizationId).single(),
    draftId ? supabase.rpc("get_distribution_delivery", { p_delivery_id: draftId }) : Promise.resolve({ data: null, error: null })
  ]);
  const clients = parseDistributionClients(clientsResult.data);
  const sites: SiteOption[] = clients.filter((client) => client.active).flatMap((client) => client.sites.filter((site) => site.active).map((site) => ({
    id: site.id, clientName: client.tradeName, siteName: site.name, mode: site.effectiveMode, restockWeekday: site.restockWeekday, draftId: site.draftId, lastDelivery: site.lastDelivery
  })));
  const productionBranchId = orgResult.data?.production_branch_id ?? null;
  let originBranch: { id: string; name: string } | null = null;
  if (productionBranchId) {
    const branch = await supabase.from("branches").select("id, name").eq("id", productionBranchId).eq("organization_id", context.organizationId).maybeSingle();
    originBranch = branch.data ?? null;
  }
  const error = clientsResult.error ?? draftResult.error;

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <p className="max-w-3xl text-stone-600">Elegí el supermercado y la fecha, agregá los paquetes que salen, revisá el detalle y confirmá el despacho. Hasta confirmar, los paquetes sólo quedan reservados.</p>
    <SectionTabs active="/admin/vacuum/distribution" tabs={VACUUM_TABS} />
    <SectionTabs tabs={DISTRIBUTION_TABS} />
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {sites.length === 0 && !error ? <p className="mt-6 rounded-lg bg-amber-50 p-4 text-amber-900">Todavía no hay establecimientos activos. Cargalos en <a className="font-bold underline" href="/admin/vacuum/distribution/clients">Supermercados</a>.</p> : <div className="mt-6">
      <NewDeliveryWorkspace initialDraft={parseDelivery(draftResult.data)} initialSiteId={siteParam || null} key={draftId || siteParam || "new"} originBranch={originBranch} sites={sites} today={localDateString(context.timezone)} />
    </div>}
  </main>;
}
