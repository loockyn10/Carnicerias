import { SectionTabs } from "../../../../components/section-tabs";
import { SignageScreens, type BranchOption } from "../../../../components/signage-screens";
import { SignageSubnav } from "../../../../components/signage-subnav";
import { requireAdminContext } from "../../../../lib/admin";
import { parseFolders } from "../../../../lib/artwork-folders";
import { parseDisplaysOverview } from "../../../../lib/signage-overview";
import { createClient } from "../../../../lib/supabase/server";
import { PRODUCTOS_TABS } from "../../products-tabs";

export default async function SignagePage() {
  const context = await requireAdminContext();
  const supabase = await createClient();

  // Todo en pocas consultas (nada de una por pantalla): sucursales, las carpetas y el resumen de las pantallas, que sale del MISMO payload
  // que reproduce el televisor (cuántas ofertas vigentes tiene hoy cada una).
  const [overviewResult, foldersResult, branchesResult] = await Promise.all([
    supabase.rpc("get_signage_displays_overview"),
    supabase.rpc("get_signage_folders"),
    supabase.from("branches").select("id, name, active").eq("organization_id", context.organizationId).order("name")
  ]);
  const displays = overviewResult.error ? [] : parseDisplaysOverview(overviewResult.data);
  const folders = foldersResult.error ? [] : parseFolders(foldersResult.data);
  const error = [overviewResult.error, branchesResult.error].find(Boolean);
  const branches: BranchOption[] = (branchesResult.data ?? []).map((branch) => ({ id: branch.id, name: branch.name, active: branch.active }));

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs active="/admin/products/artwork" tabs={PRODUCTOS_TABS} />
    <SignageSubnav active="screens" />
    <div className="mt-6">
      <h2 className="text-xl font-black">Pantallas TV</h2>
      <p className="mt-1 text-sm text-stone-600">Las promociones que cargás en Promociones aparecen solas en el televisor, con el precio de hoy. No hay que armar ninguna lista.</p>
    </div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <SignageScreens branches={branches} displays={displays} folders={folders} />
  </main>;
}
