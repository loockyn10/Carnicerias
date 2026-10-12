import { ArtworkHome } from "../../../../components/artwork-folders";
import type { ArtworkBranchOption } from "../../../../components/artwork-workspace";
import { SectionTabs } from "../../../../components/section-tabs";
import { SignageSubnav } from "../../../../components/signage-subnav";
import { requireAdminContext } from "../../../../lib/admin";
import { parseFolders } from "../../../../lib/artwork-folders";
import { createClient } from "../../../../lib/supabase/server";
import { PRODUCTOS_TABS } from "../../products-tabs";

/** Sucursal que se elige al abrir: «Central» si existe; si no, la primera activa; si no hay ninguna, el precio general. */
function pickDefaultBranch(branches: ArtworkBranchOption[]): string {
  const active = branches.filter((branch) => branch.active);
  return (active.find((branch) => branch.name.trim().toLowerCase() === "central") ?? active[0])?.id ?? "";
}

export default async function ArtworkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const context = await requireAdminContext();
  const params = await searchParams;
  const supabase = await createClient();
  const [branchesResult, foldersResult] = await Promise.all([
    supabase.from("branches").select("id, name, active").eq("organization_id", context.organizationId).order("name"),
    // Las carpetas guardan sólo referencias: cuántos elementos tienen y en cuántas pantallas se usan (una sola consulta).
    supabase.rpc("get_signage_folders")
  ]);
  const branches: ArtworkBranchOption[] = (branchesResult.data ?? []).map((branch) => ({ id: branch.id, name: branch.name, active: branch.active }));
  const folders = foldersResult.error ? [] : parseFolders(foldersResult.data);
  const error = branchesResult.error;
  const folderParam = typeof params.folder === "string" ? params.folder : null;

  return <main className="mx-auto max-w-7xl p-5 sm:p-8">
    <div><p className="text-sm text-stone-500">Inicio / Productos</p><h1 className="mt-1 text-3xl font-black tracking-tight">Productos</h1><p className="mt-2 text-stone-600">Catálogo y precios vigentes.</p></div>
    <SectionTabs active="/admin/products/artwork" tabs={PRODUCTOS_TABS} />
    <SignageSubnav active="pieces" />
    <div className="mt-6">
      <h2 className="text-xl font-black">Gráficas para redes y WhatsApp</h2>
      <p className="mt-1 text-sm text-stone-600">Las promociones se cargan una sola vez en Promociones: de ahí salen las gráficas de Instagram, las Stories y la pantalla de TV, siempre con el precio de hoy.</p>
    </div>
    {error ? <p className="mt-5 rounded-lg bg-red-50 p-4 text-red-800">{error.message}</p> : null}
    {foldersResult.error ? <p className="mt-5 rounded-lg bg-amber-50 p-4 text-amber-900">No se pudieron leer las carpetas ({foldersResult.error.message}). Las piezas individuales siguen funcionando.</p> : null}
    <ArtworkHome branches={branches} defaultBranchId={pickDefaultBranch(branches)} folders={folders} initialFolderId={folderParam} />
  </main>;
}
