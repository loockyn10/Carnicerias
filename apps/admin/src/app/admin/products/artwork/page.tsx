import { ArtworkWorkspace, type ArtworkBranchOption } from "../../../../components/artwork-workspace";
import { SectionTabs } from "../../../../components/section-tabs";
import { SignageSubnav } from "../../../../components/signage-subnav";
import { requireAdminContext } from "../../../../lib/admin";
import { createClient } from "../../../../lib/supabase/server";
import { PRODUCTOS_TABS } from "../../products-tabs";

/** Sucursal que se elige al abrir: «Central» si existe; si no, la primera activa; si no hay ninguna, el precio general. */
function pickDefaultBranch(branches: ArtworkBranchOption[]): string {
  const active = branches.filter((branch) => branch.active);
  return (active.find((branch) => branch.name.trim().toLowerCase() === "central") ?? active[0])?.id ?? "";
}

export default async function ArtworkPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const { data, error } = await supabase.from("branches").select("id, name, active").eq("organization_id", context.organizationId).order("name");
  const branches: ArtworkBranchOption[] = (data ?? []).map((branch) => ({ id: branch.id, name: branch.name, active: branch.active }));

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs active="/admin/products/artwork" tabs={PRODUCTOS_TABS} />
    <SignageSubnav active="pieces" />
    <div className="mt-6">
      <h2 className="text-xl font-black">Piezas para redes, WhatsApp y TV</h2>
      <p className="mt-1 text-sm text-stone-600">Elegí un producto y se arma solo su pieza «Producto protagonista», con el precio y la promoción vigentes del sistema. Descargá Feed o Story en PNG.</p>
    </div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    <ArtworkWorkspace branches={branches} defaultBranchId={pickDefaultBranch(branches)} />
  </main>;
}
